import { flow } from '@ax-llm/ax';
import { randomUUID } from 'node:crypto';
import { trace, type Tracer } from '@opentelemetry/api';
import { createModelClient } from '../ai/clients.js';
import { vaultRead } from '../tools/vault-read.js';
import { vaultWrite } from '../tools/vault-write.js';
import { vaultMove } from '../tools/vault-move.js';
import { vaultUpdateFrontmatter } from '../tools/vault-frontmatter.js';
import { getLogger } from '../observability/logger.js';
import { registerFlow } from './registry.js';
import {
  loadProject,
  checkProjectPhases,
  TEMPLATES,
} from '../tools/phase-gate-core.js';
import { getVaultRoot } from '../tools/vault-path.js';

// ---------------------------------------------------------------------------
// E2 batch 3 — project-scaffold as an ax-native flow()
//
// Pipeline (from vault/Projects/project-scaffold-flow-design.md):
//
//   readInitiativeNote (.map)            — read note, derive Name/slug,
//                                          check for old flat card
//   derivePhaseTitles (ax() LLM node)    — read note, pick lifecycle template,
//                                          return tailored phase titles+descriptions
//   generateIds (.map)                   — fresh projectId + task IDs
//   createProjectFile (.map)             — write _taskboard/<Name>.md
//   createPhaseTasks (.map)              — write 4 phase task cards
//   createBoardView (.map)               — write _taskboard/<Name>.base
//   retireOldCard (.map)                 — delete flat card + update Ax-Brain-Crew
//   updateInitiativeNote (.map)          — update routed_to frontmatter
//   verifyScaffold (.map)                — call checkProjectPhases(), surface warnings
//   .returns(...)                         — typed ScaffoldOutput
//
// Design A — no agent ever runs. One ax() LLM node for tailored phase
// titles/descriptions; all other steps are deterministic .map() calls.
// dryRun is threaded into every write. Approval gate applies.
// ---------------------------------------------------------------------------

// NOTE: ax v23 rejects generic field names — use descriptive names.
export interface ScaffoldInput extends Record<string, any> {
  /** Vault-relative path to the initiative note (e.g. Projects/my-project.md). */
  initiativeNote: string;
  /** Optional lifecycle template override (e.g. "research"). When set and valid,
   * the LLM still generates tailored phase titles but the lifecycle is forced to
   * this value. When absent, the LLM picks the lifecycle. */
  lifecycleHint?: string;
  /** When true, no writes happen — plan only. */
  dryRunMode: boolean;
  /** The dispatcher's runId, threaded for tracing. */
  sessionRunId?: string;
}

export interface ScaffoldOutput extends Record<string, unknown> {
  /** Vault-relative path to the PM project file. */
  project: string;
  /** Vault-relative paths to the phase task files, in lifecycle order. */
  phases: string[];
  /** The lifecycle template chosen (e.g. scope-plan-build-verify). */
  lifecycle: string;
  /** Path of the retired flat card, or null if none existed. */
  retiredCard: string | null;
  /** Human-readable summary of what was scaffolded. */
  response: string;
  /** Warnings accumulated across the flow. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Internal state shape (accumulated across flow steps).
// ---------------------------------------------------------------------------

interface PhaseRecord {
  phase: string; // e.g. "scope", "plan"
  title: string; // tailored title from the LLM node
  description: string; // tailored body from the LLM node
}

interface OldCardInfo {
  path: string; // vault-relative, e.g. _taskboard/Ax-Brain-Crew_tasks/my-item.md
  id: string;
}

// ---------------------------------------------------------------------------
// Deterministic helpers.
// ---------------------------------------------------------------------------

export function generateCardId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Convert kebab-case or snake_case to Title Case. */
export function toTitleCase(raw: string): string {
  return raw
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Strip frontmatter, return body-only. */
export function stripFrontmatter(md: string): string {
  if (!md.startsWith('---\n')) return md;
  const end = md.indexOf('\n---\n', 4);
  const close = end === -1 && md.endsWith('\n---') ? md.length - 4 : end;
  if (close === -1) return md;
  return md.slice(close + 5).trim();
}

/**
 * Check if a flat card exists under Ax-Brain-Crew by slug.
 * Returns card info or null.
 */
function findOldCard(slug: string): OldCardInfo | null {
  const cardPath = `_taskboard/Ax-Brain-Crew_tasks/${slug}-task.md`;
  try {
    const { content } = vaultRead({ path: cardPath });
    const idMatch = content.match(/^id:\s*"([^"]+)"/m);
    const id = idMatch?.[1] ?? '';
    return { path: cardPath, id };
  } catch {
    return null;
  }
}

/**
 * Produce a human-readable description of available lifecycle templates
 * for the LLM node to choose from.
 */
export function describeLifecycles(): string {
  return Object.entries(TEMPLATES)
    .map(([name, tpl]) => {
      const phaseNames = tpl.phases.map((p) => p.phase).join(' → ');
      return `${name} (phases: ${phaseNames})`;
    })
    .join('\n');
}

const MIN_SECTION_CHARS = 40;

function splitRawNote(md: string): { frontmatter: string | null; body: string } {
  if (!md.startsWith('---\n')) return { frontmatter: null, body: md.trim() };
  const end = md.indexOf('\n---\n', 4);
  const close = end === -1 && md.endsWith('\n---') ? md.length - 4 : end;
  if (close === -1) return { frontmatter: null, body: md.trim() };
  return {
    frontmatter: md.slice(0, close + 5),
    body: md.slice(close + 5).trim(),
  };
}

function sectionRange(body: string, headingPatterns: RegExp[]): { start: number; end: number; content: string } | null {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const h = line.match(/^#{1,6}\s+(.+)$/);
    if (!h?.[1]) continue;
    const heading = h[1].trim();
    if (!headingPatterns.some((p) => p.test(heading))) continue;
    const headingLevel = (line.match(/^#+/) ?? [''])[0].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? '';
      const nextLevel = (next.match(/^#+/) ?? [''])[0].length;
      if (nextLevel > 0 && nextLevel <= headingLevel) {
        end = j;
        break;
      }
    }
    return {
      start: i,
      end,
      content: lines.slice(i + 1, end).join('\n').trim(),
    };
  }
  return null;
}

function meaningfulText(section: string): string {
  return section
    .split('\n')
    .filter((line) => !/^#{1,6}\s+/.test(line.trim()))
    .join('\n')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[`*_>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasMeaningfulSection(body: string, headingPatterns: RegExp[]): boolean {
  const section = sectionRange(body, headingPatterns);
  return !!section && meaningfulText(section.content).length >= MIN_SECTION_CHARS;
}

function hasPlanStructure(body: string): boolean {
  const plan = sectionRange(body, [/^plan$/i, /^plan\b/i]);
  if (!plan) return false;
  const text = plan.content;
  const hasLabel = (source: string, ...words: string[]) => {
    const alt = words.join('|');
    const re = new RegExp(
      `^\\s*(?:#{1,6}\\s+|[-*]\\s+)?(?:\\*\\*)?\\s*(?:${alt})(?:\\*\\*)?\\s*[:：]?\\s*$` +
        `|^\\s*(?:[-*]\\s+)?(?:\\*\\*)?\\s*(?:${alt})(?:\\*\\*)?\\s*[:：]\\s+\\S`,
      'im',
    );
    return re.test(source);
  };
  return (
    hasLabel(text, 'goal', 'goals') &&
    hasLabel(text, 'task', 'tasks') &&
    hasLabel(text, 'open decision', 'open decisions', 'decision', 'decisions')
  );
}

function upsertSection(
  body: string,
  heading: string,
  content: string,
  headingPatterns: RegExp[],
): string {
  const rendered = `## ${heading}\n\n${content.trim()}`;
  const found = sectionRange(body, headingPatterns);
  const lines = body.trim().length > 0 ? body.split('\n') : [];
  if (!found) {
    return [body.trim(), rendered].filter(Boolean).join('\n\n').trim();
  }
  const next = [...lines.slice(0, found.start), ...rendered.split('\n'), ...lines.slice(found.end)];
  return next.join('\n').trim();
}

function contextSnippet(body: string, fallbackName: string): string {
  const text = meaningfulText(body);
  if (!text) {
    return `${fallbackName} needs a dedicated tracked initiative note so work can move through a governed lifecycle instead of living as ad-hoc board edits and scattered prose.`;
  }
  return text.slice(0, 280);
}

export function ensureCanonicalInitiativeNote(input: {
  raw: string;
  name: string;
  lifecycle: string;
  phases: PhaseRecord[];
  today: string;
}): string {
  const { frontmatter, body } = splitRawNote(input.raw);
  const snippet = contextSnippet(body, input.name);
  let nextBody = body.trim();

  if (!hasMeaningfulSection(nextBody, [/problem/i, /intent/i])) {
    const problem = `${snippet} This scaffold seeds a canonical Problem section so the phase gate has a real artifact to evaluate from the start.`;
    nextBody = upsertSection(nextBody, 'Problem', problem, [/problem/i, /intent/i]);
  }

  if (!hasMeaningfulSection(nextBody, [/approach/i, /solution/i, /design/i, /what.?s built/i])) {
    const phaseNames = input.phases.map((p) => p.phase).join(' → ');
    const approach =
      `Use the ${input.lifecycle} lifecycle (${phaseNames}) to turn ${input.name} into tracked deliverables. ` +
      `The scaffold creates the PM project, phase cards, and board view; this note remains the source of truth and each phase should update it with the artifact it produces.`;
    nextBody = upsertSection(
      nextBody,
      'Approach',
      approach,
      [/approach/i, /solution/i, /design/i, /what.?s built/i],
    );
  }

  if (!hasPlanStructure(nextBody)) {
    const taskLines = input.phases.map((p) => `- ${p.phase}: ${p.title}${p.description ? ` — ${p.description}` : ''}`);
    const plan = [
      '### Goal',
      `Stand up ${input.name} as a governed ${input.lifecycle} project with note artifacts and PM tracking that stay in sync.`,
      '',
      '### Tasks',
      ...taskLines,
      '',
      '### Open decisions',
      `- Refine the seeded scope and plan prose with project-specific detail during active work (seeded ${input.today}).`,
    ].join('\n');
    nextBody = upsertSection(nextBody, 'Plan', plan, [/^plan$/i, /^plan\b/i]);
  }

  const fm = frontmatter
    ? frontmatter
    : [
        '---',
        `date: ${input.today}`,
        'type: project',
        'tags:',
        '  - project',
        'status: planning',
        'ai-first: true',
        `last_updated: ${input.today}`,
        '---',
      ].join('\n');

  return `${fm.trim()}\n\n${nextBody.trim()}\n`;
}

/**
 * Build the project-scaffold flow.
 */
export function buildProjectScaffoldFlow() {
  return (
    flow<ScaffoldInput, ScaffoldOutput>()
      // ax() node — the ONE LLM call: reads the note body + available lifecycles,
      // returns the chosen lifecycle + tailored phase titles/descriptions.
      .node(
        'derivePhaseTitles',
        'initiativeNoteBody:string, availableLifecycles:string -> phases:json "{ lifecycle: string, phases: [{ phase: string, title: string, description: string }] }"',
      )

      // 1) Read the initiative note, derive Name/slug, check for old flat card.
      .map((state) => {
        const vaultRoot = getVaultRoot();
        const path = state.initiativeNote;
        // Ensure path starts with Projects/ — strip any leading slash or vault prefix.
        const cleanPath = path.replace(/^\/+/, '').replace(/^Projects\//, '');
        const initiativeNotePath = `Projects/${cleanPath}`;
        const slug = cleanPath.replace(/\.md$/, '');
        const name = toTitleCase(slug);

        let noteBody = '';
        try {
          const { content } = vaultRead({ path: initiativeNotePath });
          noteBody = stripFrontmatter(content);
        } catch {
          // Note doesn't exist yet — flow will warn at verify step.
        }

        const oldCard = findOldCard(slug);

        return {
          ...state,
          vaultRoot,
          initiativeNotePath,
          name,
          slug,
          noteBody,
          oldCard,
          lifecycleHint: state.lifecycleHint ?? null,
          warningsAcc: [] as string[],
          phases: [] as PhaseRecord[],
          lifecycle: '',
          projectId: '',
          phaseTaskIds: [] as string[],
          now: '',
          today: '',
        };
      })

      // 2) LLM: derive tailored phase titles + descriptions from the note.
      // When lifecycleHint is set and valid, force that template — the LLM
      // still generates tailored titles but skips lifecycle selection.
      .execute('derivePhaseTitles', (state) => {
        const hint = state.lifecycleHint as string | null | undefined;
        const hintLine = hint && TEMPLATES[hint]
          ? `\nNote: lifecycle must be "${hint}" (${TEMPLATES[hint]!.phases.map(p => p.phase).join(' → ')}).`
          : '';
        return {
          initiativeNoteBody: state.noteBody || '(no note content available — use defaults)',
          availableLifecycles: describeLifecycles() + hintLine,
        };
      })

      .map((state) => {
        const raw = state.derivePhaseTitlesResult?.phases;
        let lifecycle = '';
        let phases: PhaseRecord[] = [];

        if (raw && typeof raw === 'object') {
          const parsed = raw as Record<string, unknown>;
          if (typeof parsed.lifecycle === 'string' && TEMPLATES[parsed.lifecycle]) {
            lifecycle = parsed.lifecycle;
          }
          if (Array.isArray(parsed.phases)) {
            phases = (parsed.phases as Array<Record<string, unknown>>)
              .filter((p) => typeof p.phase === 'string' && typeof p.title === 'string')
              .map((p) => ({
                phase: String(p.phase),
                title: String(p.title),
                description: typeof p.description === 'string' ? String(p.description) : '',
              }));
          }
        }

        // Fallback: if the LLM returned nothing usable, use the lifecycleHint
        // (if valid), otherwise default to scope-plan-build-verify.
        if (!lifecycle || phases.length === 0) {
          const hint = state.lifecycleHint as string | null | undefined;
          lifecycle = (hint && TEMPLATES[hint]) ? hint : 'scope-plan-build-verify';
          const tpl = TEMPLATES[lifecycle];
          if (tpl && phases.length === 0) {
            phases = tpl.phases.map((s) => ({
              phase: s.phase,
              title: `${s.phase.charAt(0).toUpperCase() + s.phase.slice(1)} phase`,
              description: '',
            }));
          }
        }

        return {
          ...state,
          lifecycle,
          phases,
        };
      })

      // 3) Generate fresh IDs.
      .map((state) => {
        const projectId = generateCardId();
        const phaseTaskIds = state.phases.map(() => generateCardId());
        const now = new Date().toISOString();
        const today = now.slice(0, 10);

        return {
          ...state,
          projectId,
          phaseTaskIds,
          now,
          today,
        };
      })

      // 4) Ensure the initiative note has canonical gate artifacts.
      .map((state) => {
        let existingRaw = '';
        try {
          existingRaw = vaultRead({ path: state.initiativeNotePath }).content;
        } catch {
          // Missing note is okay — we'll create it from scaffold context.
        }

        const noteContent = ensureCanonicalInitiativeNote({
          raw: existingRaw,
          name: state.name,
          lifecycle: state.lifecycle,
          phases: state.phases,
          today: state.today,
        });

        vaultWrite({
          path: state.initiativeNotePath,
          content: noteContent,
          overwrite: true,
          dryRun: state.dryRunMode,
        });

        return {
          ...state,
          noteBody: stripFrontmatter(noteContent),
        };
      })

      // 5) Create the PM project file.
      .map((state) => {
        const projectPath = `_taskboard/${state.name}.md`;
        const projectBody = [
          '---',
          'pm-project: true',
          `id: "${state.projectId}"`,
          `title: "${state.name}"`,
          `lifecycle: "${state.lifecycle}"`,
          'description: ""',
          'color: "#79b58d"',
          'icon: "🛠️"',
          `taskIds:`,
          ...state.phaseTaskIds.map((tid) => `  - "${tid}"`),
          'customFields: {}',
          'teamMembers: []',
          'savedViews: []',
          `createdAt: "${state.now}"`,
          `updatedAt: "${state.now}"`,
          '---',
          '',
          '## For future agents',
          `Dedicated PM project (${state.name}) per ADR-003. Tasks below are tailored deliverables ` +
            `tagged by phase. Source of truth is the note. Lifecycle: ${state.lifecycle}.`,
          '',
          `Source: [[${state.slug}]]`,
          '',
        ].join('\n');

        vaultWrite({
          path: projectPath,
          content: projectBody,
          overwrite: false,
          dryRun: state.dryRunMode,
        });

        return { ...state, projectPath };
      })

      // 6) Create phase task cards.
      .map((state) => {
        const phasePaths: string[] = [];

        for (let i = 0; i < state.phases.length; i++) {
          const p = state.phases[i]!;
          const taskId = state.phaseTaskIds[i];
          const phaseSlug = p.phase.replace(/[^a-z0-9-]/g, '-');
          const taskPath = `_taskboard/${state.name}_tasks/${phaseSlug}.md`;
          const prevTaskId = i > 0 ? state.phaseTaskIds[i - 1] : '';

          const isFirst = i === 0;
          const status = isFirst ? 'in-progress' : 'todo';

          const descriptionBlock = p.description
            ? `${p.description}\n\n## Comments\n- **${state.today}** — Task created.\n`
            : `## Comments\n- **${state.today}** — Task created.\n`;

          const taskBody = [
            '---',
            'pm-task: true',
            `projectId: "${state.projectId}"`,
            `project: "${state.name}"`,
            'parentId:',
            `id: "${taskId}"`,
            `title: "${p.title}"`,
            'type: "task"',
            `status: "${status}"`,
            'priority: "medium"',
            `start: "${state.today}"`,
            'due: ""',
            'progress: 0',
            'assignees: []',
            `lifecycle: "${state.lifecycle}"`,
            `tags: ["phase/${p.phase}"]`,
            'subtaskIds: []',
            `dependencies: ${prevTaskId ? `\n  - "${prevTaskId}"` : '[]'}`,
            `createdAt: "${state.now}"`,
            `updatedAt: "${state.now}"`,
            '---',
            '',
            descriptionBlock,
            `Source: [[${state.slug}]]`,
            `Project: [[${state.name}]]`,
            '',
            '```meta-bind-button',
            'label: "✅ Complete phase"',
            'id: advance-phase',
            'style: primary',
            'actions:',
            '  - type: updateMetadata',
            '    bindTarget: request_status',
            '    evaluate: false',
            '    value: pending',
            '  - type: updateMetadata',
            '    bindTarget: request_action',
            '    evaluate: false',
            '    value: advance-phase',
            '```',
            '',
          ].join('\n');

          vaultWrite({
            path: taskPath,
            content: taskBody,
            overwrite: false,
            dryRun: state.dryRunMode,
          });

          phasePaths.push(taskPath);
        }

        return { ...state, phasePaths };
      })

      // 7) Create per-project board view (.base).
      .map((state) => {
        const basePath = `_taskboard/${state.name}.base`;
        const baseContent = [
          'filters:',
          '  and:',
          `    - projectId == "${state.projectId}"`,
          'views:',
          '  - type: kanban',
          '    name: Board',
          '    cardTitleProperty: title',
          '    groupBy:',
          '      property: status',
          '      direction: ASC',
          '  - type: kanban',
          '    name: By Phase',
          '    cardTitleProperty: title',
          '    groupBy:',
          '      property: tags',
          '      direction: ASC',
          '  - type: table',
          '    name: List',
          '    order: [file.name, status, tags]',
          '',
        ].join('\n');

        vaultWrite({
          path: basePath,
          content: baseContent,
          overwrite: false,
          dryRun: state.dryRunMode,
        });

        return { ...state, basePath };
      })

      // 8) Retire the old flat card under Ax-Brain-Crew, if it existed.
      .map((state) => {
        if (!state.oldCard) return state;

        const warnings = [...state.warningsAcc];

        try {
          vaultMove({
            source: state.oldCard.path,
            destination: `_taskboard/Ax-Brain-Crew_tasks/_retired-${state.slug}.md`,
            dryRun: state.dryRunMode,
          });
        } catch (err) {
          warnings.push(`Failed to retire old card ${state.oldCard.path}: ${String(err)}`);
        }

        try {
          const { content } = vaultRead({ path: '_taskboard/Ax-Brain-Crew.md' });
          const updated = content
            .split('\n')
            .filter((line) => !line.includes(`"${state.oldCard!.id}"`))
            .join('\n');
          vaultWrite({
            path: '_taskboard/Ax-Brain-Crew.md',
            content: updated,
            overwrite: true,
            dryRun: state.dryRunMode,
          });
        } catch (err) {
          warnings.push(`Failed to update Ax-Brain-Crew taskIds: ${String(err)}`);
        }

        return { ...state, warningsAcc: warnings };
      })

      // 9) Update the initiative note's routed_to frontmatter.
      .map((state) => {
        if (state.dryRunMode) return state;
        try {
          vaultUpdateFrontmatter({
            path: state.initiativeNotePath,
            fields: {
              routed_to: `[[${state.name}|PM project]]`,
              last_updated: state.today,
            },
            dryRun: false,
          });
        } catch (err) {
          state.warningsAcc.push(
            `Failed to update routed_to on ${state.initiativeNotePath}: ${String(err)}`,
          );
        }
        return state;
      })

      // 10) Post-scaffold verification — run the phase-gate check.
      .map((state) => {
        if (state.dryRunMode) return state;
        const warnings = [...state.warningsAcc];
        const vaultRoot = state.vaultRoot;
        const project = loadProject(vaultRoot, state.name);
        const findings = checkProjectPhases(vaultRoot, project);
        if (findings.length > 0) {
          for (const f of findings) {
            warnings.push(`[post-scaffold] ${f.pid} ${f.phase}: ${f.detail}`);
          }
          throw new Error(warnings.join('\n'));
        }
        return { ...state, warningsAcc: warnings };
      })

      // 11) Build the final output.
      .returns((state) => {
        const verb = state.dryRunMode ? 'Would scaffold' : 'Scaffolded';
        const lines: string[] = [];
        lines.push(`## ${verb} project: ${state.name}`);
        lines.push(`- **Lifecycle:** ${state.lifecycle}`);
        lines.push(`- **Project file:** ${state.projectPath ?? '(not yet written)'}`);
        lines.push(`- **Phase tasks:** ${(state.phasePaths ?? []).length} created`);
        for (let i = 0; i < (state.phases ?? []).length; i++) {
          const p = state.phases[i]!;
          lines.push(`  - ${p.phase}: "${p.title}"`);
        }
        if (state.oldCard) {
          lines.push(`- **Retired flat card:** ${state.oldCard.path}`);
        }

        if (state.warningsAcc.length > 0) {
          lines.push('');
          lines.push('## Warnings');
          for (const w of state.warningsAcc) {
            lines.push(`- ${w}`);
          }
        }

        return {
          project: state.projectPath ?? `_taskboard/${state.name}.md`,
          phases: state.phasePaths ?? [],
          lifecycle: state.lifecycle ?? 'scope-plan-build-verify',
          retiredCard: state.oldCard?.path ?? null,
          response: lines.join('\n'),
          warnings: state.warningsAcc,
        };
      })
  );
}

// ---------------------------------------------------------------------------
// Public runner — same pattern as triage-route / deep-clean.
// ---------------------------------------------------------------------------

export interface RunScaffoldFlowResult {
  output: ScaffoldOutput;
  finalResponse: string;
}

export async function runProjectScaffoldFlow(args: {
  request: string;
  dryRun: boolean;
  runId?: string;
  tracer?: Tracer;
}): Promise<RunScaffoldFlowResult> {
  const logger = getLogger();
  const wf = buildProjectScaffoldFlow();
  const llm = createModelClient('fast');
  const tracer = args.tracer ?? trace.getTracer('ax-brain-crew.project-scaffold');

  // Extract the initiative note path from the request. The skill is invoked
  // with a note path in natural language; default to the first Projects/ path
  // found, or fall back to an explicit path.
  const pathMatch = args.request.match(/Projects\/[^\s,.]+\.md/i);
  const initiativeNote = pathMatch?.[0] ?? args.request;

  // Detect lifecycle hint from the request. Keywords: "research" → research
  // template, "bug-fix" / "bugfix" → bug-fix template (when added).
  let lifecycleHint: string | undefined;
  const lower = args.request.toLowerCase();
  if (/\bresearch\b/.test(lower) && TEMPLATES['research']) {
    lifecycleHint = 'research';
  } else if (/\bbug.?fix\b/.test(lower) && TEMPLATES['bug-fix']) {
    lifecycleHint = 'bug-fix';
  }

  logger.info(
    { runId: args.runId, dryRun: args.dryRun, note: initiativeNote, lifecycleHint },
    'project-scaffold flow started',
  );

  const output = (await wf.forward(
    llm,
    {
      initiativeNote,
      lifecycleHint,
      dryRunMode: args.dryRun,
      sessionRunId: args.runId,
    },
    { tracer },
  )) as ScaffoldOutput;

  logger.info(
    {
      runId: args.runId,
      project: output.project,
      phases: output.phases.length,
      lifecycle: output.lifecycle,
    },
    'project-scaffold flow completed',
  );

  const dryNote = args.dryRun
    ? `\n\n---\n**Approval required.** "Project Scaffold" makes changes to your vault, so ` +
      `this was a plan only — nothing was written. Reply "proceed" (or "yes, go ahead") to run it for real.`
    : '';

  return {
    output,
    finalResponse: `${output.response}${dryNote}`,
  };
}

registerFlow({
  id: 'project-scaffold',
  name: 'Project Scaffold',
  description: 'Turns a routed initiative note into a dedicated project with a phase lifecycle (Scope→Plan→Build→Verify).',
  triggers: ['scaffold this project', 'scaffold a project', 'make this a project with phases', 'give this a lifecycle', 'break this into phases'],
  approvalRequired: true,
  sourceFile: 'src/flows/project-scaffold.ts',
  run: async (args) => runProjectScaffoldFlow({ request: args.request, dryRun: args.dryRun ?? false, runId: args.runId }),
});
