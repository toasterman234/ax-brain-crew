import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getDb,
  finalizeRun,
  insertFailedRun,
  closeDb,
} from '../src/persistence/database.js';
import { hasProceedSignal } from '../src/runtime/dispatcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB = resolve(__dirname, 'fixtures', 'reliability-test.sqlite');

// Point every DB-touching test in this file at an isolated fixture DB — and do
// it once for the whole file, BEFORE any describe runs, so no test ever writes
// to the production crew.sqlite. (Per-describe setup used to leave DATABASE_PATH
// unset for later blocks, leaking rows into prod and colliding on re-runs.)
beforeAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${TEST_DB}${suffix}`, { force: true });
  }
  process.env.DATABASE_PATH = TEST_DB;
  closeDb(); // drop any prior singleton so getDb reopens at TEST_DB
});

afterAll(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${TEST_DB}${suffix}`, { force: true });
  }
  delete process.env.DATABASE_PATH;
});

// Phase B sub-step 2: a failed run must persist its reason into runs.error
// (historically NULL on every row) and finalize with status + completed_at.
describe('finalizeRun (failure persistence)', () => {
  it('writes the error reason and marks a run failed', () => {
    const db = getDb();
    const runId = 'run-fail-1';
    db.prepare(
      `INSERT INTO runs (id, started_at, status, original_request)
       VALUES (?, ?, 'started', ?)`,
    ).run(runId, new Date().toISOString(), 'do a thing');

    finalizeRun(runId, {
      status: 'failed',
      error: 'LLM turn exceeded 120000ms and was aborted (proxy hung)',
      finalResponse: 'Run failed',
    });

    const row = db
      .prepare(`SELECT status, error, completed_at FROM runs WHERE id = ?`)
      .get(runId) as {
      status: string;
      error: string | null;
      completed_at: string | null;
    };

    expect(row.status).toBe('failed');
    expect(row.error).toContain('aborted');
    expect(row.completed_at).not.toBeNull();
  });

  it('leaves error NULL on a clean completion', () => {
    const db = getDb();
    const runId = 'run-ok-1';
    db.prepare(
      `INSERT INTO runs (id, started_at, status, original_request)
       VALUES (?, ?, 'started', ?)`,
    ).run(runId, new Date().toISOString(), 'do a thing');

    finalizeRun(runId, {
      status: 'completed',
      finalResponse: 'all good',
      error: null,
    });

    const row = db
      .prepare(`SELECT status, error, completed_at FROM runs WHERE id = ?`)
      .get(runId) as { status: string; error: string | null; completed_at: string | null };

    expect(row.status).toBe('completed');
    expect(row.error).toBeNull();
    expect(row.completed_at).not.toBeNull();
  });
});

// Phase B.1 item B1a: when dispatch() itself throws, chat/serve must persist a
// finalized failed run row (mirroring `ask`) so a thrown turn never vanishes
// from the log. The CLI catch blocks call insertFailedRun; test the helper it
// relies on writes a complete failed row in one insert (no pre-existing row).
describe('insertFailedRun (B1a — thrown-dispatch persistence)', () => {
  it('writes a complete failed row for a turn with no prior started row', () => {
    const db = getDb();
    const runId = 'run-thrown-1';
    insertFailedRun({
      runId,
      sessionId: 'sess-1',
      request: 'deep clean my vault',
      error: 'proxy connection refused',
    });

    const row = db
      .prepare(
        `SELECT status, error, completed_at, session_id, original_request
         FROM runs WHERE id = ?`,
      )
      .get(runId) as {
      status: string;
      error: string | null;
      completed_at: string | null;
      session_id: string | null;
      original_request: string;
    };

    expect(row.status).toBe('failed');
    expect(row.error).toBe('proxy connection refused');
    expect(row.completed_at).not.toBeNull();
    expect(row.session_id).toBe('sess-1');
    expect(row.original_request).toBe('deep clean my vault');
  });

  it('accepts a null session id (non-chat callers)', () => {
    const db = getDb();
    const runId = 'run-thrown-2';
    insertFailedRun({ runId, request: 'do a thing', error: 'boom' });

    const row = db
      .prepare(`SELECT session_id, status FROM runs WHERE id = ?`)
      .get(runId) as { session_id: string | null; status: string };

    expect(row.session_id).toBeNull();
    expect(row.status).toBe('failed');
  });
});

// Phase B sub-step 3: the proceed/confirm signal that lets an approval-gated
// skill execute for real. Absence of a signal keeps the skill plan-only.
//
// Phase B follow-up (security): the gate must key off a SHORT, STANDALONE
// confirmation only — never a confirm word embedded in a longer task, and never
// the assembled transcript (which carries the crew's own 'Reply "proceed"'
// prompt). See dispatcher.ts hasProceedSignal.
describe('hasProceedSignal (approval gate)', () => {
  it('detects short standalone confirmation phrases', () => {
    for (const s of [
      'proceed',
      'yes, go ahead',
      'confirm',
      'confirmed',
      'yes',
      'go ahead',
      'ok do it',
      'yes proceed',
      'ok go ahead',
      'yes please',
      'apply the changes',
    ]) {
      expect(hasProceedSignal(s)).toBe(true);
    }
  });

  it('does not treat an ordinary first request as confirmation', () => {
    for (const s of [
      'deep clean my vault',
      'triage my inbox',
      'what should I migrate',
      'tell me if this is a good idea',
    ]) {
      expect(hasProceedSignal(s)).toBe(false);
    }
  });

  // Regression: the review's first-turn false-positive strings. Each contains a
  // confirm word (confirm/approve/yes) embedded in a real task instruction, so
  // the OLD "match anywhere" logic auto-approved and wrote for real with
  // DRY_RUN=false. None may read as a proceed signal.
  it('does not auto-approve a task that merely contains a confirm word', () => {
    for (const s of [
      'deep clean my vault and confirm the results with me',
      'audit my vault, I approve of thorough checks',
      'yes man is a good movie, defrag my vault',
      'confirm my calendar then deep clean',
      'go ahead and deep clean my vault',
    ]) {
      expect(hasProceedSignal(s)).toBe(false);
    }
  });

  // Regression: transcript poisoning. The gate must be fed the LATEST user
  // message only. Feeding it the assembled transcript (which contains the crew's
  // own 'Reply "proceed" (or "yes, go ahead")' prompt) let the NEXT gated turn
  // auto-approve regardless of what the user typed.
  it('is not fooled by proceed text living in the conversation transcript', () => {
    const assembledRequest =
      '/sorter ## Conversation so far\n' +
      'You: deep clean my vault\n' +
      'Assistant (sorter): Here is the plan. ' +
      '**Approval required.** Reply "proceed" (or "yes, go ahead") to run it for real.\n\n' +
      '## Current message\n' +
      'no wait, just show me the inbox first';
    // Assembled request (old, buggy call site) would false-positive:
    expect(hasProceedSignal(assembledRequest)).toBe(false);
    // The correct input — the raw latest user message — is not a confirmation:
    const latestUserMessage = 'no wait, just show me the inbox first';
    expect(hasProceedSignal(latestUserMessage)).toBe(false);
  });
});
