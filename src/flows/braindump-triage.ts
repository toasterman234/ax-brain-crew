import { flow } from '@ax-llm/ax';
import { trace, type Tracer } from '@opentelemetry/api';
import { createModelClient } from '../ai/clients.js';
import { vaultList } from '../tools/vault-list.js';
import { vaultRead } from '../tools/vault-read.js';
import { vaultWrite } from '../tools/vault-write.js';
import { vaultSearch } from '../tools/vault-search.js';
import { getLogger } from '../observability/logger.js';
import { registerFlow } from './registry.js';

// ---------------------------------------------------------------------------
// E2 batch 4 — braindump-triage as an ax-native flow()
//
// Pipeline (from crew/skills/braindump-triage.md):
//
//   1. writeRawFile (.map)          — vaultWrite verbatim paste to raw/
//   2. decomposeBraindump (ax node) — ONE LLM call: paste → DecomposedItem[]
//   3. updateRawWithHeadings (.map) — append ## slugs to raw file
//   4. verifyHeadings (.map)        — confirm each ## <slug> exists
//   5. validateRelatedLinks (.map)  — vaultSearch each related → verified-only
//   6. writeItemNotes (.map)        — vaultWrite per-item notes + button block
//   7. ensureTriageBase (.map)      — vaultRead/write Triage.base if missing
//   8. replaceOldFlatNote (.map)    — detect old flat triage note, replace body
//   9. buildResponse (.map)         — TL;DR + linked list + base path
//   .returns(...)                   — typed Out
//
// Design A — no agent ever calls a tool. dryRun threaded into every write.
// ---------------------------------------------------------------------------

export interface BraindumpTriageInput extends Record<string, any> {
  braindumpText: string;
  dateIso: string;
  dryRunMode: boolean;
  sessionRunId?: string;
}

export interface BraindumpTriageOutput extends Record<string, unknown> {
  itemNotes: string[];
  basePath: string;
  rawSourcePath: string;
  itemCount: number;
  response: string;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface DecomposedItem {
  slug: string;
  title: string;
  confidence: 'high' | 'medium' | 'speculation';
  confidenceNote: string;
  source: string;
  related: string[];
  next: string;
}

interface RelatedValidation {
  suggested: string;
  verified: boolean;
  actualPath?: string;
}

// ---------------------------------------------------------------------------
// Deterministic helpers (no LLM). Exported for testing.
// ---------------------------------------------------------------------------

export function findRawFilePath(dateIso: string): {
  path: string;
  suffix: number;
} {
  let maxSuffix = 0;
  try {
    const { items } = vaultList({ directory: 'raw' });
    const prefix = `${dateIso}-braindump-original`;
    for (const item of items) {
      if (item.type !== 'file' || !item.name.endsWith('.md')) continue;
      const base = item.name.slice(0, -3);
      if (base === prefix) {
        maxSuffix = Math.max(maxSuffix, 1);
        continue;
      }
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = base.match(new RegExp(`^${escaped}-(\\d+)$`));
      if (match) {
        maxSuffix = Math.max(maxSuffix, parseInt(match[1]!, 10));
      }
    }
  } catch {
    // raw/ may not exist yet.
  }
  const nextSuffix = maxSuffix + 1;
  const fileName =
    nextSuffix === 1
      ? `${dateIso}-braindump-original.md`
      : `${dateIso}-braindump-original-${nextSuffix}.md`;
  return { path: `raw/${fileName}`, suffix: nextSuffix };
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function sanitizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function wikilinkFromSlug(rawFileName: string, slug: string): string {
  const base = rawFileName.replace(/\.md$/, '');
  return `[[${base}#${slug}|link]]`;
}

export function triageButtonBlock(): string {
  return [
    '---',
    '### Triage actions',
    '`BUTTON[triage-route]` `BUTTON[triage-research]` `BUTTON[triage-archive]`',
    '',
    '```meta-bind-button',
    'label: "🚀 Route to board"',
    'hidden: true',
    'id: triage-route',
    'style: primary',
    'actions:',
    '  - type: updateMetadata',
    '    bindTarget: request_status',
    '    evaluate: false',
    '    value: pending',
    '  - type: updateMetadata',
    '    bindTarget: request_action',
    '    evaluate: false',
    '    value: route',
    '```',
    '```meta-bind-button',
    'label: "🔎 Research"',
    'hidden: true',
    'id: triage-research',
    'style: default',
    'actions:',
    '  - type: updateMetadata',
    '    bindTarget: request_status',
    '    evaluate: false',
    '    value: pending',
    '  - type: updateMetadata',
    '    bindTarget: request_action',
    '    evaluate: false',
    '    value: research',
    '```',
    '```meta-bind-button',
    'label: "🗄️ Archive"',
    'hidden: true',
    'id: triage-archive',
    'style: destructive',
    'actions:',
    '  - type: updateMetadata',
    '    bindTarget: status',
    '    evaluate: false',
    '    value: shelved',
    '  - type: updateMetadata',
    '    bindTarget: routed',
    '    evaluate: false',
    '    value: true',
    '```',
  ].join('\n');
}

export function triageBaseYaml(): string {
  return [
    'filters:',
    '  and:',
    '    - file.hasTag("braindump-triage")',
    "    - 'routed != true'",
    'views:',
    '  - type: table',
    '    name: Triage — all un-routed items',
    '    order:',
    '      - file.name',
    '      - confidence',
    '      - confidence_note',
    '      - next',
    '      - source',
    '      - related',
    '      - original',
    '    sort:',
    '      - property: confidence',
    '        direction: DESC',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Item note body builder.
// ---------------------------------------------------------------------------

function buildItemNoteBody(
  item: DecomposedItem,
  rawFileName: string,
  dateIso: string,
  verifiedRelated: RelatedValidation[],
): string {
  const relatedLinks = verifiedRelated
    .filter((v) => v.verified)
    .map((v) => `"[[${v.actualPath!.replace(/\.md$/, '')}]]"`)
    .join(', ');
  const originalLink = wikilinkFromSlug(rawFileName, item.slug);

  const frontmatter = [
    '---',
    `slug: "${item.slug}"`,
    `confidence: "${item.confidence}"`,
    `confidence_note: "${item.confidenceNote.replace(/"/g, '\\"')}"`,
    `source: "${item.source.replace(/"/g, '\\"')}"`,
    `related: [${relatedLinks}]`,
    `next: "${item.next.replace(/"/g, '\\"')}"`,
    `original: "${originalLink}"`,
    `tags: ["braindump-triage", "braindump-${dateIso}"]`,
    `date: "${dateIso}"`,
    `routed: false`,
    '---',
    '',
  ].join('\n');

  return frontmatter + triageButtonBlock() + '\n';
}

// ---------------------------------------------------------------------------
// Build the flow.
// ---------------------------------------------------------------------------

export function buildBraindumpTriageFlow() {
  return (
    flow<BraindumpTriageInput, BraindumpTriageOutput>()
      .node(
        'decomposeBraindump',
        'braindumpText:string "the raw multi-item paste" -> items:json "array of {slug, title, confidence: high|medium|speculation, confidenceNote, source, related:string[], next}"',
      )

      // 1) Write raw file + init state accumulator.
      .map((state) => {
        const date = state.dateIso || todayIso();
        const { path } = findRawFilePath(date);
        vaultWrite({
          path,
          content: state.braindumpText,
          overwrite: false,
          dryRun: state.dryRunMode,
        });
        return {
          ...state,
          dateIso: date,
          rawFilePath: path,
          rawFileName: path.split('/').pop()!,
          warningsAcc: [] as string[],
        };
      })

      // 2) Run the LLM decompose node.
      .execute('decomposeBraindump', (state) => ({
        braindumpText: state.braindumpText,
      }))

      // 3) Parse LLM output + validate items + update raw file with headings.
      .map((state) => {
        const items: DecomposedItem[] =
          (state.decomposeBraindumpResult as any)?.items ?? [];
        const warnings: string[] = [...(state.warningsAcc as string[])];

        for (const item of items) {
          // Coerce LLM output — ax may return nested objects for string fields.
          if (typeof item.next !== 'string') item.next = String(item.next ?? 'Review and classify');
          if (typeof item.confidenceNote !== 'string') item.confidenceNote = String(item.confidenceNote ?? '—');
          if (typeof item.source !== 'string') item.source = String(item.source ?? '—');
          if (typeof item.title !== 'string') item.title = String(item.title ?? '');
          if (typeof item.slug !== 'string') item.slug = String(item.slug ?? 'untitled');

          const safe = sanitizeSlug(item.slug);
          if (safe !== item.slug) {
            warnings.push(
              `Slug "${item.slug}" → "${safe}" (sanitized)`,
            );
            item.slug = safe;
          }
          if (!['high', 'medium', 'speculation'].includes(item.confidence)) {
            warnings.push(
              `Item "${item.slug}": invalid confidence "${item.confidence}" → "speculation"`,
            );
            item.confidence = 'speculation';
          }
          if (!item.title) item.title = item.slug.replace(/-/g, ' ');
          if (!item.confidenceNote) item.confidenceNote = '—';
          if (!item.source) item.source = '—';
          if (!item.next) item.next = 'Review and classify';
        }

        // Append ## slug headings to the raw file.
        // In dry-run mode the file was never actually written — skip.
        const rawPath = state.rawFilePath as string;
        if (items.length > 0 && !state.dryRunMode) {
          try {
            const { content } = vaultRead({ path: rawPath });
            if (!content.includes(`## ${items[0]!.slug}`)) {
              const headingBlock = items
                .map((item) => `## ${item.slug}`)
                .join('\n\n');
              vaultWrite({
                path: rawPath,
                content: `${content.trimEnd()}\n\n---\n\n${headingBlock}\n`,
                overwrite: true,
                dryRun: false,
              });
            }
          } catch {
            warnings.push(
              `Could not update raw file "${rawPath}" with headings`,
            );
          }
        }

        return { ...state, decomposedItems: items, warningsAcc: warnings };
      })

      // 4) Verify headings — confirm each ## <slug> exists in raw file.
      // In dry-run mode headings were never written — skip.
      .map((state) => {
        const items = state.decomposedItems as DecomposedItem[];
        const warnings: string[] = [...(state.warningsAcc as string[])];
        const rawPath = state.rawFilePath as string;

        if (!state.dryRunMode) {
          try {
            const { content } = vaultRead({ path: rawPath });
            for (const item of items) {
              if (!content.includes(`## ${item.slug}`)) {
                warnings.push(
                  `Heading "## ${item.slug}" missing from "${rawPath}"`,
                );
              }
            }
          } catch {
            warnings.push(`Could not read "${rawPath}" for heading verification`);
          }
        }

        return { ...state, warningsAcc: warnings };
      })

      // 5) Validate related links via vaultSearch.
      .map((state) => {
        const items = state.decomposedItems as DecomposedItem[];
        const validated: RelatedValidation[][] = [];

        for (const item of items) {
          const itemValidated: RelatedValidation[] = [];
          for (const link of item.related) {
            const noteName = link
              .replace(/^\[\[|\]\]$/g, '')
              .split('|')[0]!
              .trim();
            if (!noteName) {
              itemValidated.push({ suggested: link, verified: false });
              continue;
            }
            try {
              const { results } = vaultSearch({ query: noteName, limit: 5 });
              const match = results.find(
                (r) =>
                  r.path.replace(/\.md$/, '').endsWith(noteName) ||
                  r.path.replace(/\.md$/, '').split('/').pop() === noteName,
              );
              itemValidated.push({
                suggested: link,
                verified: !!match,
                actualPath: match?.path,
              });
            } catch {
              itemValidated.push({ suggested: link, verified: false });
            }
          }
          validated.push(itemValidated);
        }

        return { ...state, validatedRelated: validated };
      })

      // 6) Write item notes.
      .map((state) => {
        const items = state.decomposedItems as DecomposedItem[];
        const validated = state.validatedRelated as RelatedValidation[][];
        const dateIso = state.dateIso as string;
        const rawFileName = state.rawFileName as string;
        const warnings: string[] = [...(state.warningsAcc as string[])];
        const written: string[] = [];
        const folder = `Inbox/${dateIso}-braindump`;

        for (let i = 0; i < items.length; i++) {
          const item = items[i]!;
          const itemValidated = validated[i] ?? [];
          const notePath = `${folder}/${item.slug}.md`;
          const body = buildItemNoteBody(
            item,
            rawFileName,
            dateIso,
            itemValidated,
          );

          const result = vaultWrite({
            path: notePath,
            content: body,
            overwrite: false,
            dryRun: state.dryRunMode,
          });

          if (result.operation === 'skipped') {
            warnings.push(
              `Item note "${notePath}" already exists — skipped`,
            );
          }
          // Track all decomposed items, not just newly-written ones.
          written.push(notePath);

          for (const uv of itemValidated.filter((v) => !v.verified)) {
            warnings.push(
              `Item "${item.slug}": related "${uv.suggested}" not found — stripped`,
            );
          }
        }

        return {
          ...state,
          writtenItemNotes: written,
          warningsAcc: warnings,
        };
      })

      // 7) Ensure Triage.base exists.
      .map((state) => {
        const warnings: string[] = [...(state.warningsAcc as string[])];
        const basePath = 'Inbox/Triage.base';
        try {
          vaultRead({ path: basePath });
        } catch {
          vaultWrite({
            path: basePath,
            content: triageBaseYaml(),
            overwrite: false,
            dryRun: state.dryRunMode,
          });
        }
        return { ...state, triageBasePath: basePath, warningsAcc: warnings };
      })

      // 8) Replace old flat triage note.
      .map((state) => {
        const dateIso = state.dateIso as string;
        const warnings: string[] = [...(state.warningsAcc as string[])];
        try {
          const { items } = vaultList({ directory: 'Inbox' });
          const old = items.filter(
            (i) =>
              i.type === 'file' &&
              i.name.startsWith(dateIso) &&
              i.name.includes('triage') &&
              i.name.endsWith('.md'),
          );
          const noteLinks = (state.writtenItemNotes as string[]).map((n) => {
            const name = n.split('/').pop()!.replace(/\.md$/, '');
            return `- [[${n.replace(/\.md$/, '')}|${name}]]`;
          });
          for (const o of old) {
            vaultWrite({
              path: o.path,
              content: [
                `# Triage — ${dateIso}`,
                '',
                'Items have been decomposed into individual notes and are viewable in the unified [[Triage.base|Triage Base]].',
                '',
                '## Items',
                ...noteLinks,
                '',
              ].join('\n'),
              overwrite: true,
              dryRun: state.dryRunMode,
            });
          }
        } catch {
          // harmless
        }
        return { ...state, warningsAcc: warnings };
      })

      // 9) Build human-readable response.
      .map((state) => {
        const items = state.decomposedItems as DecomposedItem[];
        const dateIso = state.dateIso as string;
        const basePath = state.triageBasePath as string;
        const rawPath = state.rawFilePath as string;
        const verb = state.dryRunMode ? 'Would decompose' : 'Decomposed';
        const lines: string[] = [
          `## ${verb} braindump into ${items.length} item(s)`,
          '',
        ];

        if (items.length === 0) {
          lines.push(
            'No distinct items found. Check that the paste contains identifiable sections.',
          );
        } else {
          for (const item of items) {
            const emoji =
              item.confidence === 'high'
                ? '🟢'
                : item.confidence === 'medium'
                  ? '🟡'
                  : '🔴';
            lines.push(
              `- ${emoji} [[Inbox/${dateIso}-braindump/${item.slug}|${item.title}]] — ${item.confidenceNote}`,
            );
          }
          lines.push('');
          lines.push(
            `**Base:** [[${basePath.replace(/\.base$/, '')}|Triage Base]]`,
          );
          lines.push(
            `**Raw source:** [[${rawPath.replace(/\.md$/, '')}|${rawPath}]]`,
          );
        }

        return {
          ...state,
          tripReport: lines.join('\n'),
        };
      })

      .returns((state) => ({
        itemNotes: state.writtenItemNotes as string[],
        basePath: state.triageBasePath as string,
        rawSourcePath: state.rawFilePath as string,
        itemCount: (state.decomposedItems as DecomposedItem[]).length,
        response: state.tripReport as string,
        warnings: state.warningsAcc as string[],
      }))
  );
}

// ---------------------------------------------------------------------------
// Public runner.
// ---------------------------------------------------------------------------

export interface RunBraindumpTriageFlowResult {
  output: BraindumpTriageOutput;
  finalResponse: string;
}

export async function runBraindumpTriageFlow(args: {
  request: string;
  dryRun: boolean;
  runId?: string;
  tracer?: Tracer;
}): Promise<RunBraindumpTriageFlowResult> {
  const logger = getLogger();
  const wf = buildBraindumpTriageFlow();
  const llm = createModelClient('fast');
  const tracer =
    args.tracer ?? trace.getTracer('ax-brain-crew.braindump-triage');

  const braindumpText = args.request;
  const dateIso = todayIso();

  logger.info(
    { runId: args.runId, dryRun: args.dryRun, dateIso },
    'braindump-triage flow started',
  );

  const output = (await wf.forward(
    llm,
    {
      braindumpText,
      dateIso,
      dryRunMode: args.dryRun,
      sessionRunId: args.runId,
    },
    { tracer },
  )) as BraindumpTriageOutput;

  logger.info(
    { runId: args.runId, itemCount: output.itemCount },
    'braindump-triage flow completed',
  );

  const dryNote = args.dryRun
    ? `\n\n---\n**Approval required.** "Braindump Triage" makes changes to your vault, so this was a plan only — nothing was written. Reply "proceed" (or "yes, go ahead") to run it for real.`
    : '';

  return { output, finalResponse: `${output.response}${dryNote}` };
}

// Self-register in the flow registry
registerFlow({
  id: 'braindump-triage',
  name: 'Braindump Triage',
  description: 'Decomposes a raw multi-item paste into individually triaged vault notes with confidence/source/related/next properties, plus a sortable Base view.',
  triggers: ['triage this braindump', 'triage this list', 'triage these items', 'break this list down', 'triage this brain dump'],
  approvalRequired: true,
  sourceFile: 'src/flows/braindump-triage.ts',
  run: async (args) => runBraindumpTriageFlow({ request: args.request, dryRun: args.dryRun ?? false, runId: args.runId }),
});
