import { flow } from '@ax-llm/ax';
import { trace, type Tracer } from '@opentelemetry/api';
import { createModelClient } from '../ai/clients.js';
import { vaultWrite } from '../tools/vault-write.js';
import { vaultUpdateFrontmatter } from '../tools/vault-frontmatter.js';
import { scanTags, type TagUsage } from '../tools/tag-scan.js';
import { getLogger } from '../observability/logger.js';
import { registerFlow } from './registry.js';

// ---------------------------------------------------------------------------
// E2 — tag-garden as an ax-native flow(). Same shape as deep-clean/vault-audit:
//
//   scanTags (.map, deterministic, no LLM)   — frequency counts, orphans,
//                                               near-duplicate groups (case/
//                                               separator/plural), over-tagged
//                                               notes (all mechanical — see
//                                               src/tools/tag-scan.ts)
//   proposeRenames (ax() node)               — the genuine judgment call:
//                                               WHICH near-duplicates to merge
//                                               and what the canonical form
//                                               should be (tag-scan.ts only
//                                               suggests the most-used variant
//                                               as a default; the LLM can
//                                               override with a better name,
//                                               e.g. hierarchy-prefixed)
//   applyRenames (.map, deterministic apply) — Design A: the LLM's typed plan
//                                               is EXECUTED deterministically
//                                               via vaultUpdateFrontmatter in a
//                                               .map() — no agent ever calls a
//                                               tool itself
//   writeReport (.map, deterministic I/O)    — Meta/health-reports/tag-garden-<date>.md
//   .returns(...)
// ---------------------------------------------------------------------------

export interface TagGardenInput extends Record<string, any> {
  userRequest: string;
  dryRunMode: boolean;
  sessionRunId?: string;
}

export interface TagRename {
  /** All raw tag variants being merged (must include the canonical form itself). */
  fromTags: string[];
  toTag: string;
  reason?: string;
}

interface AppliedRename {
  path: string;
  before: string[];
  after: string[];
  operation: string;
}

export interface TagGardenOutput extends Record<string, unknown> {
  totalUniqueTags: number;
  orphanTagCount: number;
  nearDuplicateGroupCount: number;
  proposedRenames: TagRename[];
  notesUpdated: number;
  reportPath: string;
  reportWritten: boolean;
  response: string;
  warnings: string[];
}

const HEALTH_REPORTS_DIR = 'Meta/health-reports';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Coerce the LLM's json[] rename plan into clean TagRename[] (defensive). */
function coerceRenames(raw: unknown): TagRename[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      fromTags: Array.isArray(r.fromTags) ? r.fromTags.map((t) => String(t)) : [],
      toTag: String(r.toTag ?? ''),
      reason: r.reason != null ? String(r.reason) : undefined,
    }))
    .filter((r) => r.fromTags.length > 0 && r.toTag.length > 0);
}

/**
 * Apply one rename plan across every affected note (Design A — deterministic
 * apply only, no agent). For each note whose tags intersect fromTags, replace
 * those tags with toTag (deduped) via vaultUpdateFrontmatter, honoring dryRun.
 */
function applyRename(
  rename: TagRename,
  usageByTag: Map<string, TagUsage>,
  dryRun: boolean,
): AppliedRename[] {
  const fromSet = new Set(rename.fromTags);
  const affectedPaths = new Set<string>();
  for (const from of rename.fromTags) {
    for (const p of usageByTag.get(from)?.paths ?? []) affectedPaths.add(p);
  }

  const results: AppliedRename[] = [];
  for (const path of affectedPaths) {
    try {
      const before = [...usageByTag.values()]
        .filter((u) => u.paths.includes(path) && fromSet.has(u.tag))
        .map((u) => u.tag);
      // Rebuild the note's full tag list: every tag it currently has, with
      // fromTags replaced by toTag (deduped), preserving other tags untouched.
      const allTagsOnNote = [...usageByTag.values()]
        .filter((u) => u.paths.includes(path))
        .map((u) => u.tag);
      const after = [
        ...new Set(
          allTagsOnNote.map((t) => (fromSet.has(t) ? rename.toTag : t)),
        ),
      ];
      // Skip no-ops: a note already carrying only the canonical form is swept
      // into affectedPaths (fromTags includes the canonical tag itself), but its
      // tag set is unchanged. Don't write, list, or count it as an update.
      const currentSet = new Set(allTagsOnNote);
      const unchanged =
        currentSet.size === after.length && after.every((t) => currentSet.has(t));
      if (unchanged) continue;
      const r = vaultUpdateFrontmatter({ path, fields: { tags: after }, dryRun });
      results.push({
        path,
        before,
        after,
        operation: r.operation,
      });
    } catch (err) {
      results.push({ path, before: [], after: [], operation: `error: ${String(err)}` });
    }
  }
  return results;
}

export function buildTagGardenFlow() {
  return (
    flow<TagGardenInput, TagGardenOutput>()
      // Native ax() node — the judgment call: which near-duplicate groups are
      // genuinely the same tag, and what the canonical form should be. Given
      // the mechanical scan's own default suggestion, the LLM can confirm or
      // override it (e.g. prefer a hierarchy-prefixed form).
      .node(
        'proposeRenames',
        'nearDuplicateGroupsJson:string, orphanTagsJson:string, userRequest:string -> renamePlan:json[] "each rename: {fromTags: array of raw tag strings being merged (must include every variant), toTag: the canonical replacement tag, reason: short explanation}", canonicalizationSummary:string',
      )

      // 1) Deterministic scan (no LLM).
      .map((state) => {
        const scan = scanTags();
        return {
          ...state,
          totalUniqueTags: scan.totalUniqueTags,
          orphanTags: scan.orphanTags,
          nearDuplicateGroups: scan.nearDuplicateGroups,
          usage: scan.usage,
          overTagged: scan.overTagged,
          warnings: [] as string[],
        };
      })

      // 2) LLM proposes canonicalization — skipped when there's nothing to merge.
      .branch((state) => state.nearDuplicateGroups.length > 0)
        .when(true)
          .execute('proposeRenames', (state) => ({
            nearDuplicateGroupsJson: JSON.stringify(state.nearDuplicateGroups),
            orphanTagsJson: JSON.stringify(state.orphanTags),
            userRequest: state.userRequest,
          }))
          .map((state) => ({
            ...state,
            proposedRenames: coerceRenames(state.proposeRenamesResult?.renamePlan),
            canonicalizationSummary: state.proposeRenamesResult?.canonicalizationSummary ?? '',
          }))
        .when(false)
          .map((state) => ({
            ...state,
            proposedRenames: [] as TagRename[],
            canonicalizationSummary: 'No near-duplicate tag groups found — nothing to canonicalize.',
          }))
      .merge()

      // 3) Apply renames DETERMINISTICALLY (Design A) — no agent, ever. Each
      //    rename in the LLM's typed plan is executed via vaultUpdateFrontmatter
      //    directly, honoring dryRun.
      .map((state) => {
        const usageByTag = new Map<string, TagUsage>(
          (state.usage as TagUsage[]).map((u) => [u.tag, u]),
        );
        const renames = state.proposedRenames as TagRename[];
        const applied = renames.flatMap((r) => applyRename(r, usageByTag, state.dryRunMode));
        const notesUpdated = applied.filter(
          (a) => a.operation === 'updated' || a.operation === 'dry_run',
        ).length;
        const errorWarnings = applied
          .filter((a) => a.operation.startsWith('error'))
          .map((a) => `Rename error on ${a.path}: ${a.operation}`);
        const verb = state.dryRunMode ? 'Would update' : 'Updated';
        const lines = applied.length
          ? applied
              .map((a) => `- [${a.operation}] ${a.path}: ${a.before.join(', ')} → ${a.after.join(', ')}`)
              .join('\n')
          : '- (no renames proposed)';
        return {
          ...state,
          notesUpdated,
          applyLines: `## ${verb} ${applied.length} note(s)\n${lines}`,
          warnings: [...state.warnings, ...errorWarnings],
        };
      })

      // 4) Write tag-garden report (deterministic I/O; dryRun → preview only).
      .map((state) => {
        const reportPath = `${HEALTH_REPORTS_DIR}/tag-garden-${today()}.md`;
        const usage = state.usage as TagUsage[];
        const overTagged = state.overTagged as { path: string; count: number }[];
        const body =
          `---\n` +
          `date: ${today()}\n` +
          `type: reference\n` +
          `tags:\n  - system\n  - vault-health\n` +
          `ai-first: true\n` +
          `---\n\n` +
          `# Tag Garden — ${today()}\n\n` +
          `Total unique tags: ${state.totalUniqueTags}\n` +
          `Orphan tags (used once): ${(state.orphanTags as string[]).length}\n` +
          `Near-duplicate groups: ${(state.nearDuplicateGroups as unknown[]).length}\n` +
          `Over-tagged notes (>5 tags): ${overTagged.length}\n\n` +
          `## Frequency (top 20)\n` +
          usage
            .slice(0, 20)
            .map((u) => `- ${u.tag} (${u.count})`)
            .join('\n') +
          `\n\n## Canonicalization\n${state.canonicalizationSummary}\n\n${state.applyLines}\n`;
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
        totalUniqueTags: state.totalUniqueTags,
        orphanTagCount: (state.orphanTags as string[]).length,
        nearDuplicateGroupCount: (state.nearDuplicateGroups as unknown[]).length,
        proposedRenames: state.proposedRenames,
        notesUpdated: state.notesUpdated,
        reportPath: state.reportPath,
        reportWritten: state.reportWritten,
        response: `${state.canonicalizationSummary}\n\n${state.applyLines}`,
        warnings: state.warnings,
      }))
  );
}

export interface RunTagGardenFlowResult {
  output: TagGardenOutput;
  finalResponse: string;
}

export async function runTagGardenFlow(args: {
  request: string;
  dryRun: boolean;
  runId?: string;
  tracer?: Tracer;
}): Promise<RunTagGardenFlowResult> {
  const logger = getLogger();
  const wf = buildTagGardenFlow();
  const llm = createModelClient('fast');
  const tracer = args.tracer ?? trace.getTracer('ax-brain-crew.tag-garden');

  logger.info({ runId: args.runId, dryRun: args.dryRun }, 'tag-garden flow started');

  const output = (await wf.forward(
    llm,
    {
      userRequest: args.request,
      dryRunMode: args.dryRun,
      sessionRunId: args.runId,
    },
    { tracer },
  )) as TagGardenOutput;

  logger.info(
    {
      runId: args.runId,
      totalUniqueTags: output.totalUniqueTags,
      notesUpdated: output.notesUpdated,
      reportWritten: output.reportWritten,
    },
    'tag-garden flow completed',
  );

  const dryNote = args.dryRun
    ? `\n\n---\n**Approval required.** "Tag Garden" makes changes to your vault, so ` +
      `this was a plan only — nothing was written (report path preview: ` +
      `${output.reportPath}). Reply "proceed" (or "yes, go ahead") to run it for real.`
    : '';

  return {
    output,
    finalResponse: `${output.response}${dryNote}`,
  };
}

registerFlow({
  id: 'tag-garden',
  name: 'Tag Garden',
  description: 'Tag analysis and cleanup. Inventories all tags, finds near-duplicates, identifies orphans, checks against taxonomy.',
  triggers: ['tag garden', 'clean up my tags', 'analyze tags', 'fix my tags', 'tag cleanup', 'audit tags'],
  approvalRequired: true,
  sourceFile: 'src/flows/tag-garden.ts',
  run: async (args) => runTagGardenFlow({ request: args.request, dryRun: args.dryRun ?? false, runId: args.runId }),
});
