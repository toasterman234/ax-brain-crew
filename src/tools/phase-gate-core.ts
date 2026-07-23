// Phase-gate core — lifecycle-aware, table-driven phase→artifact model.
// From pm-lifecycle-enforcement (vault/Projects/pm-lifecycle-enforcement.md):
// "Phase → artifact model (the advance rule)" + Open decision #2 (the gate reads
// the project's chosen lifecycle TEMPLATE — it is NOT hardcoded to
// scope-plan-build-verify). Artifact tables mirror crew/skills/project-scaffold.md.
//
// This is shared by BOTH halves:
//   - Detect: scripts/check-vault-enforcement.ts checks P1-P4 in the poll.
//   - Prevent: src/tools/phase-gate.ts checkPhaseGate() the crew calls before
//     writing status: done on a phase card.
//
// Pure functions over a vaultRoot path — no live-daemon wiring, no writes. The
// only I/O is READS of the vault tree (frontmatter + note bodies + disk stat).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import YAML from 'yaml';

export type Frontmatter = Record<string, unknown>;

// A phase's position in its template's ordered phase list drives the P-id:
// position 0 → P1, 1 → P2, 2 → P3, 3 → P4. The gate keys by POSITION, not by a
// hardcoded "build" name, so `research` (frame/gather/synthesize/verify) maps to
// the same P1-P4 slots as scope-plan-build-verify.
export type PhaseArtifactKind =
  | 'scope-note' // note has non-empty Problem + Approach content
  | 'plan-block' // a plan block: Goal + Tasks + Open decisions (in-note or Plans/)
  | 'build-deliverable' // ≥1 resolvable deliverable OR an agent-log build entry
  | 'verify-record' // a verification record per verification-standard
  | 'frame-note' // research: note states the question + scope + success criteria
  | 'gather-sources' // research: a findings/sources note linked to the project
  | 'synthesize-note' // research: a synthesis note with tagged claims
  | 'reproduce-report' // bug-fix: note has repro steps + observed behavior
  | 'diagnose-note' // bug-fix: RCA note linking root cause + evidence
  | 'fix-deliverable'; // bug-fix: the fix is deployed/merged with a link

export interface PhaseSpec {
  phase: string; // e.g. "scope", "frame"
  artifact: PhaseArtifactKind;
}

export interface LifecycleTemplate {
  name: string;
  phases: PhaseSpec[]; // ordered
}

// The two shipped templates, straight from crew/skills/project-scaffold.md.
// Adding a template here (bug-fix: reproduce→diagnose→fix→verify, …) is the
// only edit needed to make the gate cover it — everything downstream is keyed
// by position + artifact kind.
export const TEMPLATES: Record<string, LifecycleTemplate> = {
  'scope-plan-build-verify': {
    name: 'scope-plan-build-verify',
    phases: [
      { phase: 'scope', artifact: 'scope-note' },
      { phase: 'plan', artifact: 'plan-block' },
      { phase: 'build', artifact: 'build-deliverable' },
      { phase: 'verify', artifact: 'verify-record' },
    ],
  },
  research: {
    name: 'research',
    phases: [
      { phase: 'frame', artifact: 'frame-note' },
      { phase: 'gather', artifact: 'gather-sources' },
      { phase: 'synthesize', artifact: 'synthesize-note' },
      { phase: 'verify', artifact: 'verify-record' },
    ],
  },
  'bug-fix': {
    name: 'bug-fix',
    phases: [
      { phase: 'reproduce', artifact: 'reproduce-report' },
      { phase: 'diagnose', artifact: 'diagnose-note' },
      { phase: 'fix', artifact: 'fix-deliverable' },
      { phase: 'verify', artifact: 'verify-record' },
    ],
  },
};

// Phase-name → template name reverse index, for inferring a template from the
// phase/* tags on a project's cards when no explicit lifecycle field is present.
// A project need not carry ALL of a template's phases (a scaffold may create a
// subset); inference succeeds when the observed phases are a subset of exactly
// one template AND include at least one phase unique to that template.
const PHASE_OWNERS: Record<string, string[]> = (() => {
  const owners: Record<string, string[]> = {};
  for (const [tplName, tpl] of Object.entries(TEMPLATES)) {
    for (const spec of tpl.phases) {
      (owners[spec.phase] ??= []).push(tplName);
    }
  }
  return owners;
})();

const DONE_STATUSES = new Set(['done', 'complete', 'completed', 'shipped']);
// Projects exempt from the phase-gate: closed/archived, and the Ax-Brain-Crew
// catch-all (flat cards, no real phases) + Research catch-all (topical tags).
const EXEMPT_PROJECT_STATUSES = new Set(['closed', 'archived', 'cancelled']);
const CATCHALL_PROJECTS = new Set(['Ax-Brain-Crew', 'Research']);

// ---------------------------------------------------------------------------
// Frontmatter / body parsing (self-contained so the script has no cross-dep on
// vault-path's live-root singleton — everything here takes an explicit root).
// ---------------------------------------------------------------------------

export function splitNote(raw: string): { fm: Frontmatter | null; body: string } {
  if (!raw.startsWith('---\n')) return { fm: null, body: raw };
  const end = raw.indexOf('\n---\n', 4);
  const close = end === -1 && raw.endsWith('\n---') ? raw.length - 4 : end;
  if (close === -1) return { fm: null, body: raw };
  try {
    const fm = YAML.parse(raw.slice(4, close));
    const body = raw.slice(close + 5);
    return { fm: fm && typeof fm === 'object' ? (fm as Frontmatter) : null, body };
  } catch {
    return { fm: null, body: raw };
  }
}

function phaseTag(fm: Frontmatter | null): string | null {
  const tags = fm?.tags;
  if (!Array.isArray(tags)) return null;
  for (const t of tags) {
    const m = String(t).match(/^phase\/(.+)$/);
    if (m) return m[1] ?? null;
  }
  return null;
}

function taskStatus(fm: Frontmatter | null): string {
  return String(fm?.status ?? '').trim().toLowerCase();
}

function parseDate(value: unknown): Date | null {
  if (value == null) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Project model — one project = one _taskboard/<Name>_tasks/ folder.
// ---------------------------------------------------------------------------

export interface PhaseCard {
  phase: string;
  status: string; // lowercased
  start: Date | null;
  fm: Frontmatter | null;
  cardRel: string; // vault-relative path
}

export interface ProjectModel {
  name: string; // <Name>, e.g. "Vault-Flow"
  taskDir: string; // absolute path to _taskboard/<Name>_tasks
  cards: PhaseCard[];
  template: LifecycleTemplate | null;
  explicitLifecycle: string | null; // from a card's `lifecycle` field, if any
  noteRel: string | null; // Projects/<slug>.md (vault-relative), if resolvable
  noteAbs: string | null;
  boardCardRel: string | null; // _taskboard/<Name>.md
  projectId: string | null;
  projectStatus: string; // from the project note frontmatter (lowercased)
  exempt: boolean;
}

// Resolve the Projects/<slug>.md note a board card points at, via the card's
// `Source: [[slug]]` line (project-scaffold writes it) or routed_to-style link.
function resolveProjectNote(
  vaultRoot: string,
  name: string,
): { rel: string | null; abs: string | null } {
  const boardCardAbs = resolve(vaultRoot, '_taskboard', `${name}.md`);
  let slug: string | null = null;
  if (existsSync(boardCardAbs)) {
    const raw = readFileSync(boardCardAbs, 'utf8');
    const m = raw.match(/Source:\s*\[\[([^\]|#]+)/);
    if (m && m[1]) slug = m[1].trim();
  }
  const candidates: string[] = [];
  if (slug) candidates.push(slug);
  // Fallbacks: exact name, and a lowercased-hyphenated form of the name.
  candidates.push(name, name.toLowerCase());

  // Case-insensitive resolution. existsSync is case-sensitive on Linux (where
  // Dagu/CI may run), so a project whose Source: slug case doesn't match its
  // filename would resolve to null → false P-finding or missed drift. Build a
  // lowercased-basename → real-filename index of Projects/, mirroring how the
  // script's V1 buildLinkIndex resolves wiki-links case-insensitively.
  const projectsDir = resolve(vaultRoot, 'Projects');
  const byLowerBase = new Map<string, string>(); // lowercased basename (no ext) → real filename
  try {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const key = entry.name.slice(0, -3).toLowerCase();
      if (!byLowerBase.has(key)) byLowerBase.set(key, entry.name);
    }
  } catch {
    return { rel: null, abs: null };
  }
  for (const c of candidates) {
    const key = basename(c).replace(/\.md$/i, '').toLowerCase();
    const fileName = byLowerBase.get(key);
    if (fileName) {
      const abs = resolve(projectsDir, fileName);
      return { rel: `Projects/${fileName}`, abs };
    }
  }
  return { rel: null, abs: null };
}

function inferTemplate(
  cards: PhaseCard[],
  explicit: string | null,
): LifecycleTemplate | null {
  if (explicit && TEMPLATES[explicit]) return TEMPLATES[explicit] ?? null;
  const phases = [...new Set(cards.map(c => c.phase))];
  if (phases.length === 0) return null;
  // Collect the templates each observed phase could belong to; the project's
  // template is the one ALL phases agree on. `verify` is shared by both
  // templates, so a project also carrying `scope`/`build` (or `frame`/`gather`)
  // resolves unambiguously; a project with ONLY `verify` stays ambiguous → null.
  let candidates: Set<string> | null = null;
  for (const phase of phases) {
    const owners = PHASE_OWNERS[phase];
    if (!owners) return null; // an unknown phase → no template
    const owned = new Set<string>(owners);
    candidates =
      candidates === null
        ? owned
        : new Set<string>([...candidates].filter((t: string) => owned.has(t)));
  }
  if (!candidates || candidates.size !== 1) return null;
  const [name] = [...candidates];
  return name ? TEMPLATES[name] ?? null : null;
}

// Load one project from its <Name>_tasks folder.
export function loadProject(vaultRoot: string, name: string): ProjectModel {
  const taskDir = resolve(vaultRoot, '_taskboard', `${name}_tasks`);
  const cards: PhaseCard[] = [];
  let projectId: string | null = null;
  let explicitLifecycle: string | null = null;

  if (existsSync(taskDir)) {
    for (const entry of readdirSync(taskDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const abs = resolve(taskDir, entry.name);
      const { fm } = splitNote(readFileSync(abs, 'utf8'));
      if (!fm?.['pm-task']) continue;
      const phase = phaseTag(fm);
      if (!projectId && fm.projectId) projectId = String(fm.projectId);
      if (!explicitLifecycle && fm.lifecycle) explicitLifecycle = String(fm.lifecycle);
      if (!phase) continue;
      cards.push({
        phase,
        status: taskStatus(fm),
        start: parseDate(fm.start),
        fm,
        cardRel: `_taskboard/${name}_tasks/${entry.name}`,
      });
    }
  }

  const template = inferTemplate(cards, explicitLifecycle);
  const { rel: noteRel, abs: noteAbs } = resolveProjectNote(vaultRoot, name);
  const boardCardAbs = resolve(vaultRoot, '_taskboard', `${name}.md`);
  const boardCardRel = existsSync(boardCardAbs) ? `_taskboard/${name}.md` : null;

  let projectStatus = '';
  if (noteAbs) {
    const { fm } = splitNote(readFileSync(noteAbs, 'utf8'));
    projectStatus = String(fm?.status ?? '').trim().toLowerCase();
  }

  const exempt =
    CATCHALL_PROJECTS.has(name) || EXEMPT_PROJECT_STATUSES.has(projectStatus);

  return {
    name,
    taskDir,
    cards,
    template,
    explicitLifecycle,
    noteRel,
    noteAbs,
    boardCardRel,
    projectId,
    projectStatus,
    exempt,
  };
}

// Enumerate every project (one per <Name>_tasks folder) in a vault.
export function listProjects(vaultRoot: string): ProjectModel[] {
  const boardDir = resolve(vaultRoot, '_taskboard');
  if (!existsSync(boardDir)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(boardDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith('_tasks')) {
      names.push(entry.name.slice(0, -'_tasks'.length));
    }
  }
  return names.map(n => loadProject(vaultRoot, n));
}

// ---------------------------------------------------------------------------
// Artifact existence + freshness checks (the behavioral heart of the gate).
// Each returns { ok, detail } — ok=false means the required artifact is missing
// or stale (older than the phase `start`).
// ---------------------------------------------------------------------------

export interface ArtifactResult {
  ok: boolean;
  detail: string;
  artifactPath?: string; // the vault-relative artifact that satisfied/failed
}

// A section is "real content" if the note has a heading matching one of the
// hint patterns AND that section has >MIN_CHARS of non-heading prose.
const MIN_SECTION_CHARS = 40;

function sectionBody(body: string, headingPatterns: RegExp[]): string | null {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const h = line.match(/^#{1,6}\s+(.+)$/);
    if (!h || !h[1]) continue;
    const heading = h[1];
    if (!headingPatterns.some(p => p.test(heading))) continue;
    // Track the matched heading's level so we only break on same-or-higher
    // headings (e.g. ### sub-headings under ## Plan are PART of the section).
    const headingLevel = (h[0]?.match(/^#+/) ?? [''])[0]?.length ?? 0;
    const collected: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? '';
      const nextH = l.match(/^#{1,6}\s+/);
      if (nextH && (nextH[0]?.length ?? 0) <= headingLevel) break;
      collected.push(l);
    }
    return collected.join('\n').trim();
  }
  return null;
}

// Freshness (newer-than-start) check, shared by the file-based artifacts.
//
// V4 (buildBoardCardIndex) explicitly REJECTED file mtime as a timestamp: mtime
// resets to checkout time on git clone/sync, which fabricates a stale timestamp
// and produces false negatives. So we do NOT trust statSync().mtimeMs here.
//
// Instead we prefer a RELIABLE timestamp carried in the artifact note's
// frontmatter (last_updated / updated / date / updatedAt). If a reliable
// timestamp exists, we compare it to `start`. If none exists, freshness is
// un-assessable — we fall back to an EXISTENCE-only check (the caller already
// established the file exists, so we return true) rather than trusting mtime.
function frontmatterDate(absPath: string): Date | null {
  try {
    const { fm } = splitNote(readFileSync(absPath, 'utf8'));
    if (!fm) return null;
    for (const key of ['last_updated', 'updated', 'updatedAt', 'date']) {
      const d = parseDate(fm[key]);
      if (d) return d;
    }
  } catch {
    /* unreadable → no reliable timestamp */
  }
  return null;
}

function newerThanStart(absPath: string, start: Date | null): boolean {
  if (!start) return true; // no start recorded → don't fail on freshness
  const fmDate = frontmatterDate(absPath);
  if (fmDate) return fmDate.getTime() >= start.getTime();
  // No reliable timestamp available. Do NOT fall back to mtime (V4's decision).
  // Existence-only: if the file is readable it counts as satisfying freshness.
  try {
    statSync(absPath);
    return true;
  } catch {
    return false;
  }
}

function checkScopeNote(project: ProjectModel, start: Date | null): ArtifactResult {
  if (!project.noteAbs) {
    return { ok: false, detail: 'no Projects/<name>.md note resolvable from the board card' };
  }
  const raw = readFileSync(project.noteAbs, 'utf8');
  const { body } = splitNote(raw);
  const problem = sectionBody(body, [/problem/i, /intent/i]);
  const approach = sectionBody(body, [/approach/i, /solution/i, /design/i, /what.?s built/i, /plan/i]);
  const hasProblem = !!problem && problem.length >= MIN_SECTION_CHARS;
  const hasApproach = !!approach && approach.length >= MIN_SECTION_CHARS;
  if (!hasProblem || !hasApproach) {
    const missing = [!hasProblem && 'Problem', !hasApproach && 'Approach'].filter(Boolean).join(' + ');
    return {
      ok: false,
      detail: `project note ${project.noteRel} missing non-empty ${missing} section(s)`,
      artifactPath: project.noteRel ?? undefined,
    };
  }
  if (!newerThanStart(project.noteAbs, start)) {
    return {
      ok: false,
      detail: `project note ${project.noteRel} is older than the phase start`,
      artifactPath: project.noteRel ?? undefined,
    };
  }
  return { ok: true, detail: `project note has Problem + Approach`, artifactPath: project.noteRel ?? undefined };
}

function checkPlanBlock(
  vaultRoot: string,
  project: ProjectModel,
  start: Date | null,
): ArtifactResult {
  // A plan block = Goal + Tasks + Open decisions, either in the note's own
  // ## Plan SECTION OR a Plans/<name>.md file (the /plan skill's output).
  //
  // We deliberately do NOT grep the whole note body for the substrings
  // goal/task/decision: `task` matches "## Task Board" (present in every
  // scaffolded note) and `decision` matches any prose, so the old check passed
  // plan-less notes. Instead we scope to the actual ## Plan section (or the
  // Plans/ file) and require Goal + Tasks + Open-decisions to appear as real
  // headings or labeled lines WITHIN that scope.
  const sources: { label: string; body: string; abs: string }[] = [];
  if (project.noteAbs) {
    const { body } = splitNote(readFileSync(project.noteAbs, 'utf8'));
    // Only the ## Plan section — never the whole body (avoids "Task Board" etc.).
    const planSection = sectionBody(body, [/^plan$/i, /^plan\b/i]);
    if (planSection) sources.push({ label: `${project.noteRel} ## Plan`, body: planSection, abs: project.noteAbs });
  }
  if (project.noteRel) {
    const slug = basename(project.noteRel).replace(/\.md$/, '');
    const planAbs = resolve(vaultRoot, 'Plans', `${slug}.md`);
    if (existsSync(planAbs)) {
      const { body } = splitNote(readFileSync(planAbs, 'utf8'));
      sources.push({ label: `Plans/${slug}.md`, body, abs: planAbs });
    }
  }
  // A label is a heading (### Goal), or a labeled line (Goal: … / **Goal** …,
  // or a "- Goal:" list item). Anchored so it can't match a word mid-prose.
  const hasLabel = (body: string, ...words: string[]): boolean => {
    const alt = words.join('|');
    const re = new RegExp(
      `^\\s*(?:#{1,6}\\s+|[-*]\\s+)?(?:\\*\\*)?\\s*(?:${alt})(?:\\*\\*)?\\s*[:：]?\\s*$` + // heading / bare label line
        `|^\\s*(?:[-*]\\s+)?(?:\\*\\*)?\\s*(?:${alt})(?:\\*\\*)?\\s*[:：]\\s+\\S`, // labeled line with inline content
      'im',
    );
    return re.test(body);
  };
  for (const s of sources) {
    const hasGoal = hasLabel(s.body, 'goal', 'goals');
    const hasTasks = hasLabel(s.body, 'task', 'tasks');
    const hasDecisions = hasLabel(s.body, 'open decision', 'open decisions', 'decision', 'decisions');
    if (hasGoal && hasTasks && hasDecisions && newerThanStart(s.abs, start)) {
      return { ok: true, detail: `plan block found in ${s.label}`, artifactPath: project.noteRel ?? undefined };
    }
  }
  return {
    ok: false,
    detail: `no plan block (Goal + Tasks + Open decisions) found in ${project.noteRel ?? 'note'} ## Plan section or Plans/`,
    artifactPath: project.noteRel ?? undefined,
  };
}

// Does an agent-log entry mention this project as created/built?
function agentLogHasBuildEntry(vaultRoot: string, project: ProjectModel): boolean {
  const logAbs = resolve(vaultRoot, 'Meta', 'agent-log.md');
  if (!existsSync(logAbs)) return false;
  const log = readFileSync(logAbs, 'utf8');
  const slug = project.noteRel ? basename(project.noteRel).replace(/\.md$/, '') : project.name;
  const re = new RegExp(
    `(created|built|shipped|delivered|implemented)[^\\n]*\\[\\[(${escapeRe(slug)}|${escapeRe(project.name)})`,
    'i',
  );
  return re.test(log);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkBuildDeliverable(
  vaultRoot: string,
  project: ProjectModel,
  start: Date | null,
): ArtifactResult {
  // ≥1 real deliverable the note points to that exists on disk, OR an agent-log
  // "created/built" entry linking this project.
  if (project.noteAbs) {
    const raw = readFileSync(project.noteAbs, 'utf8');
    // Resolve wiki-linked notes the project points at (that aren't itself/board).
    const selfSlug = basename(project.noteRel ?? '').replace(/\.md$/, '').toLowerCase();
    for (const m of raw.matchAll(/\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
      const target = (m[1] ?? '').trim();
      if (!target || target.toLowerCase() === selfSlug || target === project.name) continue;
      if (linkResolvesInVault(vaultRoot, target)) {
        return { ok: true, detail: `deliverable link [[${target}]] resolves on disk`, artifactPath: `[[${target}]]` };
      }
    }
    // Explicit disk paths referenced in the note (src/**, scripts/**, etc.).
    for (const m of raw.matchAll(/`((?:src|scripts|crew|vault)\/[^`\n]+)`/g)) {
      const diskPath = m[1];
      if (!diskPath) continue;
      const repoRoot = resolve(vaultRoot, '..');
      if (existsSync(resolve(repoRoot, diskPath))) {
        return { ok: true, detail: `deliverable path ${diskPath} exists on disk`, artifactPath: diskPath };
      }
    }
  }
  if (agentLogHasBuildEntry(vaultRoot, project)) {
    return { ok: true, detail: `agent-log has a created/built entry linking the project` };
  }
  void start;
  return {
    ok: false,
    detail: `no resolvable deliverable and no agent-log build entry links ${project.name}`,
    artifactPath: project.noteRel ?? undefined,
  };
}

function linkResolvesInVault(vaultRoot: string, target: string): boolean {
  // Cheap resolver: does a .md file with this basename exist anywhere in the vault?
  const wanted = basename(target).toLowerCase().replace(/\.md$/, '');
  const found = { hit: false };
  walk(vaultRoot, f => {
    if (found.hit) return;
    if (basename(f).toLowerCase().replace(/\.md$/, '') === wanted) found.hit = true;
  });
  return found.hit;
}

function walk(dir: string, fn: (file: string) => void): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = resolve(dir, e.name);
    if (e.isDirectory()) walk(full, fn);
    else if (e.isFile()) fn(full);
  }
}

function checkVerifyRecord(
  vaultRoot: string,
  project: ProjectModel,
  start: Date | null,
): ArtifactResult {
  // A verification record per verification-standard: a Meta/reviews/* doc, or an
  // agent-log verification entry, that links this project.
  const slug = project.noteRel ? basename(project.noteRel).replace(/\.md$/, '') : project.name;
  const reviewsDir = resolve(vaultRoot, 'Meta', 'reviews');
  if (existsSync(reviewsDir)) {
    for (const entry of readdirSync(reviewsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const abs = resolve(reviewsDir, entry.name);
      const raw = readFileSync(abs, 'utf8');
      const links =
        raw.includes(`[[${slug}`) || raw.includes(`[[${project.name}`) || raw.toLowerCase().includes(slug.toLowerCase());
      if (links && newerThanStart(abs, start)) {
        return { ok: true, detail: `verification record Meta/reviews/${entry.name} links the project`, artifactPath: `Meta/reviews/${entry.name}` };
      }
    }
  }
  // agent-log verification entry.
  const logAbs = resolve(vaultRoot, 'Meta', 'agent-log.md');
  if (existsSync(logAbs)) {
    const log = readFileSync(logAbs, 'utf8');
    const re = new RegExp(`verif[^\\n]*\\[\\[(${escapeRe(slug)}|${escapeRe(project.name)})`, 'i');
    if (re.test(log)) {
      return { ok: true, detail: `agent-log has a verification entry linking the project` };
    }
  }
  return {
    ok: false,
    detail: `no verification record (Meta/reviews/* or agent-log entry) links ${project.name}`,
    artifactPath: project.noteRel ?? undefined,
  };
}

// research-template artifacts. These reuse the note-section machinery: the
// research note carries the question/scope/criteria (frame) and cited
// findings/synthesis sections.
function checkFrameNote(project: ProjectModel, start: Date | null): ArtifactResult {
  if (!project.noteAbs) return { ok: false, detail: 'no research note resolvable from the board card' };
  const { body } = splitNote(readFileSync(project.noteAbs, 'utf8'));
  const question = sectionBody(body, [/question/i, /problem/i, /frame/i]);
  const scope = sectionBody(body, [/scope/i, /success/i, /criteria/i, /approach/i]);
  const ok = !!question && question.length >= MIN_SECTION_CHARS && !!scope && scope.length >= MIN_SECTION_CHARS;
  if (ok && newerThanStart(project.noteAbs, start)) {
    return { ok: true, detail: 'research note states the question + scope/criteria', artifactPath: project.noteRel ?? undefined };
  }
  return {
    ok: false,
    detail: `research note ${project.noteRel} missing a framed question + scope/success-criteria`,
    artifactPath: project.noteRel ?? undefined,
  };
}

function checkGatherSources(vaultRoot: string, project: ProjectModel, start: Date | null): ArtifactResult {
  // A findings/sources note with cited material linked to the project. Accept a
  // note in Research/ or Knowledge/ that links the project, or a note-body
  // Sources/Findings section with citations.
  if (project.noteAbs) {
    const { body } = splitNote(readFileSync(project.noteAbs, 'utf8'));
    const sources = sectionBody(body, [/sources/i, /findings/i, /evidence/i, /gather/i]);
    if (sources && /https?:\/\/|\[\[/.test(sources) && newerThanStart(project.noteAbs, start)) {
      return { ok: true, detail: 'note has a Sources/Findings section with cited material', artifactPath: project.noteRel ?? undefined };
    }
  }
  const slug = project.noteRel ? basename(project.noteRel).replace(/\.md$/, '') : project.name;
  for (const sub of ['Research', 'Knowledge']) {
    const dir = resolve(vaultRoot, sub);
    if (!existsSync(dir)) continue;
    let hit: string | null = null;
    walk(dir, f => {
      if (hit) return;
      const raw = readFileSync(f, 'utf8');
      if ((raw.includes(`[[${slug}`) || raw.includes(`[[${project.name}`)) && /https?:\/\/|\[\[/.test(raw)) {
        hit = f;
      }
    });
    if (hit) {
      return { ok: true, detail: `findings/sources note in ${sub}/ links the project`, artifactPath: basename(hit) };
    }
  }
  return {
    ok: false,
    detail: `no findings/sources note with cited material links ${project.name}`,
    artifactPath: project.noteRel ?? undefined,
  };
}

function checkSynthesizeNote(project: ProjectModel, start: Date | null): ArtifactResult {
  if (!project.noteAbs) return { ok: false, detail: 'no research note resolvable from the board card' };
  const { body } = splitNote(readFileSync(project.noteAbs, 'utf8'));
  const synthesis = sectionBody(body, [/synthesis/i, /dossier/i, /answer/i, /conclusion/i]);
  // Confidence tags per the Research skill: [HIGH]/[MED]/[LOW]/[CONFLICT].
  const hasTags = /\[(HIGH|MED|LOW|CONFLICT)\]/.test(body);
  if (synthesis && synthesis.length >= MIN_SECTION_CHARS && hasTags && newerThanStart(project.noteAbs, start)) {
    return { ok: true, detail: 'synthesis note with confidence-tagged claims present', artifactPath: project.noteRel ?? undefined };
  }
  return {
    ok: false,
    detail: `research note ${project.noteRel} missing a synthesis section with confidence tags ([HIGH]/[MED]/[LOW]/[CONFLICT])`,
    artifactPath: project.noteRel ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Bug-fix lifecycle artifact checks
// ---------------------------------------------------------------------------

function checkReproduceReport(project: ProjectModel, start: Date | null): ArtifactResult {
  if (!project.noteAbs) return { ok: false, detail: 'no project note resolvable for reproduce check' };
  const { body } = splitNote(readFileSync(project.noteAbs, 'utf8'));
  const steps = sectionBody(body, [/repro/i, /steps to repro/i, /reproduce/i]);
  const observed = /observed|actual|behavior|symptoms|error|stack/i.test(body);
  const ok =
    !!steps &&
    steps.length >= MIN_SECTION_CHARS &&
    observed &&
    newerThanStart(project.noteAbs, start);
  return ok
    ? { ok: true, detail: 'reproduction report with steps + observed behavior', artifactPath: project.noteRel ?? undefined }
    : {
        ok: false,
        detail: `note ${project.noteRel} missing reproduction steps + observed behavior`,
        artifactPath: project.noteRel ?? undefined,
      };
}

function checkDiagnoseNote(vaultRoot: string, project: ProjectModel, start: Date | null): ArtifactResult {
  // Accept a root-cause note in Meta/ or an RCA section in the project note.
  const slug = project.noteRel ? basename(project.noteRel).replace(/\.md$/, '') : project.name;
  const rcaCandidates: string[] = [];
  const metaDir = resolve(vaultRoot, 'Meta');
  if (existsSync(metaDir)) {
    walk(metaDir, f => {
      if (!f.endsWith('.md')) return;
      const raw = readFileSync(f, 'utf8');
      if (raw.toLowerCase().includes('rca') || raw.toLowerCase().includes('root cause')) {
        const links =
          raw.includes(`[[${slug}`) ||
          raw.includes(`[[${project.name}`) ||
          raw.toLowerCase().includes(slug.toLowerCase());
        if (links) rcaCandidates.push(f);
      }
    });
  }
  for (const abs of rcaCandidates) {
    if (newerThanStart(abs, start)) {
      return { ok: true, detail: `RCA/diagnose note in Meta/ links the project`, artifactPath: basename(abs) };
    }
  }
  // Fall back to project note has root cause section.
  if (project.noteAbs) {
    const { body } = splitNote(readFileSync(project.noteAbs, 'utf8'));
    const rca = sectionBody(body, [/root cause/i, /diagnosis/i, /diagnose/i, /why/i]);
    if (rca && rca.length >= MIN_SECTION_CHARS && newerThanStart(project.noteAbs, start)) {
      return { ok: true, detail: 'project note has a root cause section', artifactPath: project.noteRel ?? undefined };
    }
  }
  return {
    ok: false,
    detail: `no RCA/diagnose note linking ${project.name} and no root cause section in ${project.noteRel ?? 'note'}`,
    artifactPath: project.noteRel ?? undefined,
  };
}

function checkFixDeliverable(vaultRoot: string, project: ProjectModel, start: Date | null): ArtifactResult {
  // A deploy note, PR link, or commit reference the project note links to.
  if (project.noteAbs) {
    const raw = readFileSync(project.noteAbs, 'utf8');
    // Links to Meta/fixes/ or a github PR / commit.
    for (const m of raw.matchAll(/\[\[([^\]|#]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
      const target = (m[1] ?? '').trim();
      if (!target) continue;
      if (linkResolvesInVault(vaultRoot, target) && newerThanStart(project.noteAbs, start)) {
        return { ok: true, detail: `fix deliverable [[${target}]] resolves on disk`, artifactPath: `[[${target}]]` };
      }
    }
    // PR/commit URLs.
    if (/(https?:\/\/(?:github\.com|gitlab\.com)\/[^\s]+\/(?:pull|commit)\/[^\s]+)/.test(raw)) {
      return { ok: true, detail: 'fix link (PR/commit URL) referenced in note', artifactPath: project.noteRel ?? undefined };
    }
  }
  return {
    ok: false,
    detail: `no fix deliverable (PR link, commit, or fix note) referenced in ${project.noteRel ?? 'note'}`,
    artifactPath: project.noteRel ?? undefined,
  };
}

// Dispatch: run the check for a given artifact kind.
export function checkArtifact(
  vaultRoot: string,
  project: ProjectModel,
  kind: PhaseArtifactKind,
  start: Date | null,
): ArtifactResult {
  switch (kind) {
    case 'scope-note':
      return checkScopeNote(project, start);
    case 'plan-block':
      return checkPlanBlock(vaultRoot, project, start);
    case 'build-deliverable':
      return checkBuildDeliverable(vaultRoot, project, start);
    case 'verify-record':
      return checkVerifyRecord(vaultRoot, project, start);
    case 'frame-note':
      return checkFrameNote(project, start);
    case 'gather-sources':
      return checkGatherSources(vaultRoot, project, start);
    case 'synthesize-note':
      return checkSynthesizeNote(project, start);
    case 'reproduce-report':
      return checkReproduceReport(project, start);
    case 'diagnose-note':
      return checkDiagnoseNote(vaultRoot, project, start);
    case 'fix-deliverable':
      return checkFixDeliverable(vaultRoot, project, start);
  }
}

export function isDoneStatus(status: string): boolean {
  return DONE_STATUSES.has(status.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// The P-check driver, shared by the poll and the gate.
// For a project, walk each template phase; for every card of that phase that
// reads `done`, run the phase's artifact check. A failure = drift.
// P-id is derived from the phase's POSITION in the template (0→P1 … 3→P4).
// ---------------------------------------------------------------------------

export interface PhaseFinding {
  pid: string; // "P1".."P4"
  project: string;
  phase: string;
  cardRel: string;
  detail: string;
}

export function checkProjectPhases(vaultRoot: string, project: ProjectModel): PhaseFinding[] {
  const findings: PhaseFinding[] = [];
  if (project.exempt || !project.template) return findings;

  project.template.phases.forEach((spec, index) => {
    const pid = `P${index + 1}`;
    for (const card of project.cards) {
      if (card.phase !== spec.phase) continue;
      if (!isDoneStatus(card.status)) continue;
      const result = checkArtifact(vaultRoot, project, spec.artifact, card.start);
      if (!result.ok) {
        findings.push({
          pid,
          project: project.name,
          phase: spec.phase,
          cardRel: card.cardRel,
          detail: result.detail,
        });
      }
    }
  });
  return findings;
}
