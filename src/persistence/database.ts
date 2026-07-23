import Database from 'better-sqlite3';
import { getLogger } from '../observability/logger.js';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = process.env.DATABASE_PATH || './data/crew.sqlite';
  const logger = getLogger();

  logger.info({ path: dbPath }, 'Opening database');
  _db = new Database(dbPath);

  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  runMigrations(_db);

  return _db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'started',
      original_request TEXT NOT NULL,
      selected_route_type TEXT,
      selected_route_id TEXT,
      route_confidence REAL,
      route_reason TEXT,
      final_response TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS run_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      step_number INTEGER NOT NULL,
      agent_or_skill_id TEXT NOT NULL,
      model TEXT,
      model_tier TEXT,
      input_summary TEXT,
      output_summary TEXT,
      status TEXT NOT NULL DEFAULT 'started',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      suggested_next_agent TEXT,
      next_agent_reason TEXT,
      warnings TEXT
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      step_id TEXT NOT NULL REFERENCES run_steps(id),
      tool_name TEXT NOT NULL,
      input TEXT NOT NULL,
      output TEXT,
      status TEXT NOT NULL DEFAULT 'started',
      started_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS changed_files (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      step_id TEXT REFERENCES run_steps(id),
      path TEXT NOT NULL,
      operation TEXT NOT NULL,
      previous_path TEXT,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      turn_count INTEGER NOT NULL DEFAULT 0,
      title TEXT
    );

    -- Background web-research job queue (crew-web-tool-design.md §2). A live
    -- chat turn INSERTs a 'queued' row via research.enqueue and returns in ~0ms;
    -- a long-lived 'crew worker' process claims and runs it off the live turn.
    CREATE TABLE IF NOT EXISTS research_jobs (
      id           TEXT PRIMARY KEY,                 -- uuid
      created_at   TEXT NOT NULL,
      started_at   TEXT,
      completed_at TEXT,
      status       TEXT NOT NULL DEFAULT 'queued',   -- queued|running|done|failed
      question     TEXT NOT NULL,                    -- the research question
      requested_by TEXT,                             -- session_id / run_id that queued it
      result_path  TEXT,                             -- vault path the Scribe wrote
      summary      TEXT,                             -- short gist, shown back in chat
      error        TEXT,
      attempts     INTEGER NOT NULL DEFAULT 0        -- for bounded retry
    );

    -- Eval experiment persistence (visual-lab-general-eval §3).
    -- Experiments are deduplicated by program_hash; each experiment has many runs.
    CREATE TABLE IF NOT EXISTS eval_experiments (
      id           TEXT PRIMARY KEY,                 -- uuid
      program_hash TEXT NOT NULL,                    -- hash of axString for dedup
      target_type  TEXT NOT NULL,                    -- 'custom' | 'signature' | 'router' | 'flow'
      target_id    TEXT,                             -- flowId, artifactId, or null
      ax_string    TEXT,                             -- the signature string
      metric       TEXT,                             -- the metric function source
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS eval_runs (
      id            TEXT PRIMARY KEY,                -- uuid
      experiment_id TEXT NOT NULL REFERENCES eval_experiments(id),
      mode          TEXT NOT NULL,                   -- 'baseline' | 'optimize'
      model         TEXT,                            -- which LLM ran
      accuracy      REAL,                            -- 0.0–1.0
      hits          INTEGER,
      total         INTEGER,
      results_json  TEXT,                            -- full results array as JSON
      duration_ms   INTEGER,
      created_at    TEXT NOT NULL
    );

    -- Slack feedback capture (slack-feedback-eval §1). One row per delivered
    -- agent reply, keyed by the reply's Slack message ts. This is the bridge
    -- between a Slack reaction/reply and the run it refers to: a later 👍/👎
    -- resolves message_ts → trace_id to attach a Langfuse score.
    CREATE TABLE IF NOT EXISTS slack_runs (
      message_ts   TEXT PRIMARY KEY,                -- ts of the bot reply (feedback target)
      channel_id   TEXT NOT NULL,
      thread_ts    TEXT NOT NULL,
      runtime      TEXT NOT NULL,                   -- 'crew' | 'pi'
      route_agent  TEXT,                            -- agent that answered (routing result)
      forced_agent TEXT,                            -- set if user explicitly routed (override)
      trace_id     TEXT,                            -- Langfuse trace id, for score attribution
      prompt       TEXT NOT NULL,
      response     TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_slack_runs_thread
      ON slack_runs (channel_id, thread_ts, created_at);

    -- Candidate eval pairs mined from normal Slack use (slack-feedback-eval §2).
    -- These are the labelled signals thumbs-up/down can't give you: a routing
    -- override supplies (request → correct agent); a correction/reprompt supplies
    -- (original request, wrong answer, corrective signal). reviewed=0 means it is
    -- an un-curated candidate — promote to a real eval set only after review.
    CREATE TABLE IF NOT EXISTS eval_pairs (
      id           TEXT PRIMARY KEY,                -- uuid
      kind         TEXT NOT NULL,                   -- 'routing-override' | 'correction' | 'reprompt'
      channel_id   TEXT NOT NULL,
      thread_ts    TEXT NOT NULL,
      prior_run_ts TEXT,                            -- slack_runs.message_ts this refers to
      input        TEXT NOT NULL,                   -- the original request / prompt
      output       TEXT,                            -- the (possibly wrong) agent answer
      signal       TEXT NOT NULL,                   -- correction text, or forced agent id
      route_agent  TEXT,                            -- agent that answered (for routing evals)
      trace_id     TEXT,
      reviewed     INTEGER NOT NULL DEFAULT 0,      -- 0 = candidate, 1 = curated
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eval_pairs_review
      ON eval_pairs (reviewed, created_at);
  `);

  // A chat is one session with many logged runs. Older databases predate the
  // column, so add it in place rather than recreating the table.
  ensureColumn(db, 'runs', 'session_id', 'TEXT');
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export interface RunFinalization {
  status: 'completed' | 'failed';
  routeType?: string | null;
  routeId?: string | null;
  routeConfidence?: number | null;
  routeReason?: string | null;
  finalResponse?: string | null;
  /** Failure reason — persisted to runs.error (NULL on success). */
  error?: string | null;
}

/**
 * Finalize a run row: set completed_at + status, and — critically — write the
 * failure reason into runs.error (which was NULL on every historical row) so a
 * failed/timed-out run leaves a durable reason instead of only a log line.
 * Used by every dispatch call site (ask, chat, serve) so no run is left in
 * 'started'. Assumes the run row was already INSERTed with status 'started'.
 */
export function finalizeRun(runId: string, fin: RunFinalization): void {
  const db = getDb();
  db.prepare(
    `UPDATE runs SET
       completed_at = ?,
       status = ?,
       selected_route_type = ?,
       selected_route_id = ?,
       route_confidence = ?,
       route_reason = ?,
       final_response = ?,
       error = ?
     WHERE id = ?`,
  ).run(
    new Date().toISOString(),
    fin.status,
    fin.routeType ?? null,
    fin.routeId ?? null,
    fin.routeConfidence ?? null,
    fin.routeReason ?? null,
    fin.finalResponse != null ? fin.finalResponse.slice(0, 5000) : null,
    fin.error ?? null,
    runId,
  );
}

/**
 * Persist a single already-finished FAILED run row in one INSERT.
 *
 * `ask` pre-inserts a 'started' row then calls finalizeRun on a thrown dispatch;
 * chat/serve instead log a fully-formed row after dispatch returns (logRun). When
 * dispatch() *itself* throws, there is no 'started' row to finalize, so this
 * helper writes a complete failed row directly — keeping chat/serve symmetric
 * with `ask` (no run vanishes from the log). See B1a in ax-framework-compliance.md.
 */
export function insertFailedRun(args: {
  runId: string;
  sessionId?: string | null;
  request: string;
  error: string;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO runs (id, session_id, started_at, completed_at, status,
       original_request, error)
     VALUES (?, ?, ?, ?, 'failed', ?, ?)`,
  ).run(args.runId, args.sessionId ?? null, now, now, args.request, args.error);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
