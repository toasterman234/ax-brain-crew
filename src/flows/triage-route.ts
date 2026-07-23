import { flow } from '@ax-llm/ax';
import { randomUUID } from 'node:crypto';
import { trace, type Tracer } from '@opentelemetry/api';
import { createModelClient } from '../ai/clients.js';
import { vaultList } from '../tools/vault-list.js';
import { vaultRead } from '../tools/vault-read.js';
import { vaultReadFrontmatter } from '../tools/vault-frontmatter.js';
import { vaultWrite } from '../tools/vault-write.js';
import { vaultMove } from '../tools/vault-move.js';
import { vaultUpdateFrontmatter } from '../tools/vault-frontmatter.js';
import { getLogger } from '../observability/logger.js';
import { registerFlow } from './registry.js';

// ---------------------------------------------------------------------------
// E2 batch 2 — triage-route as an ax-native flow()
//
// Pipeline (from crew/skills/triage-route.md + the mermaid design at
// Projects/triage-route-flow-design.md):
//
//   scanFolder (.map, deterministic I/O) — list folder, filter .md, read each,
//                                          skip already-routed items
//     .branch(hasItems)                   — fast exit when nothing to do
//        when(false) → skip               — just return empty trip report
//     .merge()
//   classifyAll (ax() node)               — ONE LLM call: batch of items → typed
//                                            classifications (task|research|
//                                            knowledge|idea|archive|ambiguous)
//   applyRoutes (.map, deterministic)     — iterate items, branch on type,
//                                            execute vault tools directly
//                                            (Design A — no agent calls tools)
//   buildReport (.map)                    — trip report with routed/unrouted counts
//   .returns(...)                          — typed Out
//
// dryRun is threaded into every write (vaultMove, vaultWrite,
// vaultUpdateFrontmatter) via the same dryRunMode flag in flow state.
// Approval gate (proceed signal) applies — same pattern as deep-clean.
// No agent ever runs in this flow (Design A).
// ---------------------------------------------------------------------------

// NOTE: ax v23's signature validator rejects generic field names — field names
// here are descriptive (vaultFolder, dryRunMode, sessionRunId).
export interface TriageRouteInput extends Record<string, any> {
  /** Vault-relative path to the folder to scan (e.g. Inbox/braindump-2026-07-19-2/). */
  vaultFolder: string;
  /** When true, no writes happen — plan only. */
  dryRunMode: boolean;
  /** The dispatcher's runId, threaded for tracing. */
  sessionRunId?: string;
}

export interface TriageRouteOutput extends Record<string, unknown> {
  /** Total items scanned (before filtering already-routed). */
  totalScanned: number;
  /** Items that were already routed and skipped. */
  alreadyRouted: number;
  /** Items classified and routed this run. */
  routedCount: number;
  /** Items left unrouted (ambiguous classification). */
  unroutedCount: number;
  /** Per-item results for the trip report. */
  routed: Array<{ item: string; type: string; destination?: string; card?: string }>;
  unrouted: Array<{ item: string; reason: string }>;
  /** Human-readable trip report. */
  response: string;
  /** Warnings accumulated across the flow. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Item shapes used in flow state.
// ---------------------------------------------------------------------------

interface ScannedItem {
  path: string;         // vault-relative, e.g. Inbox/braindump-.../my-item.md
  name: string;
  content: string;
  frontmatter: Record<string, unknown> | null;
  alreadyRouted: boolean;
}

/** Output of the classifyAll ax() node. */
interface ClassifiedItem {
  path: string;
  itemType: 'task' | 'research' | 'knowledge' | 'idea' | 'archive' | 'ambiguous';
  confidence?: string;
}

/** Per-item result after routing. */
interface RoutedItem {
  item: string;
  type: string;
  destination?: string;
  card?: string;
}

/** Per-item result for ambiguous / unrouted items. */
interface UnroutedItem {
  item: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Deterministic helpers (no LLM). These are exported so tests can assert them
// without constructing the flow.
// ---------------------------------------------------------------------------

/**
 * Scan a vault folder for un-routed triage items. Returns items sorted by name
 * so results are deterministic run-to-run.
 */
export function scanTriageFolder(folder: string): ScannedItem[] {
  const { items } = vaultList({ directory: folder });
  const mdFiles = items.filter(
    (i) => i.type === 'file' && i.name.endsWith('.md'),
  );
  const results: ScannedItem[] = [];
  for (const f of mdFiles) {
    try {
      const { content } = vaultRead({ path: f.path });
      const { frontmatter } = vaultReadFrontmatter({ path: f.path });
      const alreadyRouted = frontmatter?.routed === true;
      results.push({
        path: f.path,
        name: f.name,
        content,
        frontmatter,
        alreadyRouted,
      });
    } catch {
      // Skip unreadable files (permissions, EISDIR on malformed paths, etc.).
    }
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

/**
 * Find an existing PM card in a board folder to copy projectId from.
 * Returns null if the board folder is empty (caller must report the error).
 */
export function findSiblingProjectId(
  boardFolder: string,
): { path: string; projectId: string } | null {
  try {
    const { items } = vaultList({ directory: boardFolder });
    const card = items.find(
      (i) => i.type === 'file' && i.name.endsWith('.md'),
    );
    if (!card) return null;
    const { frontmatter } = vaultReadFrontmatter({ path: card.path });
    const projectId = frontmatter?.projectId;
    if (typeof projectId !== 'string' || projectId.length === 0) return null;
    return { path: card.path, projectId };
  } catch {
    return null;
  }
}

/** Generate a unique 16-char card id (copy length from existing cards). */
export function generateCardId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

/** Today's date in YYYY-MM-DD. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Map confidence string → priority string. */
export function confidenceToPriority(
  confidence?: string,
): 'high' | 'medium' | 'low' {
  const c = (confidence ?? '').toLowerCase();
  if (c === 'high') return 'high';
  if (c === 'medium') return 'medium';
  return 'low';
}

/** Derive a board folder name from the source folder.
 * Still returns the catch-all board for now; in the future, scan for a
 * .base file or project id in the folder to determine the right board. */
export function boardFolderFor(_folder: string): string {
  // e.g. "Inbox/braindump-2026-07-19-2/" → "_taskboard/Ax-Brain-Crew_tasks/"
  // Default catch-all board if no specific board maps.
  return '_taskboard/Ax-Brain-Crew_tasks';
}

// ---------------------------------------------------------------------------
// Per-type route handlers — each is a deterministic .map() function applied
// to a single classified item. All honor dryRunMode.
// ---------------------------------------------------------------------------

interface RouteContext {
  dryRun: boolean;
  boardFolder: string;
  siblingProjectId: string | null; // null = board empty; must report error
  warnings: string[];
  routed: RoutedItem[];
  unrouted: UnroutedItem[];
}

function handleTask(
  item: ClassifiedItem,
  ctx: RouteContext,
): void {
  // Move note to Projects/ (keep filename, just change directory).
  const dest = `Projects/${item.path.split('/').pop()!}`;

  vaultMove({
    source: item.path,
    destination: dest,
    dryRun: ctx.dryRun,
  });
  // result may be 'moved', 'dry_run', or 'error' — we handle dryRun
  // at the top of the flow; vault-move errors surface as warnings.

  // Stamp the original note with routed metadata (note: after a real move the
  // note lives at dest, so we update the destination path).
  const notePath = ctx.dryRun ? dest : dest; // same path either way for stamp
  vaultUpdateFrontmatter({
    path: notePath,
    fields: { routed: true, status: 'planned', routed_to: '', routed_at: todayIso() },
    dryRun: ctx.dryRun,
  });

  // Create PM card linking back to the note.
  let cardPath: string | undefined;
  if (ctx.siblingProjectId) {
    const cardId = generateCardId();
    const noteTitle = item.path.split('/').pop()!.replace(/\.md$/, '');
    const cardFile = `${ctx.boardFolder}${noteTitle}.md`.replace(/\/\//g, '/');

    const cardBody = [
      `---`,
      `pm-task: true`,
      `projectId: "${ctx.siblingProjectId}"`,
      `project: "Ax-Brain-Crew"`,
      `parentId:`,
      `id: "${cardId}"`,
      `title: "${noteTitle}"`,
      `type: "task"`,
      `status: "todo"`,
      `priority: "${confidenceToPriority(item.confidence)}"`,
      `start: "${todayIso()}"`,
      `due: ""`,
      `progress: 0`,
      `assignees: []`,
      `tags: []`,
      `subtaskIds: []`,
      `dependencies: []`,
      `createdAt: "${new Date().toISOString()}"`,
      `updatedAt: "${new Date().toISOString()}"`,
      `---`,
      ``,
      `Source: [[${noteTitle}]]`,
      ``,
    ].join('\n');

    vaultWrite({
      path: cardFile,
      content: cardBody,
      overwrite: false,
      dryRun: ctx.dryRun,
    });

    // Stamp the note card link back (update the frontmatter we set above).
    if (!ctx.dryRun) {
      vaultUpdateFrontmatter({
        path: notePath,
        fields: { routed_to: `[[${cardFile.replace(/\.md$/, '')}]]` },
        dryRun: false,
      });
    }

    cardPath = cardFile;
  } else {
    ctx.warnings.push(
      `Board folder "${ctx.boardFolder}" is empty — cannot copy projectId. ` +
      `Seed one card in the PM UI first. Task "${item.path}" was moved but had no card created.`,
    );
  }

  ctx.routed.push({
    item: item.path,
    type: 'task',
    destination: dest,
    card: cardPath,
  });
}

function handleResearch(
  item: ClassifiedItem,
  ctx: RouteContext,
): void {
  // Keep note where it is, cancel routed + set exploring status.
  vaultUpdateFrontmatter({
    path: item.path,
    fields: { routed: true, status: 'exploring', routed_at: todayIso() },
    dryRun: ctx.dryRun,
  });

  ctx.routed.push({
    item: item.path,
    type: 'research',
    destination: item.path, // stays in place
  });
}

function handleKnowledge(
  item: ClassifiedItem,
  ctx: RouteContext,
): void {
  const dest = `Knowledge/${item.path.split('/').pop()!}`;
  vaultMove({
    source: item.path,
    destination: dest,
    dryRun: ctx.dryRun,
  });
  vaultUpdateFrontmatter({
    path: ctx.dryRun ? item.path : dest,
    fields: { routed: true, status: '', routed_at: todayIso() },
    dryRun: ctx.dryRun,
  });

  ctx.routed.push({
    item: item.path,
    type: 'knowledge',
    destination: dest,
  });
}

function handleIdea(
  item: ClassifiedItem,
  ctx: RouteContext,
): void {
  // Leave in place, stamp exploring.
  vaultUpdateFrontmatter({
    path: item.path,
    fields: { routed: true, status: 'exploring', routed_at: todayIso() },
    dryRun: ctx.dryRun,
  });

  ctx.routed.push({
    item: item.path,
    type: 'idea',
    destination: item.path, // stays in place
  });
}

function handleArchive(
  item: ClassifiedItem,
  ctx: RouteContext,
): void {
  // Leave in place, stamp shelved.
  vaultUpdateFrontmatter({
    path: item.path,
    fields: { routed: true, status: 'shelved', routed_at: todayIso() },
    dryRun: ctx.dryRun,
  });

  ctx.routed.push({
    item: item.path,
    type: 'archive',
    destination: item.path, // stays in place
  });
}

// ---------------------------------------------------------------------------
// Build the flow.
// ---------------------------------------------------------------------------

export function buildTriageRouteFlow() {
  return (
    flow<TriageRouteInput, TriageRouteOutput>()
      // Native ax() classifier — one LLM call for ALL items in the batch.
      .node(
        'classifyAll',
        'itemBatch:json "array of {path, content, frontmatter} objects, one per un-routed item" -> classifiedItems:json "array of {path, itemType: one of task|research|knowledge|idea|archive|ambiguous, confidence?:string}"',
      )

      // 1) Scan the folder for un-routed items (deterministic, no LLM).
      .map((state) => {
        const allItems = scanTriageFolder(state.vaultFolder);
        const unRouted = allItems.filter((i) => !i.alreadyRouted);
        const alreadyRouted = allItems.filter((i) => i.alreadyRouted);
        return {
          ...state,
          allItems,
          unRoutedItems: unRouted,
          alreadyRoutedCount: alreadyRouted.length,
          totalScanned: allItems.length,
        };
      })

      // 2) Fast exit — no items to route.
      .branch((state) => (state.unRoutedItems as ScannedItem[]).length > 0)
        .when(false)
          .map((state) => ({
            ...state,
            classifiedResults: [] as ClassifiedItem[],
            routedItems: [] as RoutedItem[],
            unroutedReport: [] as UnroutedItem[],
            boardProjectId: null as string | null,
            warningsAcc: [] as string[],
          }))
        .when(true)
          .map((state) => ({
            ...state,
            boardProjectId: (() => {
              const bf = boardFolderFor(state.vaultFolder);
              const sibling = findSiblingProjectId(bf);
              if (!sibling) {
                return null;
              }
              return sibling.projectId;
            })(),
            warningsAcc: [] as string[],
          }))
      .merge()

      // 3a) Skip classification when no items.
      .branch((state) => (state.unRoutedItems as ScannedItem[]).length > 0)
        .when(false)
          .map((state) => ({
            ...state,
            classifiedResults: [] as ClassifiedItem[],
          }))
        .when(true)
          .execute('classifyAll', (state) => ({
            itemBatch: (state.unRoutedItems as ScannedItem[]).map((item) => ({
              path: item.path,
              content: item.content.slice(0, 3000), // cap per-item content
              frontmatter: item.frontmatter ?? {},
            })),
          }))
      .merge()

      // 4) Apply routes deterministically — iterate items, fork by type.
      .map((state) => {
        const classified = (state.classifyAllResult?.classifiedItems ??
          state.classifiedResults ??
          []) as ClassifiedItem[];
        const boardFolder = boardFolderFor(state.vaultFolder);
        const siblingProjectId = state.boardProjectId as string | null;
        const ctx: RouteContext = {
          dryRun: state.dryRunMode,
          boardFolder,
          siblingProjectId,
          warnings: state.warningsAcc as string[] ?? [],
          routed: [],
          unrouted: [],
        };

        if (!siblingProjectId && classified.some((c) => c.itemType === 'task')) {
          ctx.warnings.push(
            `Board folder "${boardFolder}" is empty — cannot create task cards. ` +
            `Seed one card in the PM UI first. Tasks will be classified but card creation skipped.`,
          );
        }

        for (const item of classified) {
          switch (item.itemType) {
            case 'task':
              handleTask(item, ctx);
              break;
            case 'research':
              handleResearch(item, ctx);
              break;
            case 'knowledge':
              handleKnowledge(item, ctx);
              break;
            case 'idea':
              handleIdea(item, ctx);
              break;
            case 'archive':
              handleArchive(item, ctx);
              break;
            case 'ambiguous':
            default:
              ctx.unrouted.push({
                item: item.path,
                reason: item.itemType === 'ambiguous'
                  ? 'Ambiguous — could not classify item type'
                  : `Unknown type "${item.itemType}"`,
              });
              break;
          }
        }

        return {
          ...state,
          routedItems: ctx.routed,
          unroutedReport: ctx.unrouted,
          warningsAcc: ctx.warnings,
        };
      })

      // 5) Build the trip report.
      .map((state) => {
        const routed = state.routedItems as RoutedItem[];
        const unrouted = state.unroutedReport as UnroutedItem[];
        const verb = state.dryRunMode ? 'Would route' : 'Routed';
        const lines: string[] = [];

        lines.push(`## ${verb} ${routed.length} item(s)`);
        if (state.alreadyRoutedCount as number > 0) {
          lines.push(`(Skipped ${state.alreadyRoutedCount} already-routed item(s))`);
        }
        lines.push('');

        for (const r of routed) {
          const parts = [`- **${r.type}**: ${r.item}`];
          if (r.destination && r.destination !== r.item) {
            parts.push(`→ ${r.destination}`);
          }
          if (r.card) {
            parts.push(`(card: ${r.card})`);
          }
          lines.push(parts.join(' '));
        }

        if (unrouted.length > 0) {
          lines.push('');
          lines.push(`## ${unrouted.length} item(s) left un-routed`);
          for (const u of unrouted) {
            lines.push(`- ${u.item} — ${u.reason}`);
          }
        }

        if (routed.length === 0 && unrouted.length === 0) {
          lines.push('No items to route. The folder is empty or all items are already routed.');
        }

        return {
          ...state,
          tripReport: lines.join('\n'),
        };
      })

      .returns((state) => ({
        totalScanned: state.totalScanned as number,
        alreadyRouted: state.alreadyRoutedCount as number,
        routedCount: (state.routedItems as RoutedItem[]).length,
        unroutedCount: (state.unroutedReport as UnroutedItem[]).length,
        routed: state.routedItems as RoutedItem[],
        unrouted: state.unroutedReport as UnroutedItem[],
        response: state.tripReport as string,
        warnings: state.warningsAcc as string[],
      }))
  );
}

// ---------------------------------------------------------------------------
// Public runner — same pattern as deep-clean / vault-audit / etc.
// ---------------------------------------------------------------------------

export interface RunTriageRouteFlowResult {
  output: TriageRouteOutput;
  finalResponse: string;
}

export async function runTriageRouteFlow(args: {
  request: string;
  dryRun: boolean;
  runId?: string;
  tracer?: Tracer;
}): Promise<RunTriageRouteFlowResult> {
  const logger = getLogger();
  const wf = buildTriageRouteFlow();
  const llm = createModelClient('fast');
  const tracer = args.tracer ?? trace.getTracer('ax-brain-crew.triage-route');

  // Parse the folder from the request. The skill is invoked with a folder path
  // in natural language; extract it. For now pass the vaultFolder through
  // as-is (the normalizer already extracts it).
  const vaultFolder = args.request || 'Inbox/';

  logger.info(
    { runId: args.runId, dryRun: args.dryRun, folder: vaultFolder },
    'triage-route flow started',
  );

  const output = (await wf.forward(
    llm,
    {
      vaultFolder,
      dryRunMode: args.dryRun,
      sessionRunId: args.runId,
    },
    { tracer },
  )) as TriageRouteOutput;

  logger.info(
    {
      runId: args.runId,
      scanned: output.totalScanned,
      routed: output.routedCount,
      unrouted: output.unroutedCount,
    },
    'triage-route flow completed',
  );

  const dryNote = args.dryRun
    ? `\n\n---\n**Approval required.** "Triage Route" makes changes to your vault, so ` +
      `this was a plan only — nothing was written. Reply "proceed" (or "yes, go ahead") to run it for real.`
    : '';

  return {
    output,
    finalResponse: `${output.response}${dryNote}`,
  };
}

registerFlow({
  id: 'triage-route',
  name: 'Triage Route',
  description: 'Routes triaged item notes to their destination: creates Project Manager task cards for ready items, or archives shelved ones.',
  triggers: ['route this item', 'route these items', 'route to the board', 'move this to the board', 'make a task for this', 'action this triage'],
  approvalRequired: true,
  sourceFile: 'src/flows/triage-route.ts',
  run: async (args) => runTriageRouteFlow({ request: args.request, dryRun: args.dryRun ?? false, runId: args.runId }),
});
