import { randomUUID } from 'node:crypto';
import { getDb } from './database.js';
import { getLogger } from '../observability/logger.js';

// research_jobs data-access layer (crew-web-tool-design.md §2). Kept separate
// from database.ts (which only owns the schema/migrations) so the tools and the
// worker share one typed surface for the queue.

export interface ResearchJob {
  id: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  status: 'queued' | 'running' | 'done' | 'failed';
  question: string;
  requested_by: string | null;
  result_path: string | null;
  summary: string | null;
  error: string | null;
  attempts: number;
}

// How long a 'running' row may sit before the worker assumes the previous
// worker crashed mid-job and reclaims it back to 'queued' (design §5).
const STALE_RUNNING_MS = 10 * 60 * 1000;

// Bounded retry: a job that has failed this many times is parked, not requeued.
export const MAX_ATTEMPTS = 2;

/**
 * Insert a queued job and return its id. This is the ~0ms local sqlite insert a
 * live chat turn makes via research.enqueue — it never blocks the request path.
 */
export function enqueueResearch(question: string, requestedBy?: string): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO research_jobs (id, created_at, status, question, requested_by)
     VALUES (?, ?, 'queued', ?, ?)`,
  ).run(id, new Date().toISOString(), question, requestedBy ?? null);
  getLogger().info({ id, question }, 'research job enqueued');
  return id;
}

export function getResearchJob(id: string): ResearchJob | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM research_jobs WHERE id = ? OR id LIKE ?').get(id, `${id}%`) as
    | ResearchJob
    | undefined;
}

/**
 * Reclaim any 'running' row older than STALE_RUNNING_MS back to 'queued'. Run on
 * worker start so a crashed worker's in-flight job is retried, not orphaned.
 * Returns the number of rows reclaimed.
 */
export function reclaimStaleJobs(): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  const info = db
    .prepare(
      `UPDATE research_jobs
         SET status = 'queued', started_at = NULL
       WHERE status = 'running' AND (started_at IS NULL OR started_at < ?)`,
    )
    .run(cutoff);
  if (info.changes > 0) {
    getLogger().info({ reclaimed: info.changes }, 'reclaimed stale running jobs');
  }
  return info.changes;
}

/**
 * Atomically claim the oldest queued job (single guarded UPDATE ... RETURNING so
 * two workers can't double-run one). Returns the claimed row or undefined if the
 * queue is empty.
 */
export function claimNextJob(): ResearchJob | undefined {
  const db = getDb();
  const row = db
    .prepare(
      `UPDATE research_jobs
         SET status = 'running', started_at = ?, attempts = attempts + 1
       WHERE id = (
         SELECT id FROM research_jobs
          WHERE status = 'queued'
          ORDER BY created_at ASC
          LIMIT 1
       )
       RETURNING *`,
    )
    .get(new Date().toISOString()) as ResearchJob | undefined;
  if (row) getLogger().info({ id: row.id, attempts: row.attempts }, 'claimed research job');
  return row;
}

export function completeJob(id: string, resultPath: string, summary: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE research_jobs
       SET status = 'done', completed_at = ?, result_path = ?, summary = ?, error = NULL
     WHERE id = ?`,
  ).run(new Date().toISOString(), resultPath, summary, id);
  getLogger().info({ id, resultPath }, 'research job done');
}

/**
 * Mark a job failed. If it still has retry budget left it goes back to 'queued'
 * so the worker picks it up again; once attempts hit MAX_ATTEMPTS it's parked as
 * 'failed' (design §5 bounded-retry).
 */
export function failJob(id: string, error: string): void {
  const db = getDb();
  const job = getResearchJob(id);
  const attempts = job?.attempts ?? MAX_ATTEMPTS;
  const park = attempts >= MAX_ATTEMPTS;
  db.prepare(
    `UPDATE research_jobs
       SET status = ?, completed_at = ?, error = ?
     WHERE id = ?`,
  ).run(park ? 'failed' : 'queued', park ? new Date().toISOString() : null, error.slice(0, 1000), id);
  getLogger().warn({ id, attempts, parked: park, error: error.slice(0, 200) }, 'research job failed');
}
