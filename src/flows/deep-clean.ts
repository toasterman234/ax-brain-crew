import { flow } from '@ax-llm/ax';
import { stringify as stringifyYaml } from 'yaml';
import { trace, type Tracer } from '@opentelemetry/api';
import { createModelClient } from '../ai/clients.js';
import { vaultList } from '../tools/vault-list.js';
import { vaultRead } from '../tools/vault-read.js';
import { vaultWrite } from '../tools/vault-write.js';
import { vaultMove } from '../tools/vault-move.js';
import { vaultUpdateFrontmatter } from '../tools/vault-frontmatter.js';
import { scanVault, type ScanIssue } from '../tools/vault-scan.js';
import { getLogger } from '../observability/logger.js';
import { registerFlow } from './registry.js';

// ---------------------------------------------------------------------------
// E1 — deep-clean as an ax-native flow() (proof of the ax-native rebuild)
//
// Pipeline (from crew/skills/deep-clean.md), modeled as typed flow nodes:
//
//   readAudit (.map, deterministic I/O)  — find + read latest vault-audit report
//     .branch(auditExists)               — SELF-SUFFICIENCY: run a DETERMINISTIC
//                                           scan (vault-scan.ts, no LLM) if none
//        when(false) → runScan (.map, sync) — mechanical findings, ~instant
//     .merge()
//     .branch(fixesFromScan present)     — skip the LLM classifier when the scan
//                                           already produced structured fixes
//        when(false) → classifyNotes (ax() node) — LLM classifies a PRE-EXISTING,
//                       possibly free-form report (e.g. a human/agent-written one)
//     .merge()
//   applyFixes (.map, deterministic)     — execute each Fix via the vault tools directly
//   writeReport (.map, deterministic I/O)  — write Meta/health-reports/deep-clean-<date>.md
//   .returns(...)                          — typed Out
//
// Why the scan replaces the inline LLM audit: broken links, missing frontmatter,
// and stale/orphan notes are MECHANICAL checks — no judgment needed. Running an
// LLM to crawl the whole vault for these timed out (~10s/round x many rounds on
// DeepSeek) and left deep-clean unable to complete. The scan runs in milliseconds
// and can't time out or confabulate. The LLM classifier is kept for the one case
// that still needs it: interpreting a PRE-EXISTING, non-scan-format audit report
// (e.g. one a human wrote, or the LLM-driven vault-audit skill produced).
//
// dryRun is threaded into every write point (applyFix's vaultMove/Write/
// UpdateFrontmatter calls, the vault-audit report write, and the cleanup
// report write) via the SAME dryRun flag carried in flow state — there is no
// second, divergent dry-run path. A dry-run flow plans and writes NOTHING.
// No agent runs in this flow at all (Design A, 2026-07-20) — see the
// "Deterministic apply" comment block below for why.
//
// Tracing: forward() is given an OpenTelemetry tracer so each node emits a span.
// The dispatcher additionally wraps the whole flow in its existing Langfuse
// span (see runDeepCleanFlow call site in the dispatcher), so both the crew's
// Langfuse trace and ax's per-node spans are produced.
// ---------------------------------------------------------------------------

// NOTE: ax v23 infers the flow's input signature from the state fields read by
// `.execute()` node mappings, and its signature validator REJECTS generic field
// names (`request`, `input`, `data`, ...) — the same validator the executor hit
// in Phase A. So the flow's input fields use descriptive names (userRequest,
// dryRunMode, sessionRunId); the public runDeepCleanFlow(args) keeps the
// friendlier { request, dryRun, runId } shape and maps at the boundary.
export interface DeepCleanInput extends Record<string, any> {
  /** The user's original request text, forwarded to the agent nodes. */
  userRequest: string;
  /** When true, no writes happen — plan only. Threaded to agents + report write. */
  dryRunMode: boolean;
  /** The dispatcher's runId, threaded to agents as sessionId for RLM isolation. */
  sessionRunId?: string;
}

export interface DeepCleanOutput extends Record<string, unknown> {
  /** True when the self-sufficiency branch had to run an audit inline. */
  ranAuditInline: boolean;
  /** Path of the audit report used (existing or freshly produced). */
  auditReportPath: string | null;
  /** The notes the classifier flagged as needing fixes. */
  notesToFix: string[];
  /** Path of the cleanup report (dry_run preview path when dryRun). */
  reportPath: string;
  /** Whether the report write was a real write or a dry-run preview. */
  reportWritten: boolean;
  /** Human-readable plan/summary (the fixer agent's response). */
  response: string;
  /** Warnings accumulated across the flow. */
  warnings: string[];
}

const HEALTH_REPORTS_DIR = 'Meta/health-reports';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Find the most recent vault-audit-*.md report in Meta/health-reports/, or null.
 * Deterministic I/O — reuses the existing vault tool handlers (no reinvented I/O).
 */
function findLatestAuditReport(): { path: string; content: string } | null {
  let items: ReturnType<typeof vaultList>['items'];
  try {
    items = vaultList({ directory: HEALTH_REPORTS_DIR }).items;
  } catch {
    // Directory may not exist yet — treat as "no audit".
    return null;
  }
  const audits = items
    .filter(
      (i) =>
        i.type === 'file' &&
        i.name.startsWith('vault-audit-') &&
        i.name.endsWith('.md'),
    )
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const latest = audits[0];
  if (!latest) return null;
  try {
    return { path: latest.path, content: vaultRead({ path: latest.path }).content };
  } catch {
    return null;
  }
}

/**
 * Convert a deterministic ScanIssue (from vault-scan.ts) directly into a Fix
 * (see Fix below) — no LLM involved. missing_frontmatter gets a conservative
 * default fill-in; broken_link is flagged for review by default (auto-removing
 * a link is a content change we don't want to guess at); stale_orphan is
 * always a flag (moving/archiving a note is a judgment call).
 */
function fixFromScanIssue(issue: ScanIssue): Fix {
  if (issue.type === 'missing_frontmatter' && issue.missingFields?.length) {
    const fields: Record<string, unknown> = {};
    for (const f of issue.missingFields) {
      if (f === 'ai-first') fields['ai-first'] = true;
      else if (f === 'tags') fields.tags = [];
      else if (f === 'date') fields.date = today();
      else if (f === 'type') fields.type = 'note';
    }
    return { type: 'frontmatter', path: issue.path, fields, issue: issue.detail };
  }
  // broken_link and stale_orphan need judgment (what to relink to / whether to
  // archive) — flag rather than guess. A future pass could resolve near-matches.
  return { type: 'flag', path: issue.path, issue: issue.detail };
}

// ---------------------------------------------------------------------------
// Deterministic apply (Design A, 2026-07-20). The classifier (LLM) decides WHAT
// to fix and emits a structured Fix per problem; the flow EXECUTES each fix by
// calling the vault tool directly — no agent improvising tool calls. This
// sidesteps (a) DeepSeek's weak prompt-mode tool calling on the fast tier, which
// confabulated "no tools", and (b) the "no single agent has move+write+
// frontmatter" constraint. Every write honors dryRun. This is the ax-native
// pattern E2 should copy for other write-heavy skills.
// ---------------------------------------------------------------------------
interface Fix {
  /** What kind of fix. Unknown/absent types are treated as 'flag' (no write). */
  type: 'move' | 'frontmatter' | 'fix_link' | 'flag';
  /** The note this fix targets (vault-relative path). */
  path: string;
  /** move: destination path. */
  destination?: string;
  /** frontmatter: fields to set/merge. */
  fields?: Record<string, unknown>;
  /** fix_link: the broken [[link]] target text (without brackets). */
  brokenLink?: string;
  /** fix_link: replacement target, or null/absent to remove the link (keep text). */
  replacement?: string | null;
  /** Human-readable description of the problem. */
  issue?: string;
}

interface AppliedFix {
  path: string;
  type: string;
  operation: string; // moved | updated | created | dry_run | flagged | skipped | error
  detail: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Execute ONE structured fix via the vault tools. Never throws — records errors. */
function applyFix(fix: Fix, dryRun: boolean): AppliedFix {
  const base = { path: fix.path, type: fix.type };
  try {
    switch (fix.type) {
      case 'move': {
        if (!fix.destination)
          return { ...base, operation: 'skipped', detail: 'move fix had no destination' };
        const r = vaultMove({ source: fix.path, destination: fix.destination, dryRun });
        return { ...base, operation: r.operation, detail: `→ ${fix.destination}${r.reason ? ` (${r.reason})` : ''}` };
      }
      case 'frontmatter': {
        if (!fix.fields || Object.keys(fix.fields).length === 0)
          return { ...base, operation: 'skipped', detail: 'frontmatter fix had no fields' };
        const r = vaultUpdateFrontmatter({ path: fix.path, fields: fix.fields, dryRun });
        // vault.updateFrontmatter only UPDATES an existing frontmatter block — it
        // errors on notes with none at all (common for loose Daily/Inbox notes).
        // Fall back to CREATING a block by prepending it via vaultWrite.
        if (r.operation === 'error' && /no frontmatter/i.test(r.reason ?? '')) {
          const { content } = vaultRead({ path: fix.path });
          const newContent = `---\n${stringifyYaml(fix.fields)}\n---\n\n${content}`;
          const w = vaultWrite({ path: fix.path, content: newContent, overwrite: true, dryRun });
          return {
            ...base,
            operation: w.operation,
            detail: `created frontmatter block: ${Object.keys(fix.fields).join(', ')}`,
          };
        }
        return { ...base, operation: r.operation, detail: `set ${Object.keys(fix.fields).join(', ')}` };
      }
      case 'fix_link': {
        if (!fix.brokenLink)
          return { ...base, operation: 'skipped', detail: 'fix_link had no brokenLink' };
        const { content } = vaultRead({ path: fix.path });
        const re = new RegExp(`\\[\\[${escapeRegExp(fix.brokenLink)}(\\|[^\\]]*)?\\]\\]`, 'g');
        if (!re.test(content))
          return { ...base, operation: 'skipped', detail: `broken link [[${fix.brokenLink}]] not found in note` };
        const newContent = fix.replacement
          ? content.replace(re, `[[${fix.replacement}]]`)
          : content.replace(re, (_m, alias) => (alias ? String(alias).slice(1) : fix.brokenLink!));
        const w = vaultWrite({ path: fix.path, content: newContent, overwrite: true, dryRun });
        return {
          ...base,
          operation: w.operation,
          detail: fix.replacement ? `[[${fix.brokenLink}]] → [[${fix.replacement}]]` : `removed broken link [[${fix.brokenLink}]]`,
        };
      }
      default:
        return { ...base, type: 'flag', operation: 'flagged', detail: fix.issue ?? 'flagged for review (no automatic fix)' };
    }
  } catch (err) {
    return { ...base, operation: 'error', detail: String(err) };
  }
}

/** Coerce the classifier's json[] output into a clean Fix[] (defensive). */
function coerceFixes(raw: unknown): Fix[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => ({
      type: (['move', 'frontmatter', 'fix_link'].includes(String(f.type)) ? f.type : 'flag') as Fix['type'],
      path: String(f.path ?? ''),
      destination: f.destination != null ? String(f.destination) : undefined,
      fields: f.fields && typeof f.fields === 'object' ? (f.fields as Record<string, unknown>) : undefined,
      brokenLink: f.brokenLink != null ? String(f.brokenLink) : undefined,
      replacement: f.replacement === null ? null : f.replacement != null ? String(f.replacement) : undefined,
      issue: f.issue != null ? String(f.issue) : undefined,
    }))
    .filter((f) => f.path.length > 0);
}

/**
 * Build the deep-clean flow. Typed flow<In, Out>(). Nodes are defined before
 * they are executed (ax requirement). The classifier is a native ax() signature
 * node; the audit + fixer steps are documented `.map(async () =>
 * agent.forward())` agent nodes via runAgentNode/executeAgent.
 */
export function buildDeepCleanFlow() {
  return (
    flow<DeepCleanInput, DeepCleanOutput>()
      // Native ax() classifier node — typed notesToFix list out of the audit text.
      .node(
        'classifyNotes',
        'auditReport:string, userRequest:string -> fixes:json[] "each fix: {type: one of move|frontmatter|fix_link|flag, path: the note path, destination?: target path for move, fields?: object of frontmatter fields to set, brokenLink?: the broken [[link]] target for fix_link, replacement?: new target or null to remove, issue?: short description}", cleanupSummary:string',
      )

      // 1) Read latest audit (deterministic I/O, reuses vault tools).
      .map((state) => {
        const found = findLatestAuditReport();
        return {
          ...state,
          auditExists: found !== null,
          auditReportPath: found?.path ?? null,
          auditReportContent: found?.content ?? '',
          ranAuditInline: false,
          warnings: [] as string[],
        };
      })

      // 2) SELF-SUFFICIENCY: if no audit report exists, run a DETERMINISTIC scan
      //    (no LLM — mechanical checks don't need one, and the old inline LLM
      //    audit here is exactly what timed out). This is the fix for the gap
      //    that made "deep clean my vault" fail AND for the timeout that
      //    followed once self-sufficiency started firing.
      .branch((state) => state.auditExists)
        .when(false)
          .map((state) => {
            const scan = scanVault();
            const fixes = scan.issues.map(fixFromScanIssue);
            // Persist the scan as a real vault-audit report (dryRun → preview
            // only), so a subsequent deep-clean run and E2's vault-audit flow
            // both see it and skip re-scanning.
            const reportPath = `${HEALTH_REPORTS_DIR}/vault-audit-${today()}.md`;
            const write = vaultWrite({
              path: reportPath,
              content: scan.reportMarkdown,
              overwrite: true,
              dryRun: state.dryRunMode,
            });
            return {
              ...state,
              ranAuditInline: true,
              auditReportPath: write.path,
              auditReportContent: scan.reportMarkdown,
              fixesFromScan: fixes,
              warnings: [
                ...state.warnings,
                `No prior vault-audit report found — ran a deterministic scan (${scan.totalNotes} notes, ${scan.issues.length} issue(s), no LLM).`,
              ],
            };
          })
        .when(true)
          .map((state) => ({ ...state, fixesFromScan: null as Fix[] | null }))
      .merge()

      // 3) Classify — SKIPPED when the scan already produced structured fixes.
      //    Only runs the LLM when a PRE-EXISTING, possibly free-form report was
      //    found (e.g. human-written, or from the LLM-driven vault-audit skill),
      //    since that text isn't already in Fix[] shape.
      .branch((state) => state.fixesFromScan !== null)
        .when(true)
          .map((state) => ({
            ...state,
            fixes: state.fixesFromScan as Fix[],
            cleanupSummary: `Deterministic scan: ${(state.fixesFromScan as Fix[]).length} issue(s) found.`,
          }))
        .when(false)
          .execute('classifyNotes', (state) => ({
            auditReport: state.auditReportContent || '(no audit content available)',
            userRequest: state.userRequest,
          }))
          .map((state) => ({
            ...state,
            fixes: coerceFixes(state.classifyNotesResult?.fixes),
            cleanupSummary: state.classifyNotesResult?.cleanupSummary ?? '',
          }))
      .merge()

      // 4) Apply fixes DETERMINISTICALLY (Design A) — no agent, either path.
      //    Each structured Fix (from the scan or from the LLM classifier) is
      //    executed by calling the vault tool directly, honoring dryRun. Per-fix
      //    try/catch (applyFix never throws) so one bad fix can't reject the
      //    whole flow (flows have no per-node error handling).
      .map((state) => {
        const fixes = state.fixes as Fix[];
        const applied = fixes.map((f) => applyFix(f, state.dryRunMode));
        const notesToFix = fixes.map(
          (f) => `${f.type}: ${f.path}${f.issue ? ` — ${f.issue}` : ''}`,
        );
        const summary = state.cleanupSummary ?? '';
        const lines = applied.length
          ? applied.map((a) => `- [${a.operation}] ${a.type} ${a.path} — ${a.detail}`).join('\n')
          : '- (no fixes proposed)';
        const verb = state.dryRunMode ? 'Would apply' : 'Applied';
        const fixResponse =
          `${summary}\n\n## ${verb} ${applied.length} fix(es)\n${lines}`;
        const errorWarnings = applied
          .filter((a) => a.operation === 'error')
          .map((a) => `Fix error on ${a.path}: ${a.detail}`);
        return {
          ...state,
          notesToFix,
          appliedFixes: applied,
          fixResponse,
          warnings: [...state.warnings, ...errorWarnings],
        };
      })

      // 5) Write cleanup report (deterministic I/O; dryRun → preview only).
      .map((state) => {
        const reportPath = `${HEALTH_REPORTS_DIR}/deep-clean-${today()}.md`;
        const body =
          `---\n` +
          `date: ${today()}\n` +
          `type: reference\n` +
          `tags:\n  - system\n  - vault-health\n` +
          `ai-first: true\n` +
          `---\n\n` +
          `# Deep Clean — ${today()}\n\n` +
          `## Audit source\n${state.auditReportPath ?? '(ran inline; no report file)'}\n\n` +
          `## Notes flagged\n` +
          (state.notesToFix.length
            ? state.notesToFix.map((n) => `- ${n}`).join('\n')
            : '- (none)') +
          `\n\n## Plan / changes\n${state.fixResponse}\n`;
        const write = vaultWrite({
          path: reportPath,
          content: body,
          overwrite: true,
          dryRun: state.dryRunMode,
        });
        return {
          ...state,
          reportPath: write.path,
          reportWritten: write.operation === 'created',
        };
      })

      .returns((state) => ({
        ranAuditInline: state.ranAuditInline,
        auditReportPath: state.auditReportPath,
        notesToFix: state.notesToFix,
        reportPath: state.reportPath,
        reportWritten: state.reportWritten,
        response: state.fixResponse,
        warnings: state.warnings,
      }))
  );
}

export interface RunDeepCleanFlowResult {
  output: DeepCleanOutput;
  /** Convenience: the human-facing plan/summary text. */
  finalResponse: string;
}

/**
 * Run the deep-clean flow. Builds the flow, gets the fast-tier client (openai
 * transport + per-model functionCallMode via the capability map, exactly like
 * the rest of the crew), and passes an OpenTelemetry tracer so each node emits
 * a span. dryRun is threaded into the flow input (and thus the agent nodes and
 * report write).
 */
export async function runDeepCleanFlow(args: {
  request: string;
  dryRun: boolean;
  runId?: string;
  tracer?: Tracer;
}): Promise<RunDeepCleanFlowResult> {
  const logger = getLogger();
  const wf = buildDeepCleanFlow();
  const llm = createModelClient('fast');
  const tracer = args.tracer ?? trace.getTracer('ax-brain-crew.deep-clean');

  logger.info({ runId: args.runId, dryRun: args.dryRun }, 'deep-clean flow started');

  const output = (await wf.forward(
    llm,
    {
      userRequest: args.request,
      dryRunMode: args.dryRun,
      sessionRunId: args.runId,
    },
    { tracer },
  )) as DeepCleanOutput;

  logger.info(
    {
      runId: args.runId,
      ranAuditInline: output.ranAuditInline,
      notesToFix: output.notesToFix.length,
      reportWritten: output.reportWritten,
    },
    'deep-clean flow completed',
  );

  const dryNote = args.dryRun
    ? `\n\n---\n**Approval required.** "Deep Clean" makes changes to your vault, so ` +
      `this was a plan only — nothing was written (report path preview: ` +
      `${output.reportPath}). Reply "proceed" (or "yes, go ahead") to run it for real.`
    : '';

  return {
    output,
    finalResponse: `${output.response}${dryNote}`,
  };
}

registerFlow({
  id: 'deep-clean',
  name: 'Deep Clean',
  description: 'Extended vault cleanup. Fixes broken links, archives stale notes, repairs frontmatter, consolidates tags.',
  triggers: ['deep clean', 'deep clean my vault', 'cleanup vault', 'fix broken links', 'repair my vault'],
  approvalRequired: true,
  sourceFile: 'src/flows/deep-clean.ts',
  run: async (args) => runDeepCleanFlow({ request: args.request, dryRun: args.dryRun ?? false, runId: args.runId }),
});
