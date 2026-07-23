import { randomUUID } from 'node:crypto';
import { getDb } from './database.js';

// Slack feedback / eval-pair capture — slack-feedback-eval §1+§2.
//
// Two jobs:
//   1. recordSlackRun  — remember every delivered agent reply keyed by its Slack
//      message ts, so a later reaction/reply can resolve back to the run (and its
//      Langfuse trace) it refers to.
//   2. captureFollowup / recordRoutingOverride — mine the labelled signals that
//      a thumbs-up/down can't give you, as *candidate* eval pairs (reviewed=0).

export interface SlackRun {
  message_ts: string;
  channel_id: string;
  thread_ts: string;
  runtime: 'crew' | 'pi';
  route_agent: string | null;
  forced_agent: string | null;
  trace_id: string | null;
  prompt: string;
  response: string;
  created_at: string;
}

export type EvalPairKind = 'routing-override' | 'correction' | 'reprompt';

/** Remember a delivered agent reply so feedback can be attached to it later. */
export function recordSlackRun(params: {
  messageTs: string;
  channelId: string;
  threadTs: string;
  runtime: 'crew' | 'pi';
  routeAgent?: string | null;
  forcedAgent?: string | null;
  traceId?: string | null;
  prompt: string;
  response: string;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO slack_runs
       (message_ts, channel_id, thread_ts, runtime, route_agent, forced_agent,
        trace_id, prompt, response, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.messageTs,
    params.channelId,
    params.threadTs,
    params.runtime,
    params.routeAgent ?? null,
    params.forcedAgent ?? null,
    params.traceId ?? null,
    params.prompt.slice(0, 8000),
    params.response.slice(0, 8000),
    new Date().toISOString(),
  );
}

/** The most recent recorded agent reply in a thread, or undefined. */
export function getLatestSlackRunForThread(
  channelId: string,
  threadTs: string,
): SlackRun | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM slack_runs
       WHERE channel_id = ? AND thread_ts = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(channelId, threadTs) as SlackRun | undefined;
}

// Correction cues: a follow-up carrying one of these reads as "that was wrong"
// rather than a plain next-step ("reprompt"). Deliberately conservative — a
// human reviews candidates before they become an eval set, so precision here
// only affects the kind label, not whether the pair is captured.
const CORRECTION_CUES = [
  'no,', 'no ', 'nope', 'actually', 'wrong', 'not quite', "that's not",
  'thats not', 'incorrect', 'instead', 'should be', "shouldn't", 'should not',
  'not what', "isn't right", 'try again', 'redo', 'fix', 'mistake', 'error',
];

function classifyFollowup(text: string): EvalPairKind {
  const t = text.toLowerCase();
  return CORRECTION_CUES.some((c) => t.includes(c)) ? 'correction' : 'reprompt';
}

function insertEvalPair(params: {
  kind: EvalPairKind;
  channelId: string;
  threadTs: string;
  priorRunTs?: string | null;
  input: string;
  output?: string | null;
  signal: string;
  routeAgent?: string | null;
  traceId?: string | null;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO eval_pairs
       (id, kind, channel_id, thread_ts, prior_run_ts, input, output, signal,
        route_agent, trace_id, reviewed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    randomUUID(),
    params.kind,
    params.channelId,
    params.threadTs,
    params.priorRunTs ?? null,
    params.input.slice(0, 8000),
    params.output != null ? params.output.slice(0, 8000) : null,
    params.signal.slice(0, 8000),
    params.routeAgent ?? null,
    params.traceId ?? null,
    new Date().toISOString(),
  );
}

/**
 * A user posted a follow-up in a thread that already has an agent reply. Treat
 * it as a candidate (original request, wrong answer, corrective signal) eval
 * pair. No-op when there's no prior run in the thread (it's a fresh request).
 * Returns the kind captured, or null if nothing was captured.
 */
export function captureFollowup(params: {
  channelId: string;
  threadTs: string;
  userMessage: string;
}): EvalPairKind | null {
  const msg = params.userMessage.trim();
  if (!msg) return null;

  const prior = getLatestSlackRunForThread(params.channelId, params.threadTs);
  if (!prior) return null;

  const kind = classifyFollowup(msg);
  insertEvalPair({
    kind,
    channelId: params.channelId,
    threadTs: params.threadTs,
    priorRunTs: prior.message_ts,
    input: prior.prompt,       // what was originally asked
    output: prior.response,    // the answer being corrected / retried
    signal: msg,               // the user's corrective / follow-up message
    routeAgent: prior.route_agent,
    traceId: prior.trace_id,
  });
  return kind;
}

/**
 * The user explicitly forced an agent (e.g. `seeker: ...`, `pi: ...`) instead of
 * letting the crew auto-route. That's a labelled routing example: (request →
 * correct agent). Captured as a candidate eval pair.
 */
export function recordRoutingOverride(params: {
  channelId: string;
  threadTs: string;
  request: string;
  forcedAgent: string;
}): void {
  if (!params.request.trim()) return;
  insertEvalPair({
    kind: 'routing-override',
    channelId: params.channelId,
    threadTs: params.threadTs,
    input: params.request,
    signal: params.forcedAgent,   // the agent the user chose = the routing label
    routeAgent: params.forcedAgent,
  });
}
