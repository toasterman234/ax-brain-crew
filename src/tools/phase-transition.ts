import { checkPhaseGate } from './phase-gate.js';

const DONE_STATUSES = new Set(['done', 'complete', 'completed', 'shipped']);

type MutableFrontmatter = Record<string, unknown> & {
  projectId?: unknown;
  tags?: unknown;
  status?: unknown;
  progress?: unknown;
  updatedAt?: unknown;
  request_status?: unknown;
  last_applied_at?: unknown;
  last_result?: unknown;
  last_valid_status?: unknown;
  gate_validated_at?: unknown;
  gate_validated_phase?: unknown;
  reconciled_at?: unknown;
  reconciled_from?: unknown;
  reconciled_to?: unknown;
};

export interface AdvancePhaseOutcome {
  ok: boolean;
  phase?: string;
  message: string;
  frontmatter: MutableFrontmatter;
}

export interface ReconcilePhaseOutcome {
  changed: boolean;
  phase?: string;
  message: string;
  frontmatter: MutableFrontmatter;
}

export function phaseTagFromFrontmatter(frontmatter: Record<string, unknown>): string | null {
  const tags = frontmatter.tags;
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    if (!tag.startsWith('phase/')) continue;
    const phase = tag.slice('phase/'.length).trim();
    return phase || null;
  }
  return null;
}

export function applyAdvancePhase(
  frontmatter: MutableFrontmatter,
  opts: { vaultRoot?: string; nowIso?: string; nowMinute?: string } = {},
): AdvancePhaseOutcome {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const nowMinute = opts.nowMinute ?? nowIso.slice(0, 16);
  const next: MutableFrontmatter = { ...frontmatter };
  const projectId = String(frontmatter.projectId ?? '').trim();
  const phase = phaseTagFromFrontmatter(frontmatter);

  if (!projectId) {
    next.request_status = 'error';
    next.last_result = 'Rejected: phase card is missing projectId.';
    return { ok: false, message: String(next.last_result), frontmatter: next };
  }

  if (!phase) {
    next.request_status = 'error';
    next.last_result = 'Rejected: phase card is missing a phase/<name> tag.';
    return { ok: false, message: String(next.last_result), frontmatter: next };
  }

  const currentStatus = String(frontmatter.status ?? '').trim().toLowerCase();
  if (DONE_STATUSES.has(currentStatus)) {
    next.request_status = 'applied';
    next.last_applied_at = nowMinute;
    next.last_result = `No-op: ${phase} phase is already done.`;
    return { ok: true, phase, message: String(next.last_result), frontmatter: next };
  }

  const gate = checkPhaseGate(projectId, phase, opts.vaultRoot ? { vaultRoot: opts.vaultRoot } : {});
  if (!gate.ok) {
    next.request_status = 'error';
    next.last_result = `Blocked: ${gate.reason}`;
    return { ok: false, phase, message: String(next.last_result), frontmatter: next };
  }

  next.last_valid_status = String(frontmatter.status ?? '');
  next.status = 'done';
  next.progress = 100;
  next.updatedAt = nowIso;
  next.request_status = 'applied';
  next.last_applied_at = nowMinute;
  next.last_result = `Advanced ${phase} to done — ${gate.detail}`;
  next.gate_validated_at = nowIso;
  next.gate_validated_phase = phase;

  return { ok: true, phase, message: String(next.last_result), frontmatter: next };
}

export function reconcileInvalidDone(
  frontmatter: MutableFrontmatter,
  detail: string,
  opts: { nowIso?: string } = {},
): ReconcilePhaseOutcome {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const next: MutableFrontmatter = { ...frontmatter };
  const phase = phaseTagFromFrontmatter(frontmatter);
  const currentStatus = String(frontmatter.status ?? '').trim().toLowerCase();

  if (!DONE_STATUSES.has(currentStatus)) {
    return {
      changed: false,
      phase: phase ?? undefined,
      message: 'No-op: phase is not currently done.',
      frontmatter: next,
    };
  }

  const prior = String(frontmatter.last_valid_status ?? '').trim().toLowerCase();
  const targetStatus =
    prior && !DONE_STATUSES.has(prior) ? prior : 'in-progress';

  next.status = targetStatus;
  next.progress = targetStatus === 'todo' ? 0 : 50;
  next.updatedAt = nowIso;
  next.request_status = 'reconciled';
  next.last_result = `Auto-reverted ${phase ?? 'phase'} from done to ${targetStatus}: ${detail}`;
  next.reconciled_at = nowIso;
  next.reconciled_from = currentStatus;
  next.reconciled_to = targetStatus;

  return {
    changed: true,
    phase: phase ?? undefined,
    message: String(next.last_result),
    frontmatter: next,
  };
}
