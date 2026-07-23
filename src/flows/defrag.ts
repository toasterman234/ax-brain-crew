import { flow } from '@ax-llm/ax';
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
// E2 — defrag as an ax-native flow(). Weekly maintenance, composing the
// mechanical checks the other E1/E2 flows already implement, per
// crew/skills/defrag.md's 5 phases:
//
//   Phase 1 Inbox Sweep    — deterministic listing (.map) of Inbox/, ages of
//                             each file; WHERE to file something is a
//                             judgment call → the LLM node
//   Phase 2 Link Audit     — reuses scanVault()'s stale_orphan detection
//                             (mechanical); what to LINK an orphan to is a
//                             judgment call → the same LLM node
//   Phase 3 Structure Check— deterministic (.map): every folder either has an
//                             _index.md/README or doesn't; NO judgment needed,
//                             so this is pure .map(), no LLM at all
//   Phase 4 Staleness Review— reuses scanVault() (mechanical, matches the
//                             skill's "30+ days" with the shared scan's
//                             90-day default noted in the report as a caveat)
//   Phase 5 Report          — Meta/health-reports/defrag-<date>.md
//
// Design A (deterministic apply only) throughout: the LLM node emits a typed
// plan (inbox destinations + orphan links); the flow EXECUTES it via
// vaultMove/vaultWrite/vaultUpdateFrontmatter directly in .map() steps. No
// agent ever calls a tool in this flow. dryRun is threaded to every write.
//
// Per the skill's Rule 2 ("Never modify Daily/ or raw/"), those directories
// are excluded from every write-eligible step below.
// ---------------------------------------------------------------------------

export interface DefragInput extends Record<string, any> {
  userRequest: string;
  dryRunMode: boolean;
  sessionRunId?: string;
}

interface InboxPlanItem {
  path: string;
  destination: string;
  reason?: string;
}

interface OrphanLinkPlanItem {
  path: string;
  linkTarget?: string | null;
  reason?: string;
}

export interface DefragOutput extends Record<string, unknown> {
  inboxMoved: number;
  inboxRemaining: number;
  orphansLinked: number;
  orphansRemaining: number;
  indexesCreated: number;
  staleFlagged: number;
  reportPath: string;
  reportWritten: boolean;
  response: string;
  warnings: string[];
}

const HEALTH_REPORTS_DIR = 'Meta/health-reports';
const PROTECTED_DIRS = ['Daily', 'raw'];
const STALENESS_DAYS = 30;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isProtected(path: string): boolean {
  return PROTECTED_DIRS.some((d) => path === d || path.startsWith(`${d}/`));
}

function coerceInboxPlan(raw: unknown): InboxPlanItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      path: String(r.path ?? ''),
      destination: String(r.destination ?? ''),
      reason: r.reason != null ? String(r.reason) : undefined,
    }))
    .filter((r) => r.path.length > 0 && r.destination.length > 0);
}

function coerceOrphanPlan(raw: unknown): OrphanLinkPlanItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      path: String(r.path ?? ''),
      linkTarget: r.linkTarget === null ? null : r.linkTarget != null ? String(r.linkTarget) : undefined,
      reason: r.reason != null ? String(r.reason) : undefined,
    }))
    .filter((r) => r.path.length > 0);
}

/** List Inbox/ files with age in days. Deterministic, no LLM. */
function listInboxFiles(): { path: string; ageDays: number }[] {
  let items;
  try {
    items = vaultList({ directory: 'Inbox' }).items;
  } catch {
    return [];
  }
  const now = Date.now();
  return items
    .filter((i) => i.type === 'file' && i.name.endsWith('.md'))
    .map((i) => ({
      path: i.path,
      ageDays: Math.floor((now - new Date(i.modifiedAt).getTime()) / (24 * 60 * 60 * 1000)),
    }));
}

/** Phase 3: every folder needs an _index.md or README — pure .map(), no LLM. */
function findMissingIndexes(): { folder: string }[] {
  const missing: { folder: string }[] = [];
  const walk = (dir: string) => {
    let items;
    try {
      items = vaultList({ directory: dir }).items;
    } catch {
      return;
    }
    const relDir = dir === '.' ? '' : dir;
    if (relDir && !isProtected(relDir)) {
      const hasIndex = items.some(
        (i) =>
          i.type === 'file' &&
          (i.name.toLowerCase() === '_index.md' || i.name.toLowerCase() === 'readme.md'),
      );
      if (!hasIndex) missing.push({ folder: relDir });
    }
    for (const item of items) {
      if (item.type === 'directory' && !isProtected(item.path)) {
        walk(item.path);
      }
    }
  };
  walk('.');
  return missing;
}

/** Apply one inbox move (Design A — deterministic, no agent). */
function applyInboxMove(item: InboxPlanItem, dryRun: boolean): { path: string; operation: string; detail: string } {
  if (isProtected(item.path) || isProtected(item.destination)) {
    return { path: item.path, operation: 'skipped', detail: 'protected directory (Daily/raw)' };
  }
  try {
    const r = vaultMove({ source: item.path, destination: item.destination, dryRun });
    return { path: item.path, operation: r.operation, detail: `→ ${item.destination}${r.reason ? ` (${r.reason})` : ''}` };
  } catch (err) {
    return { path: item.path, operation: 'error', detail: String(err) };
  }
}

/** Apply one orphan-link fix: add a wikilink, or flag as an orphan (Design A). */
function applyOrphanLink(
  item: OrphanLinkPlanItem,
  dryRun: boolean,
): { path: string; operation: string; detail: string } {
  if (isProtected(item.path)) {
    return { path: item.path, operation: 'skipped', detail: 'protected directory (Daily/raw)' };
  }
  try {
    if (item.linkTarget) {
      const { content } = vaultRead({ path: item.path });
      const newContent = `${content.trimEnd()}\n\nSee also: [[${item.linkTarget}]]\n`;
      const w = vaultWrite({ path: item.path, content: newContent, overwrite: true, dryRun });
      return { path: item.path, operation: w.operation, detail: `linked to [[${item.linkTarget}]]` };
    }
    const r = vaultUpdateFrontmatter({ path: item.path, fields: { status: 'orphan' }, dryRun });
    if (r.operation === 'error' && /no frontmatter/i.test(r.reason ?? '')) {
      const { content } = vaultRead({ path: item.path });
      const newContent = `---\nstatus: orphan\n---\n\n${content}`;
      const w = vaultWrite({ path: item.path, content: newContent, overwrite: true, dryRun });
      return { path: item.path, operation: w.operation, detail: 'created frontmatter block: status: orphan' };
    }
    return { path: item.path, operation: r.operation, detail: 'flagged status: orphan (no related note found)' };
  } catch (err) {
    return { path: item.path, operation: 'error', detail: String(err) };
  }
}

export function buildDefragFlow() {
  return (
    flow<DefragInput, DefragOutput>()
      // Native ax() node — the judgment calls Phases 1 & 2 need: WHERE should
      // each inbox note be filed, and WHAT related note (if any) an orphan
      // should link to. Both need semantic understanding of note content.
      .node(
        'planMaintenance',
        'inboxFilesJson:string, orphanNotesJson:string, userRequest:string -> inboxPlan:json[] "each item: {path: inbox note path, destination: target vault path, reason: short explanation}. Only include notes clearly classifiable now — leave ambiguous captures out of the plan entirely", orphanLinkPlan:json[] "each item: {path: orphan note path, linkTarget: a related note path to link to (without brackets), or null if no related note was found, reason: short explanation}", maintenanceSummary:string',
      )

      // 1) Deterministic mechanical checks (no LLM): inbox listing, stale/
      //    orphan scan (reuses scanVault), missing-index folders.
      .map((state) => {
        const inboxFiles = listInboxFiles();
        const scan = scanVault();
        const orphanIssues = scan.issues.filter((i: ScanIssue) => i.type === 'stale_orphan');
        const missingIndexes = findMissingIndexes();
        return {
          ...state,
          inboxFiles,
          orphanIssues,
          missingIndexes,
          staleFlagged: orphanIssues.length,
          warnings: [] as string[],
        };
      })

      // 2) LLM plans inbox destinations + orphan links — skipped entirely when
      //    there's nothing to plan for.
      .branch((state) => state.inboxFiles.length > 0 || state.orphanIssues.length > 0)
        .when(true)
          .execute('planMaintenance', (state) => ({
            inboxFilesJson: JSON.stringify(state.inboxFiles),
            orphanNotesJson: JSON.stringify(
              (state.orphanIssues as ScanIssue[]).map((i) => ({ path: i.path, detail: i.detail })),
            ),
            userRequest: state.userRequest,
          }))
          .map((state) => ({
            ...state,
            inboxPlan: coerceInboxPlan(state.planMaintenanceResult?.inboxPlan),
            orphanLinkPlan: coerceOrphanPlan(state.planMaintenanceResult?.orphanLinkPlan),
            maintenanceSummary: state.planMaintenanceResult?.maintenanceSummary ?? '',
          }))
        .when(false)
          .map((state) => ({
            ...state,
            inboxPlan: [] as InboxPlanItem[],
            orphanLinkPlan: [] as OrphanLinkPlanItem[],
            maintenanceSummary: 'Inbox is empty and no orphan notes were found — nothing to plan.',
          }))
      .merge()

      // 3) Apply the plan DETERMINISTICALLY (Design A) — no agent, ever.
      .map((state) => {
        const inboxApplied = (state.inboxPlan as InboxPlanItem[]).map((i) =>
          applyInboxMove(i, state.dryRunMode),
        );
        const orphanApplied = (state.orphanLinkPlan as OrphanLinkPlanItem[]).map((i) =>
          applyOrphanLink(i, state.dryRunMode),
        );
        const inboxMoved = inboxApplied.filter(
          (a) => a.operation === 'moved' || a.operation === 'dry_run',
        ).length;
        const orphansLinked = orphanApplied.filter(
          (a) => a.operation === 'updated' || a.operation === 'created' || a.operation === 'dry_run',
        ).length;
        const errorWarnings = [...inboxApplied, ...orphanApplied]
          .filter((a) => a.operation === 'error')
          .map((a) => `Defrag apply error on ${a.path}: ${a.detail}`);
        return {
          ...state,
          inboxApplied,
          orphanApplied,
          inboxMoved,
          inboxRemaining: state.inboxFiles.length - inboxMoved,
          orphansLinked,
          orphansRemaining: state.orphanIssues.length - orphansLinked,
          warnings: [...state.warnings, ...errorWarnings],
        };
      })

      // 4) Write defrag report (deterministic I/O; dryRun → preview only).
      .map((state) => {
        const reportPath = `${HEALTH_REPORTS_DIR}/defrag-${today()}.md`;
        const verb = state.dryRunMode ? 'Would move' : 'Moved';
        const linkVerb = state.dryRunMode ? 'Would link/flag' : 'Linked/flagged';
        const inboxLines = (state.inboxApplied as { path: string; operation: string; detail: string }[])
          .map((a) => `- [${a.operation}] ${a.path} — ${a.detail}`)
          .join('\n');
        const orphanLines = (state.orphanApplied as { path: string; operation: string; detail: string }[])
          .map((a) => `- [${a.operation}] ${a.path} — ${a.detail}`)
          .join('\n');
        const indexLines = (state.missingIndexes as { folder: string }[])
          .map((m) => `- ${m.folder}/ (no _index.md or README)`)
          .join('\n');
        const body =
          `---\n` +
          `date: ${today()}\n` +
          `type: reference\n` +
          `tags:\n  - system\n  - vault-health\n` +
          `ai-first: true\n` +
          `---\n\n` +
          `# Defrag — ${today()}\n\n` +
          `${state.maintenanceSummary}\n\n` +
          `## Phase 1 — Inbox Sweep (${verb} ${state.inboxMoved}, ${state.inboxRemaining} remaining)\n${inboxLines || '- (inbox empty or all uncategorizable)'}\n\n` +
          `## Phase 2 — Link Audit (${linkVerb} ${state.orphansLinked}, ${state.orphansRemaining} remaining)\n${orphanLines || '- (no orphans found)'}\n\n` +
          `## Phase 3 — Structure Check (${(state.missingIndexes as unknown[]).length} folder(s) missing an index; flagged only, not auto-created — creating index content is a judgment call for a future pass)\n${indexLines || '- (every folder has an index)'}\n\n` +
          `## Phase 4 — Staleness Review (${state.staleFlagged} note(s) flagged, ${STALENESS_DAYS}+ day threshold per skill doc; underlying scan uses a 90-day default — see vault-scan.ts)\n\n` +
          `## Phase 5 — Report\nThis file.\n`;
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
          indexesCreated: 0, // never auto-creates index content (Design A: flag, don't guess content)
        };
      })

      .returns((state) => ({
        inboxMoved: state.inboxMoved,
        inboxRemaining: state.inboxRemaining,
        orphansLinked: state.orphansLinked,
        orphansRemaining: state.orphansRemaining,
        indexesCreated: state.indexesCreated,
        staleFlagged: state.staleFlagged,
        reportPath: state.reportPath,
        reportWritten: state.reportWritten,
        response: `${state.maintenanceSummary}\n\nInbox: ${state.inboxMoved} moved, ${state.inboxRemaining} remaining. Orphans: ${state.orphansLinked} linked/flagged, ${state.orphansRemaining} remaining. ${(state.missingIndexes as unknown[]).length} folder(s) missing an index (flagged only).`,
        warnings: state.warnings,
      }))
  );
}

export interface RunDefragFlowResult {
  output: DefragOutput;
  finalResponse: string;
}

export async function runDefragFlow(args: {
  request: string;
  dryRun: boolean;
  runId?: string;
  tracer?: Tracer;
}): Promise<RunDefragFlowResult> {
  const logger = getLogger();
  const wf = buildDefragFlow();
  const llm = createModelClient('fast');
  const tracer = args.tracer ?? trace.getTracer('ax-brain-crew.defrag');

  logger.info({ runId: args.runId, dryRun: args.dryRun }, 'defrag flow started');

  const output = (await wf.forward(
    llm,
    {
      userRequest: args.request,
      dryRunMode: args.dryRun,
      sessionRunId: args.runId,
    },
    { tracer },
  )) as DefragOutput;

  logger.info(
    {
      runId: args.runId,
      inboxMoved: output.inboxMoved,
      orphansLinked: output.orphansLinked,
      reportWritten: output.reportWritten,
    },
    'defrag flow completed',
  );

  const dryNote = args.dryRun
    ? `\n\n---\n**Approval required.** "Defrag" makes changes to your vault, so ` +
      `this was a plan only — nothing was written (report path preview: ` +
      `${output.reportPath}). Reply "proceed" (or "yes, go ahead") to run it for real.`
    : '';

  return {
    output,
    finalResponse: `${output.response}${dryNote}`,
  };
}

registerFlow({
  id: 'defrag',
  name: 'Weekly Defragmentation',
  description: 'Weekly 5-phase maintenance: inbox sweep, link audit, structure check, staleness review, and health report.',
  triggers: ['defrag my vault', 'defrag', 'weekly maintenance', 'run maintenance', 'defragment'],
  approvalRequired: true,
  sourceFile: 'src/flows/defrag.ts',
  run: async (args) => runDefragFlow({ request: args.request, dryRun: args.dryRun ?? false, runId: args.runId }),
});
