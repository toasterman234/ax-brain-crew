// checkPhaseGate — the PREVENT half of the phase-gate.
// From pm-lifecycle-enforcement (vault/Projects/pm-lifecycle-enforcement.md,
// "B. Prevent — checkPhaseGate() crew tool"): a real code function the crew must
// call BEFORE writing `status: done` on a phase card. It resolves the project +
// its lifecycle template, looks up the artifact required for `phase`, checks
// existence/freshness, and returns a STRUCTURED refusal (not a throw) so callers
// can surface it. Reliable because it's code, not a prompt — but only covers
// crew-driven advances (obsidian-git skips hooks, so manual card moves are caught
// by the DETECT half in scripts/check-vault-enforcement.ts).

import { getVaultRoot } from './vault-path.js';
import {
  loadProject,
  listProjects,
  checkArtifact,
  type ProjectModel,
} from './phase-gate-core.js';

export interface PhaseGateOk {
  ok: true;
  project: string;
  phase: string;
  template: string;
  artifact: string;
  detail: string;
}

export interface PhaseGateRefusal {
  ok: false;
  reason: string;
  phase: string;
  project?: string;
  template?: string;
  missingArtifact?: string;
}

export type PhaseGateResult = PhaseGateOk | PhaseGateRefusal;

export interface CheckPhaseGateInput {
  projectId: string; // pm-project id OR the <Name> of the project
  phase: string; // e.g. "build", "verify", "gather"
  /**
   * Optional explicit vault root — defaults to the live vault root
   * (getVaultRoot()). Tests pass a fixture root here.
   */
  vaultRoot?: string;
}

// Resolve a project by its pm-project id, or by its <Name> as a fallback (the
// crew may hold either). Returns null if neither matches.
function resolveProject(vaultRoot: string, projectId: string): ProjectModel | null {
  const byName = loadProject(vaultRoot, projectId);
  if (byName.cards.length > 0 || byName.noteAbs) {
    // loadProject succeeds structurally even for a missing folder; only treat it
    // as a hit if it actually found cards or a note.
    if (byName.projectId === projectId || byName.name === projectId) return byName;
  }
  for (const p of listProjects(vaultRoot)) {
    if (p.projectId === projectId || p.name === projectId) return p;
  }
  return null;
}

/**
 * checkPhaseGate(projectId, phase) — returns { ok: true } when the artifact the
 * given phase must produce exists (and is fresh), or a structured refusal
 * { ok: false, reason, missingArtifact, phase } when it's missing. NEVER throws
 * for a policy failure — a refusal is data the caller surfaces to Ben.
 */
export function checkPhaseGate(
  projectId: string,
  phase: string,
  opts: { vaultRoot?: string } = {},
): PhaseGateResult {
  const vaultRoot = opts.vaultRoot ?? getVaultRoot();

  const project = resolveProject(vaultRoot, projectId);
  if (!project) {
    return { ok: false, reason: `No project resolvable for id/name "${projectId}"`, phase };
  }
  if (!project.template) {
    return {
      ok: false,
      reason: `Cannot determine lifecycle template for project "${project.name}" (no recognizable phase/* tags and no explicit lifecycle field) — gate cannot look up the artifact for phase "${phase}"`,
      phase,
      project: project.name,
    };
  }

  const spec = project.template.phases.find(p => p.phase === phase);
  if (!spec) {
    return {
      ok: false,
      reason: `Phase "${phase}" is not part of template "${project.template.name}" (phases: ${project.template.phases
        .map(p => p.phase)
        .join(' → ')})`,
      phase,
      project: project.name,
      template: project.template.name,
    };
  }

  // Use the phase card's own `start` for the freshness check when available.
  const card = project.cards.find(c => c.phase === phase);
  const result = checkArtifact(vaultRoot, project, spec.artifact, card?.start ?? null);

  if (result.ok) {
    return {
      ok: true,
      project: project.name,
      phase,
      template: project.template.name,
      artifact: spec.artifact,
      detail: result.detail,
    };
  }

  return {
    ok: false,
    reason: `Phase "${phase}" cannot be marked done: ${result.detail}`,
    phase,
    project: project.name,
    template: project.template.name,
    missingArtifact: result.artifactPath ?? spec.artifact,
  };
}
