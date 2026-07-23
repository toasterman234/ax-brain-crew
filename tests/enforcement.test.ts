/**
 * Enforcement suite — Layer 3B code guards (C1-C3) + Verification Suite.
 *
 * Ports the ax-llm enforcement pattern per
 * vault/Projects/issues-learnings-enforcement.md (v3 design):
 *   - C1/C2: behavioral guards (call the real tool on a real directory)
 *   - C3: content check (onboarding pre-guard is prose + CLI wiring)
 *   - Learnings consistency, guard traceability, and poll behavior checks.
 *
 * The Dagu poll script (scripts/check-vault-enforcement.ts) is built in
 * parallel by another agent — poll/V-check tests skip gracefully if absent.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setVaultRoot } from '../src/tools/vault-path.js';
import { vaultRead } from '../src/tools/vault-read.js';
import { vaultWrite } from '../src/tools/vault-write.js';
import {
  loadProject,
  listProjects,
  checkProjectPhases,
} from '../src/tools/phase-gate-core.js';
import { checkPhaseGate } from '../src/tools/phase-gate.js';
import { checkArtifact } from '../src/tools/phase-gate-core.js';
import { TOOL_REGISTRY } from '../src/tools/index.js';
import { buildAgentTools } from '../src/agents/factory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const VAULT_DIR = join(REPO_ROOT, 'vault');
const LEARNINGS_PATH = join(VAULT_DIR, 'Meta', 'LEARNINGS.md');
const INCIDENTS_DIR = join(VAULT_DIR, 'Meta', 'incidents');
const ONBOARDING_SKILL = join(REPO_ROOT, 'crew', 'skills', 'onboarding.md');
const CLI_MAIN = join(REPO_ROOT, 'src', 'cli', 'main.ts');
const ONBOARDING_STATE = join(REPO_ROOT, 'src', 'onboarding', 'state.ts');
const ENFORCEMENT_SCRIPT = join(REPO_ROOT, 'scripts', 'check-vault-enforcement.ts');
const SHA_STATE_FILE = join(REPO_ROOT, 'data', 'enforcement-last-sha.txt');
const THIS_TEST_FILE = join(REPO_ROOT, 'tests', 'enforcement.test.ts');

// The poll script is being built in parallel (deliverable 3a) — skip poll/V
// tests gracefully when it doesn't exist yet so this suite passes standalone.
const scriptExists = existsSync(ENFORCEMENT_SCRIPT);

// ---------------------------------------------------------------------------
// C1/C2 fixture: a real temp vault containing a real directory, so the guards
// are exercised behaviorally (not via string-grepping the tool source).
// ---------------------------------------------------------------------------

describe('enforcement code guards (C1-C3)', () => {
  let tempVault: string;

  beforeEach(() => {
    tempVault = mkdtempSync(join(tmpdir(), 'enforcement-vault-'));
    // A directory that an agent might mistake for a note (incident-002 shape).
    mkdirSync(join(tempVault, 'Inbox', 'braindump-2026-07-19'), { recursive: true });
    writeFileSync(
      join(tempVault, 'Inbox', 'braindump-2026-07-19', 'memphis-business.md'),
      '# Memphis business\n\nNote inside a directory.\n',
    );
    setVaultRoot(tempVault);
  });

  afterEach(() => {
    rmSync(tempVault, { recursive: true, force: true });
  });

  // From incident-002
  it('C1: vaultRead on a directory returns a structured "Path is a directory" error, not raw EISDIR', () => {
    let caught: unknown;
    try {
      vaultRead({ path: 'Inbox/braindump-2026-07-19' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    // Structured, actionable guidance — the guard message from the fix.
    expect(message).toContain('Path is a directory');
    expect(message).toContain('vaultList');
    // NOT the raw OS error the model saw during the incident.
    expect(message).not.toContain('illegal operation on a directory');
  });

  // From incident-002
  it('C2: vaultWrite to a directory returns a structured error and writes nothing', () => {
    const dirPath = join(tempVault, 'Inbox', 'braindump-2026-07-19');
    const entriesBefore = readdirSync(dirPath).sort();

    const result = vaultWrite({
      path: 'Inbox/braindump-2026-07-19',
      content: '# should never be written\n',
    });

    // Structured skip — not the misleading "File already exists" from the incident.
    expect(result.operation).toBe('skipped');
    expect(result.reason).toContain('Path is a directory');
    expect(result.reason).not.toContain('File already exists');

    // Nothing was written: the path is still a directory with the same contents.
    expect(statSync(dirPath).isDirectory()).toBe(true);
    expect(readdirSync(dirPath).sort()).toEqual(entriesBefore);
  });

  // From incident-001
  it('C3: onboarding skill instructions contain the vault-initialization pre-guard', () => {
    const skill = readFileSync(ONBOARDING_SKILL, 'utf-8');

    // The prose guard added as the incident-001 fix (crew/skills/onboarding.md).
    expect(skill).toContain('Vault Initialization Guard');
    expect(skill).toContain('vaultRead("AGENTS.md")');
    expect(skill).toContain('vaultList("")');
    expect(skill).toMatch(/STOP immediately/i);

    // The programmatic isVaultInitialized() guard is wired into the CLI level.
    const cliMain = readFileSync(CLI_MAIN, 'utf-8');
    expect(cliMain).toContain('isVaultInitialized');
    const state = readFileSync(ONBOARDING_STATE, 'utf-8');
    expect(state).toContain('export function isVaultInitialized');
  });
});

// ---------------------------------------------------------------------------
// Verification: learnings consistency
// ---------------------------------------------------------------------------

describe('learnings consistency (Meta/LEARNINGS.md)', () => {
  it('every lesson has a valid [[incident-...]] link that resolves to Meta/incidents/', () => {
    const learnings = readFileSync(LEARNINGS_PATH, 'utf-8');
    const lessons = learnings.split(/^## (?=L-\d{3})/m).slice(1);
    expect(lessons.length).toBeGreaterThanOrEqual(2);

    for (const lesson of lessons) {
      const id = lesson.slice(0, 5); // e.g. "L-001"
      const incidentLinks = [...lesson.matchAll(/\[\[(incident-\d{3}[^\]|#]*?)(?:\|[^\]]*)?\]\]/g)];
      expect(incidentLinks.length, `${id} must link at least one incident`).toBeGreaterThanOrEqual(1);

      for (const [, linkTarget] of incidentLinks) {
        const incidentFile = join(INCIDENTS_DIR, `${linkTarget}.md`);
        expect(
          existsSync(incidentFile),
          `${id}: [[${linkTarget}]] must resolve to a file in vault/Meta/incidents/`,
        ).toBe(true);
      }
    }
  });

  it('every lesson has a Guard reference', () => {
    const learnings = readFileSync(LEARNINGS_PATH, 'utf-8');
    const lessons = learnings.split(/^## (?=L-\d{3})/m).slice(1);

    for (const lesson of lessons) {
      const id = lesson.slice(0, 5);
      expect(lesson, `${id} must have a **Guard:** line`).toMatch(/\*\*Guard:\*\*\s*\S/);
    }
  });
});

// ---------------------------------------------------------------------------
// Verification: guard → incident traceability
// ---------------------------------------------------------------------------

describe('guard traceability', () => {
  it('every C-guard test in this file has a "// From incident-NNN" comment', () => {
    const source = readFileSync(THIS_TEST_FILE, 'utf-8');

    for (const guardId of ['C1', 'C2', 'C3']) {
      const testIndex = source.indexOf(`'${guardId}:`);
      expect(testIndex, `${guardId} test must exist in this file`).toBeGreaterThan(-1);

      // The traceability comment must sit immediately above the test.
      const preceding = source.slice(Math.max(0, testIndex - 300), testIndex);
      expect(
        /\/\/ From incident-\d{3}/.test(preceding),
        `${guardId} test must have a "// From incident-NNN" comment above it`,
      ).toBe(true);
    }
  });

  it.skipIf(!scriptExists)(
    'every V-check in scripts/check-vault-enforcement.ts has a traceability comment',
    () => {
      const script = readFileSync(ENFORCEMENT_SCRIPT, 'utf-8');

      for (const checkId of ['V1', 'V2', 'V3', 'V4']) {
        expect(
          new RegExp(`\\b${checkId}\\b`).test(script),
          `${checkId} check must exist in the script`,
        ).toBe(true);

        // Traceability: each V-check carries a provenance comment — either an
        // incident reference ("// From incident-NNN") or, for hygiene checks
        // that predate any incident, a "// V{N} — <what/why>" banner.
        const hasIncidentRef = new RegExp(
          `\\/\\/[^\\n]*${checkId}[^\\n]*(?:\\n\\/\\/[^\\n]*)*From incident-\\d{3}`,
        ).test(script);
        const hasBanner = new RegExp(`\\/\\/ ${checkId} — `).test(script);
        expect(
          hasIncidentRef || hasBanner,
          `${checkId} must have a traceability comment ("// From incident-NNN" or "// ${checkId} — ..." banner)`,
        ).toBe(true);
      }
    },
  );

  it.skipIf(!scriptExists)(
    'every P-check in scripts/check-vault-enforcement.ts has a pm-lifecycle-enforcement banner',
    () => {
      const script = readFileSync(ENFORCEMENT_SCRIPT, 'utf-8');

      for (const checkId of ['P1', 'P2', 'P3', 'P4']) {
        expect(
          new RegExp(`\\b${checkId}\\b`).test(script),
          `${checkId} check must exist in the script`,
        ).toBe(true);

        // P-checks are the phase-gate half — provenance is the spec note, not an
        // incident: a "// P{N} — <what/why> ... pm-lifecycle-enforcement" banner.
        const hasBanner = new RegExp(
          `\\/\\/ ${checkId} — [^\\n]*pm-lifecycle-enforcement`,
        ).test(script);
        expect(
          hasBanner,
          `${checkId} must have a "// ${checkId} — ... pm-lifecycle-enforcement" traceability banner`,
        ).toBe(true);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Verification: poll behavior (skipped until scripts/check-vault-enforcement.ts
// lands — it is being built in parallel as deliverable 3a).
// ---------------------------------------------------------------------------

// Spec'd CLI is `npx tsx scripts/check-vault-enforcement.ts --poll`; invoking
// tsx's entry point via the current node binary is the same thing without
// npx's PATH resolution (which is flaky under the test sandbox).
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function runPoll(): string {
  return execFileSync(process.execPath, [TSX_CLI, ENFORCEMENT_SCRIPT, '--poll'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 90_000,
  });
}

// The vault is a LIVE repo: obsidian-git auto-commits every ~2 min while
// tests run. Two consequences for these tests:
//   1. If HEAD moves mid-test, "same HEAD → no-op" can't be asserted — skip.
//   2. When the changed files have findings, the poll legitimately writes
//      Meta/enforcement-report-YYYY-MM-DD.md (design's error path), so the
//      "writes nothing" assertion excludes that one design-allowed artifact.
function vaultGitStatus(): string {
  const raw = execFileSync('git', ['-C', VAULT_DIR, 'status', '--porcelain'], {
    encoding: 'utf-8',
  });
  return raw
    .split('\n')
    .filter((line) => line && !line.includes('Meta/enforcement-report-'))
    .sort()
    .join('\n');
}

function vaultHead(): string {
  return execFileSync('git', ['-C', VAULT_DIR, 'rev-parse', 'HEAD'], {
    encoding: 'utf-8',
  }).trim();
}

describe.skipIf(!scriptExists)('enforcement poll (--poll)', () => {
  // The tests run the real poll, which touches the real SHA state file used by
  // the Dagu DAG — save and restore it so tests don't disturb live state.
  let savedSha: string | null = null;

  beforeAll(() => {
    savedSha = existsSync(SHA_STATE_FILE) ? readFileSync(SHA_STATE_FILE, 'utf-8') : null;
  });

  afterAll(() => {
    if (savedSha !== null) {
      writeFileSync(SHA_STATE_FILE, savedSha);
    } else if (existsSync(SHA_STATE_FILE)) {
      rmSync(SHA_STATE_FILE);
    }
  });

  it('poll is idempotent: second run with same HEAD is a no-op', { timeout: 200_000 }, (ctx) => {
    const headBefore = vaultHead();
    runPoll();
    expect(existsSync(SHA_STATE_FILE), 'poll must record SHA in data/enforcement-last-sha.txt').toBe(
      true,
    );
    const shaAfterFirst = readFileSync(SHA_STATE_FILE, 'utf-8').trim();

    const statusBetween = vaultGitStatus();
    runPoll();
    const shaAfterSecond = readFileSync(SHA_STATE_FILE, 'utf-8').trim();

    if (vaultHead() !== headBefore) {
      // obsidian-git committed mid-test — "same HEAD" precondition broke.
      ctx.skip();
      return;
    }

    // Same HEAD → same recorded SHA, and no new changes appeared in the vault.
    expect(shaAfterSecond).toBe(shaAfterFirst);
    expect(vaultGitStatus()).toBe(statusBetween);
  });

  it('poll writes nothing inside the vault (SHA state lives in data/)', { timeout: 200_000 }, (ctx) => {
    const headBefore = vaultHead();
    const statusBefore = vaultGitStatus();
    runPoll();
    const statusAfter = vaultGitStatus();

    if (vaultHead() !== headBefore) {
      // obsidian-git committed mid-test — can't attribute changes to the poll.
      ctx.skip();
      return;
    }

    // No tracked modifications and no new untracked files in the vault repo
    // (Meta/enforcement-report-* is excluded above: it's the design-allowed
    // error-path artifact, not poll state).
    expect(statusAfter).toBe(statusBefore);
    // The state file must be outside the vault (v3 fix: in-vault SHA file
    // would be auto-committed by obsidian-git → infinite poll loop).
    expect(SHA_STATE_FILE.startsWith(VAULT_DIR)).toBe(false);
    expect(existsSync(join(VAULT_DIR, 'Meta', 'enforcement-last-sha.txt'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Verification: V4 board-status drift.
// Runs the real script in --full mode against a throwaway copy of the
// tests/fixtures/enforcement-vault/ fixture, via the ENFORCEMENT_VAULT_ROOT
// override, so the live vault is never touched.
// ---------------------------------------------------------------------------

const FIXTURE_VAULT = join(REPO_ROOT, 'tests', 'fixtures', 'enforcement-vault');

// Run --full against a specific vault root; returns { stdout, exitCode }.
function runFullOnVault(vaultRoot: string): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [TSX_CLI, ENFORCEMENT_SCRIPT, '--full'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 90_000,
      env: { ...process.env, ENFORCEMENT_VAULT_ROOT: vaultRoot },
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { out: String(e.stdout ?? ''), code: e.status ?? 1 };
  }
}

// Overwrite the last_updated frontmatter value of a project note in-place.
function setProjectLastUpdated(vaultRoot: string, noteRel: string, isoDate: string): void {
  const p = join(vaultRoot, noteRel);
  const raw = readFileSync(p, 'utf-8');
  writeFileSync(p, raw.replace(/^last_updated: .*$/m, `last_updated: ${isoDate}`));
}

describe.skipIf(!scriptExists)('V4 board-status drift', () => {
  let tempVault: string;

  beforeEach(() => {
    tempVault = mkdtempSync(join(tmpdir(), 'v4-drift-vault-'));
    cpSync(FIXTURE_VAULT, tempVault, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempVault, { recursive: true, force: true });
  });

  it('V4 fires on drift: project last_updated runs ahead of its board card', () => {
    // Push the drifted project well past its board card's 2026-07-05 updatedAt.
    setProjectLastUpdated(tempVault, 'Projects/drifted-project.md', '2026-07-18');
    const { out } = runFullOnVault(tempVault);

    expect(out).toContain('[V4]');
    expect(out).toContain('Board drift');
    expect(out).toContain('Projects/drifted-project.md');
  });

  it('V4 skips (does not flag) a project whose board card has no updatedAt', () => {
    // Fix 2: a card with no explicit updatedAt is un-assessable — mtime is NOT a
    // trustworthy fallback (it resets on git clone/sync). Even with the project
    // note pushed well ahead, no V4 drift should be reported for that project.
    const cardPath = join(tempVault, '_taskboard', 'Drifted-Project.md');
    writeFileSync(
      cardPath,
      readFileSync(cardPath, 'utf-8').replace(/^updatedAt: .*$/m, ''),
    );
    setProjectLastUpdated(tempVault, 'Projects/drifted-project.md', '2026-07-18');
    const { out } = runFullOnVault(tempVault);

    expect(out).not.toContain('Projects/drifted-project.md');
    expect(out).not.toContain('Board drift');
  });

  it('V4 stays quiet when synced: project and board card moved together', () => {
    // Copy: synced-project.md is 2026-07-10, board card updatedAt is 2026-07-10.
    // Make the drifted one synced too so NO V4 finding should appear at all.
    setProjectLastUpdated(tempVault, 'Projects/drifted-project.md', '2026-07-05');
    const { out } = runFullOnVault(tempVault);

    // No V4 *finding* line ("⚠️ [V4] ...") and no drift message. The clean
    // summary legitimately says "V1-V4", so match the finding marker, not "V4".
    expect(out).not.toContain('[V4]');
    expect(out).not.toContain('Board drift');
    expect(out).toContain('clean');
  });
});

// ---------------------------------------------------------------------------
// Surfacing (ADR-004 flag-and-poll): a findings run must mark the report with
// the `status: open` flag that vault/Meta/Enforcement.base filters on (and
// Home.md embeds) — the SAME way `routed != true` surfaces un-routed triage
// items. A clean run writes no report at all, so nothing surfaces.
// ---------------------------------------------------------------------------

describe.skipIf(!scriptExists)('enforcement report surfacing (Enforcement.base)', () => {
  let tempVault: string;

  beforeEach(() => {
    tempVault = mkdtempSync(join(tmpdir(), 'enforcement-surface-vault-'));
    cpSync(FIXTURE_VAULT, tempVault, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempVault, { recursive: true, force: true });
  });

  // The base view that surfaces open reports lives in the REAL vault. Assert its
  // filter predicate stays in sync with the flag the report is stamped with, so
  // renaming one without the other can't silently make reports invisible again.
  it('Enforcement.base filters the report onto Home via type + enforcement tag + status: open', () => {
    const base = readFileSync(join(VAULT_DIR, 'Meta', 'Enforcement.base'), 'utf-8');
    expect(base).toContain('type == "report"');
    expect(base).toContain('file.hasTag("enforcement")');
    expect(base).toContain('status == "open"');

    const home = readFileSync(join(VAULT_DIR, 'Home.md'), 'utf-8');
    expect(home).toContain('Meta/Enforcement.base');
  });

  it('a findings run stamps the report with status: open (the surfacing flag)', () => {
    // Fixture's drifted-project already triggers a V4 finding by default.
    const { out } = runFullOnVault(tempVault);
    expect(out).toContain('[V4]'); // sanity: findings did occur

    const reportPath = join(tempVault, 'Meta', 'enforcement-report-' + today() + '.md');
    expect(existsSync(reportPath)).toBe(true);

    const report = readFileSync(reportPath, 'utf-8');
    expect(report).toContain('status: open'); // the flag Enforcement.base keys on
    expect(report).toContain('type: report');
    expect(report).toMatch(/tags:\s*\n\s*- enforcement/);
    expect(report).toContain('last_result:');
  });

  it('a clean run writes NO report, so nothing surfaces', () => {
    // Sync the drifted project so the run is clean — no findings, no report.
    setProjectLastUpdated(tempVault, 'Projects/drifted-project.md', '2026-07-05');
    const { out } = runFullOnVault(tempVault);
    expect(out).toContain('clean');

    const reportPath = join(tempVault, 'Meta', 'enforcement-report-' + today() + '.md');
    expect(existsSync(reportPath)).toBe(false);
  });
});

// The report filename uses the local ISO date, matching writeReport().
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Phase-gate (pm-lifecycle-enforcement) — DETECT half (P1-P4) + PREVENT half
// (checkPhaseGate). Both run against the dedicated phase-gate-vault fixture,
// which has projects on BOTH lifecycle templates (scope-plan-build-verify and
// research) plus a clean project whose artifacts are all present.
// ---------------------------------------------------------------------------

const PHASE_GATE_VAULT = join(REPO_ROOT, 'tests', 'fixtures', 'phase-gate-vault');

describe('phase-gate template inference (phase/* tags → template)', () => {
  it('infers scope-plan-build-verify from a project carrying scope/build cards', () => {
    const p = loadProject(PHASE_GATE_VAULT, 'Gated-Project');
    expect(p.template?.name).toBe('scope-plan-build-verify');
  });

  it('infers the research template from a project carrying frame/synthesize cards', () => {
    const p = loadProject(PHASE_GATE_VAULT, 'Research-Project');
    expect(p.template?.name).toBe('research');
  });

  it('an explicit `lifecycle` card field overrides tag inference', () => {
    // Clean-Project's tags say scope-plan-build-verify; force research via an
    // explicit field on a throwaway copy and assert the field wins.
    const tmp = mkdtempSync(join(tmpdir(), 'pg-lifecycle-'));
    cpSync(PHASE_GATE_VAULT, tmp, { recursive: true });
    const card = join(tmp, '_taskboard', 'Clean-Project_tasks', 'scope.md');
    writeFileSync(
      card,
      readFileSync(card, 'utf-8').replace(
        'tags: ["phase/scope"]',
        'tags: ["phase/scope"]\nlifecycle: "research"',
      ),
    );
    const p = loadProject(tmp, 'Clean-Project');
    expect(p.template?.name).toBe('research');
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('phase-gate detection (P1-P4)', () => {
  it('fires P3 when a scope-plan-build-verify build phase is done without a deliverable', () => {
    const p = loadProject(PHASE_GATE_VAULT, 'Gated-Project');
    const findings = checkProjectPhases(PHASE_GATE_VAULT, p);
    const p3 = findings.find((f) => f.pid === 'P3' && f.phase === 'build');
    expect(p3, 'P3 must fire for the done-without-deliverable build phase').toBeTruthy();
    expect(p3!.project).toBe('Gated-Project');
  });

  it('fires P3 when a research synthesize phase is done without a tagged synthesis', () => {
    const p = loadProject(PHASE_GATE_VAULT, 'Research-Project');
    const findings = checkProjectPhases(PHASE_GATE_VAULT, p);
    const p3 = findings.find((f) => f.pid === 'P3' && f.phase === 'synthesize');
    expect(p3, 'P3 must fire for the research synthesize phase (position 3)').toBeTruthy();
  });

  it('stays quiet on a project whose every done phase has its artifact', () => {
    const p = loadProject(PHASE_GATE_VAULT, 'Clean-Project');
    expect(checkProjectPhases(PHASE_GATE_VAULT, p)).toEqual([]);
  });

  it('does not flag phases that are not marked done', () => {
    // Gated-Project's scope IS done (and passes P1); its verify is absent. Only
    // the done-without-artifact build should produce a finding — nothing else.
    const p = loadProject(PHASE_GATE_VAULT, 'Gated-Project');
    const findings = checkProjectPhases(PHASE_GATE_VAULT, p);
    expect(findings.every((f) => f.phase === 'build')).toBe(true);
  });

  it('lists both template projects with a resolved template and no exemption', () => {
    const projects = listProjects(PHASE_GATE_VAULT);
    const names = projects.map((p) => p.name).sort();
    expect(names).toEqual(['Clean-Project', 'Gated-Project', 'Research-Project']);
    for (const p of projects) {
      expect(p.exempt).toBe(false);
      expect(p.template).not.toBeNull();
    }
  });
});

describe('checkPhaseGate (PREVENT half — structured refusal, never throws)', () => {
  it('refuses a build phase whose deliverable is missing (scope-plan-build-verify)', () => {
    const r = checkPhaseGate('Gated-Project', 'build', { vaultRoot: PHASE_GATE_VAULT });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.phase).toBe('build');
      expect(r.project).toBe('Gated-Project');
      expect(r.template).toBe('scope-plan-build-verify');
      expect(r.missingArtifact).toBeTruthy();
      expect(r.reason).toMatch(/deliverable/i);
    }
  });

  it('allows a build phase whose deliverable resolves on disk', () => {
    const r = checkPhaseGate('Clean-Project', 'build', { vaultRoot: PHASE_GATE_VAULT });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact).toBe('build-deliverable');
      expect(r.template).toBe('scope-plan-build-verify');
    }
  });

  it('allows a verify phase whose review record links the project', () => {
    const r = checkPhaseGate('Clean-Project', 'verify', { vaultRoot: PHASE_GATE_VAULT });
    expect(r.ok).toBe(true);
  });

  it('refuses a research synthesize phase whose synthesis is missing', () => {
    const r = checkPhaseGate('Research-Project', 'synthesize', { vaultRoot: PHASE_GATE_VAULT });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.template).toBe('research');
      expect(r.phase).toBe('synthesize');
    }
  });

  it('resolves a project by pm-project id as well as by name', () => {
    const r = checkPhaseGate('gatedproject00001', 'build', { vaultRoot: PHASE_GATE_VAULT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.project).toBe('Gated-Project');
  });

  it('refuses (does not throw) for an unknown project', () => {
    const r = checkPhaseGate('does-not-exist', 'build', { vaultRoot: PHASE_GATE_VAULT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no project resolvable/i);
  });

  it('refuses a phase that is not part of the project template', () => {
    const r = checkPhaseGate('Research-Project', 'build', { vaultRoot: PHASE_GATE_VAULT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not part of template/i);
  });
});

// ---------------------------------------------------------------------------
// Phase-gate reviewer-approved fixes (2026-07-20).
//   Fix 1: case-insensitive project-note resolution.
//   Fix 2: pm.checkPhaseGate is built into agent tools (builder == registry).
//   Fix 3: freshness prefers a frontmatter timestamp, never trusts file mtime.
//   Fix 4: P2 plan-block detection is scoped to a real ## Plan section, not a
//          whole-body substring grep (must NOT match "## Task Board").
// ---------------------------------------------------------------------------

describe('phase-gate fix 1 — case-insensitive project-note resolution', () => {
  it('resolves the project note even when the board Source: slug case differs from the filename', () => {
    // Gated-Project's board card points at Source: [[gated-project]] and the file
    // is Projects/gated-project.md. Rename the file to a MixedCase basename and
    // leave the lowercase Source: link — case-sensitive existsSync would miss it,
    // the readdir + lowercased-compare resolver must still find it.
    const tmp = mkdtempSync(join(tmpdir(), 'pg-case-'));
    cpSync(PHASE_GATE_VAULT, tmp, { recursive: true });
    const content = readFileSync(join(tmp, 'Projects', 'gated-project.md'), 'utf-8');
    // On case-insensitive FS (macOS), renaming by write+rm deletes the ONLY
    // file — write the new-cased name _after_ removing the original.
    rmSync(join(tmp, 'Projects', 'gated-project.md'));
    writeFileSync(join(tmp, 'Projects', 'Gated-Project.md'), content);

    const p = loadProject(tmp, 'Gated-Project');
    expect(p.noteAbs, 'note must resolve despite slug/filename case mismatch').toBeTruthy();
    expect(p.noteRel).toBe('Projects/Gated-Project.md');
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('phase-gate fix 2 — pm.checkPhaseGate is a built agent tool', () => {
  it('every TOOL_REGISTRY tool has a factory builder (builder count == registry count)', () => {
    const names = TOOL_REGISTRY.map((t) => t.name);
    const built = buildAgentTools(names, false);
    // buildAgentTools drops any registry tool with no builder — so a full-length
    // result proves every registered tool (incl. pm.checkPhaseGate) is buildable.
    expect(built.length).toBe(names.length);
  });

  it('pm.checkPhaseGate builds into a callable tool that returns the structured result', async () => {
    const built = buildAgentTools(['pm.checkPhaseGate'], false);
    expect(built.length).toBe(1);
    const tool = built[0];
    expect(typeof tool.func).toBe('function');
    // It calls checkPhaseGate against the LIVE vault by default (no vaultRoot arg).
    // We only assert the shape: a JSON PhaseGateResult with an `ok` boolean.
    const raw = await tool.func({ projectId: 'does-not-exist-xyz', phase: 'build' });
    const parsed = JSON.parse(raw);
    expect(typeof parsed.ok).toBe('boolean');
    expect(parsed.ok).toBe(false);
  });
});

describe('phase-gate fix 3 — freshness never false-negatives via file mtime', () => {
  it('a frontmatter last_updated newer than start passes even if file mtime is old', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-fresh-'));
    cpSync(PHASE_GATE_VAULT, tmp, { recursive: true });
    // Clean-Project scope card start is 2026-07-01, note last_updated 2026-07-10.
    // Force the file mtime WAY back to before start — the old mtime check would
    // false-negative here; the frontmatter-date check must still pass.
    const notePath = join(tmp, 'Projects', 'clean-project.md');
    const oldTime = new Date('2020-01-01T00:00:00Z');
    utimesSync(notePath, oldTime, oldTime);

    const r = checkPhaseGate('Clean-Project', 'scope', { vaultRoot: tmp });
    expect(r.ok, 'scope must still pass on frontmatter freshness, not stale mtime').toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('existence-only fallback: an artifact with no reliable timestamp is not failed on mtime', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-fresh2-'));
    cpSync(PHASE_GATE_VAULT, tmp, { recursive: true });
    // Strip the last_updated frontmatter so there is NO reliable timestamp, and
    // push the file mtime before the phase start. With no frontmatter date the
    // check falls back to existence-only (must pass), never to mtime.
    const notePath = join(tmp, 'Projects', 'clean-project.md');
    writeFileSync(notePath, readFileSync(notePath, 'utf-8').replace(/^last_updated: .*$/m, ''));
    const oldTime = new Date('2020-01-01T00:00:00Z');
    utimesSync(notePath, oldTime, oldTime);

    const r = checkPhaseGate('Clean-Project', 'scope', { vaultRoot: tmp });
    expect(r.ok, 'existence-only fallback must pass, not fail on stale mtime').toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('phase-gate fix 4 — P2 plan-block detection is scoped, not a substring grep', () => {
  it('does NOT match "## Task Board" as the plan Tasks artifact (flags a genuinely plan-less note)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-p2-'));
    cpSync(PHASE_GATE_VAULT, tmp, { recursive: true });
    // Replace Clean-Project's real ## Plan section with a note that has ONLY a
    // "## Task Board" heading and prose mentioning goals/decisions in passing —
    // the old whole-body substring grep passed this; the tightened check must
    // now flag it as plan-less.
    const notePath = join(tmp, 'Projects', 'clean-project.md');
    const raw = readFileSync(notePath, 'utf-8');
    const stripped = raw.replace(
      /## Plan[\s\S]*$/m,
      [
        '## Task Board',
        'Our overarching goal is broad and we made a decision about scope in prose.',
        '- some task-shaped work item',
        '',
      ].join('\n'),
    );
    writeFileSync(notePath, stripped);

    const p = loadProject(tmp, 'Clean-Project');
    const planResult = checkArtifact(tmp, p, 'plan-block', null);
    expect(planResult.ok, 'a note with only ## Task Board must NOT satisfy the plan artifact').toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('still passes a note with a real ## Plan section (Goal + Tasks + Open decisions as labeled lines)', () => {
    const p = loadProject(PHASE_GATE_VAULT, 'Clean-Project');
    const planResult = checkArtifact(PHASE_GATE_VAULT, p, 'plan-block', null);
    expect(planResult.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase-gate DETECT half runs end-to-end in the real script (--full) against a
// throwaway copy of the phase-gate fixture, surfacing P-findings through the
// SAME status:open report path as V1-V4.
// ---------------------------------------------------------------------------

describe.skipIf(!scriptExists)('phase-gate P-checks in --full', () => {
  let tempVault: string;

  beforeEach(() => {
    tempVault = mkdtempSync(join(tmpdir(), 'phase-gate-full-'));
    cpSync(PHASE_GATE_VAULT, tempVault, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempVault, { recursive: true, force: true });
  });

  it('emits P3 findings and a status:open report on the fixture', () => {
    const { out } = runFullOnVault(tempVault);
    expect(out).toContain('[P3]');
    expect(out).toContain('Gated-Project');
    expect(out).toContain('Research-Project');

    const reportPath = join(tempVault, 'Meta', 'enforcement-report-' + today() + '.md');
    expect(existsSync(reportPath)).toBe(true);
    const report = readFileSync(reportPath, 'utf-8');
    expect(report).toContain('status: open');
    expect(report).toContain('P3');
  });

  it('stays clean when the offending done phases produce their artifacts', () => {
    // Flip the two done-without-artifact cards back to in-progress so no P-check
    // has a done phase to assess — the fixture then runs clean.
    for (const rel of [
      join('_taskboard', 'Gated-Project_tasks', 'build.md'),
      join('_taskboard', 'Research-Project_tasks', 'synthesize.md'),
    ]) {
      const p = join(tempVault, rel);
      writeFileSync(p, readFileSync(p, 'utf-8').replace('status: "done"', 'status: "in-progress"'));
    }
    const { out } = runFullOnVault(tempVault);
    expect(out).not.toContain('[P1]');
    expect(out).not.toContain('[P2]');
    expect(out).not.toContain('[P3]');
    expect(out).not.toContain('[P4]');
    expect(out).toContain('clean');
  });
});
