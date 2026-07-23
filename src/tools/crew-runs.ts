import { getDb } from '../persistence/database.js';

// Read-only diagnostic access to the crew's own run history (crew.sqlite).
// This is the evidence the Investigator needs to actually "trace the chain"
// (routing -> agent/skill -> tool calls -> output) instead of speculating.
// All functions here are pure reads — they never mutate the database.

export interface CrewRunSummary {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: string;
  route: string | null;
  request: string;
  error: string | null;
}

export interface CrewToolCall {
  toolName: string;
  status: string;
  input: string;
  output: string | null;
}

export interface CrewRunStep {
  stepNumber: number;
  agentOrSkill: string;
  model: string | null;
  status: string;
  inputSummary: string | null;
  outputSummary: string | null;
  warnings: string | null;
  toolCalls: CrewToolCall[];
}

export interface CrewRunDetail extends CrewRunSummary {
  routeConfidence: number | null;
  routeReason: string | null;
  finalResponse: string | null;
  steps: CrewRunStep[];
  changedFiles: { path: string; operation: string; description: string | null }[];
}

const MAX_FIELD = 4000;

function clamp(value: string | null, max = MAX_FIELD): string | null {
  if (value == null) return null;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`;
}

export interface ListRunsInput {
  status?: string; // e.g. 'failed', 'completed'
  agent?: string; // matches selected_route_id
  limit?: number;
}

/** List recent runs newest-first, so the investigator can locate a failure. */
export function listRuns(input: ListRunsInput = {}): { runs: CrewRunSummary[] } {
  const db = getDb();
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.status) {
    clauses.push('status = ?');
    params.push(input.status);
  }
  if (input.agent) {
    clauses.push('selected_route_id = ?');
    params.push(input.agent);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT id, started_at, completed_at, status, selected_route_id,
              original_request, error
         FROM runs ${where}
         ORDER BY started_at DESC
         LIMIT ?`,
    )
    .all(...params, limit) as Record<string, unknown>[];

  return {
    runs: rows.map((r) => ({
      id: String(r.id),
      startedAt: String(r.started_at),
      completedAt: r.completed_at ? String(r.completed_at) : null,
      status: String(r.status),
      route: r.selected_route_id ? String(r.selected_route_id) : null,
      request: clamp(String(r.original_request), 300) ?? '',
      error: r.error ? clamp(String(r.error), 500) : null,
    })),
  };
}

export interface GetRunInput {
  runId: string; // full id or unique prefix
}

/**
 * Full trace for one run: the run row, every step, and each step's tool calls
 * (with inputs/outputs) plus any files it changed. `runId` may be a prefix —
 * the same short form the crew logs and Slack surface.
 */
export function getRun(input: GetRunInput): CrewRunDetail | { error: string } {
  const db = getDb();
  const id = input.runId.trim();
  if (!id) return { error: 'runId is required' };

  const run = db
    .prepare(
      `SELECT * FROM runs WHERE id = ? OR id LIKE ? ORDER BY started_at DESC LIMIT 2`,
    )
    .all(id, `${id}%`) as Record<string, unknown>[];

  if (run.length === 0) {
    return { error: `No run found matching "${id}". Use listRuns to find one.` };
  }
  if (run.length > 1) {
    return {
      error: `Ambiguous run id "${id}" matches multiple runs. Provide more characters.`,
    };
  }
  const r = run[0]!;
  const runId = String(r.id);

  const steps = db
    .prepare(
      `SELECT id, step_number, agent_or_skill_id, model, status,
              input_summary, output_summary, warnings
         FROM run_steps WHERE run_id = ? ORDER BY step_number ASC`,
    )
    .all(runId) as Record<string, unknown>[];

  const stepDetails: CrewRunStep[] = steps.map((s) => {
    const calls = db
      .prepare(
        `SELECT tool_name, status, input, output
           FROM tool_calls WHERE step_id = ? ORDER BY started_at ASC`,
      )
      .all(String(s.id)) as Record<string, unknown>[];
    return {
      stepNumber: Number(s.step_number),
      agentOrSkill: String(s.agent_or_skill_id),
      model: s.model ? String(s.model) : null,
      status: String(s.status),
      inputSummary: clamp(s.input_summary ? String(s.input_summary) : null),
      outputSummary: clamp(s.output_summary ? String(s.output_summary) : null),
      warnings: s.warnings ? String(s.warnings) : null,
      toolCalls: calls.map((c) => ({
        toolName: String(c.tool_name),
        status: String(c.status),
        input: clamp(String(c.input), 1500) ?? '',
        output: clamp(c.output ? String(c.output) : null, 1500),
      })),
    };
  });

  const changed = db
    .prepare(
      `SELECT path, operation, description FROM changed_files WHERE run_id = ?`,
    )
    .all(runId) as Record<string, unknown>[];

  return {
    id: runId,
    startedAt: String(r.started_at),
    completedAt: r.completed_at ? String(r.completed_at) : null,
    status: String(r.status),
    route: r.selected_route_id ? String(r.selected_route_id) : null,
    request: clamp(String(r.original_request), 2000) ?? '',
    error: r.error ? clamp(String(r.error)) : null,
    routeConfidence:
      r.route_confidence == null ? null : Number(r.route_confidence),
    routeReason: r.route_reason ? String(r.route_reason) : null,
    finalResponse: clamp(r.final_response ? String(r.final_response) : null),
    steps: stepDetails,
    changedFiles: changed.map((c) => ({
      path: String(c.path),
      operation: String(c.operation),
      description: c.description ? String(c.description) : null,
    })),
  };
}
