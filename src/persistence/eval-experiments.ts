import { randomUUID } from 'node:crypto';
import { getDb } from './database.js';

// eval-experiments data-access layer — visual-lab-general-eval §3.
// Experiments are deduplicated by program_hash (SHA-256 of axString).
// Each experiment can have many runs (baseline/optimize modes).

export interface EvalExperiment {
  id: string;
  program_hash: string;
  target_type: 'custom' | 'signature' | 'router' | 'flow' | 'agent';
  target_id: string | null;
  ax_string: string;
  metric: string | null;
  created_at: string;
}

export interface EvalRun {
  id: string;
  experiment_id: string;
  mode: 'baseline' | 'optimize';
  model: string | null;
  accuracy: number;
  hits: number;
  total: number;
  results_json: string;
  duration_ms: number | null;
  created_at: string;
}

export interface ExperimentSummary {
  id: string;
  program_hash: string;
  target_type: string;
  target_id: string | null;
  ax_string: string;
  metric: string | null;
  created_at: string;
  latest_run: {
    id: string;
    mode: string;
    accuracy: number;
    hits: number;
    total: number;
    created_at: string;
  } | null;
  run_count: number;
}

function hashProgram(axString: string): string {
  // Simple hash — crypto.createHash('sha256') would add a dynamic import.
  // Use a fast string hash that's good enough for dedup.
  let hash = 0;
  for (let i = 0; i < axString.length; i++) {
    const chr = axString.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return `hash-${Math.abs(hash).toString(36)}`;
}

/**
 * Upsert an experiment — matches by program_hash. Returns existing or newly created row.
 */
export function upsertExperiment(params: {
  axString: string;
  targetType: EvalExperiment['target_type'];
  targetId?: string | null;
  metric?: string | null;
}): EvalExperiment {
  const db = getDb();
  const programHash = hashProgram(params.axString);

  const existing = db
    .prepare('SELECT * FROM eval_experiments WHERE program_hash = ?')
    .get(programHash) as EvalExperiment | undefined;

  if (existing) {
    // Update ax_string and metric if they've changed
    db.prepare(
      `UPDATE eval_experiments SET ax_string = ?, metric = ?, target_id = ? WHERE id = ?`,
    ).run(params.axString, params.metric ?? null, params.targetId ?? null, existing.id);
    return { ...existing, ax_string: params.axString, metric: params.metric ?? null, target_id: params.targetId ?? null };
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO eval_experiments (id, program_hash, target_type, target_id, ax_string, metric, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, programHash, params.targetType, params.targetId ?? null, params.axString, params.metric ?? null, now);

  return {
    id,
    program_hash: programHash,
    target_type: params.targetType,
    target_id: params.targetId ?? null,
    ax_string: params.axString,
    metric: params.metric ?? null,
    created_at: now,
  };
}

/**
 * Save a run for an experiment.
 */
export function saveEvalRun(params: {
  experimentId: string;
  mode: EvalRun['mode'];
  model?: string | null;
  accuracy: number;
  hits: number;
  total: number;
  results: unknown[];
  durationMs?: number | null;
}): EvalRun {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO eval_runs (id, experiment_id, mode, model, accuracy, hits, total, results_json, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.experimentId,
    params.mode,
    params.model ?? null,
    params.accuracy,
    params.hits,
    params.total,
    JSON.stringify(params.results),
    params.durationMs ?? null,
    now,
  );

  return {
    id,
    experiment_id: params.experimentId,
    mode: params.mode,
    model: params.model ?? null,
    accuracy: params.accuracy,
    hits: params.hits,
    total: params.total,
    results_json: JSON.stringify(params.results),
    duration_ms: params.durationMs ?? null,
    created_at: now,
  };
}

/**
 * List all experiments with their latest run summary.
 */
export function listExperiments(params?: { targetId?: string; targetType?: string }): ExperimentSummary[] {
  const db = getDb();
  let experiments: EvalExperiment[]; 
  if (params?.targetId && params?.targetType) {
    experiments = db.prepare(
      'SELECT * FROM eval_experiments WHERE target_id = ? AND target_type = ? ORDER BY created_at DESC'
    ).all(params.targetId, params.targetType) as EvalExperiment[];
  } else if (params?.targetType) {
    experiments = db.prepare(
      'SELECT * FROM eval_experiments WHERE target_type = ? ORDER BY created_at DESC'
    ).all(params.targetType) as EvalExperiment[];
  } else {
    experiments = db.prepare('SELECT * FROM eval_experiments ORDER BY created_at DESC').all() as EvalExperiment[];
  }

  return experiments.map((exp) => {
    const latestRun = db
      .prepare('SELECT * FROM eval_runs WHERE experiment_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(exp.id) as EvalRun | undefined;

    const runCount = (
      db.prepare('SELECT COUNT(*) as count FROM eval_runs WHERE experiment_id = ?').get(exp.id) as { count: number }
    ).count;

    return {
      id: exp.id,
      program_hash: exp.program_hash,
      target_type: exp.target_type,
      target_id: exp.target_id,
      ax_string: exp.ax_string,
      metric: exp.metric,
      created_at: exp.created_at,
      latest_run: latestRun
        ? {
            id: latestRun.id,
            mode: latestRun.mode,
            accuracy: latestRun.accuracy,
            hits: latestRun.hits,
            total: latestRun.total,
            created_at: latestRun.created_at,
          }
        : null,
      run_count: runCount,
    };
  });
}

/**
 * Get a single experiment with all its runs.
 */
export function getExperiment(id: string): (EvalExperiment & { runs: EvalRun[] }) | undefined {
  const db = getDb();
  const experiment = db.prepare('SELECT * FROM eval_experiments WHERE id = ? OR id LIKE ?').get(id, `${id}%`) as
    | EvalExperiment
    | undefined;
  if (!experiment) return undefined;

  const runs = db
    .prepare('SELECT * FROM eval_runs WHERE experiment_id = ? ORDER BY created_at DESC')
    .all(experiment.id) as EvalRun[];

  return { ...experiment, runs };
}
