import { getLogger } from '../observability/logger.js';
import { createModelClient } from '../ai/clients.js';
import type { AxAIOpenAI } from '@ax-llm/ax';

// ---------------------------------------------------------------------------
// Context Summarization — session → checkpoint pipeline
//
// Takes a stream of agent session observations and produces a structured
// summary: decisions, open items, checkpoint, files touched.
//
// Architecture:
//   1. compressObservation()  — deterministic .map(), shrinks raw JSON to 50-150 tokens
//   2. buildSummarizationPrompt() — assembles the LLM prompt
//   3. summarizeObservations() — calls the LLM
//   4. parseSummarizationOutput() — validates and normalizes the JSON response
//
// This module does NOT call agentmemory directly. The calling agent (this
// harness session) fetches observations via agentmemory MCP tools and feeds
// them to summarizeObservations(). That keeps the LLM logic testable and
// MCP-agnostic.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw observation from agentmemory timeline. */
export interface Observation {
  id?: string;
  sessionId?: string;
  timestamp?: string;
  title: string;
  type: string;
  narrative?: string;
  files?: string[];
}

export interface ContextSummarizationInput {
  /** The raw observations to summarize. */
  observations: Observation[];
  /** Session ID for traceability. */
  sessionId: string;
  /** Which project the session was in. */
  project?: string;
  /** Target max tokens for the summary. */
  maxTokens?: number;
}

export interface Decision {
  decision: string;
  rationale: string;
  madeBy: 'Ben' | 'Agent';
  reversible: boolean;
}

export interface OpenItem {
  item: string;
  status: 'blocked' | 'in-progress' | 'waiting-on-ben';
  nextAction: string;
}

export interface FileTouch {
  path: string;
  action: 'created' | 'modified' | 'deleted';
}

export interface ContextSummarizationOutput {
  summary: string;
  decisions: Decision[];
  openItems: OpenItem[];
  checkpoint: string;
  filesTouched: FileTouch[];
  estimatedCompleteness: number;
  sourceSessionId: string;
  warnings?: string[];
  rawResponse?: string;
}

// ---------------------------------------------------------------------------
// Observation compression
// ---------------------------------------------------------------------------

/**
 * Compress a single observation to a 50-150 token summary.
 * Raw observations are JSON-heavy tool calls (200-1000 tokens each).
 * This shrinks them while preserving the signal.
 */
export function compressObservation(obs: Observation): string {
  const ts = obs.timestamp
    ? new Date(obs.timestamp).toISOString().slice(11, 19)
    : '--:--:--';

  switch (obs.type) {
    case 'conversation': {
      const text = (obs.narrative ?? obs.title ?? '').slice(0, 200);
      return `[${ts}] Ben: "${text}"`;
    }

    case 'command_run': {
      const narr = obs.narrative ?? '';
      const parsed = tryParseJson(narr);
      const cmd = picked(parsed, 'command') ?? '';
      const out = picked(parsed, 'stdout') ?? picked(parsed, 'stderr') ?? '';
      const cmdShort = cmd.slice(0, 100);
      const outShort = cleanOutput(out).slice(0, 150);
      return `[${ts}] Bash: \`${cmdShort}\` → ${outShort || '(no output)'}`;
    }

    case 'file_read': {
      const file = obs.files?.[0] ?? extractFilePath(obs.narrative) ?? 'unknown';
      return `[${ts}] Read: ${file.split('/').pop() ?? file}`;
    }

    case 'file_write': {
      const file = obs.files?.[0] ?? extractFilePath(obs.narrative) ?? 'unknown';
      return `[${ts}] Wrote: ${file.split('/').pop() ?? file}`;
    }

    case 'file_edit': {
      const narr = obs.narrative ?? '';
      const parsed = tryParseJson(narr);
      const file = obs.files?.[0] ?? picked(parsed, 'file_path') ?? 'unknown';
      const newStr = picked(parsed, 'new_string') ?? '';
      const snippet = newStr.split('\n')[0]?.slice(0, 100) ?? '';
      return `[${ts}] Edit: ${file.split('/').pop() ?? file} — ${snippet}`;
    }

    case 'web_fetch': {
      const narr = obs.narrative ?? '';
      const parsed = tryParseJson(narr);
      const url = (picked(parsed, 'url') ?? '').slice(0, 80);
      const code = picked(parsed, 'code') ?? picked(parsed, 'status') ?? '?';
      return `[${ts}] Fetch: ${url} (${String(code)})`;
    }

    case 'search': {
      const narr = obs.narrative ?? '';
      const parsed = tryParseJson(narr);
      const query = (picked(parsed, 'query') ?? obs.title ?? '').slice(0, 100);
      return `[${ts}] Search: ${query}`;
    }

    case 'subagent': {
      if (obs.title.includes('start') || obs.title.includes('subagent_start')) {
        return `[${ts}] → Launched subagent`;
      }
      if (obs.title.includes('stop') || obs.title.includes('subagent_stop')) {
        return `[${ts}] ← Subagent returned`;
      }
      return `[${ts}] Subagent: ${obs.title.slice(0, 80)}`;
    }

    case 'error': {
      const narr = obs.narrative ?? '';
      const parsed = tryParseJson(narr);
      const msg = picked(parsed, 'message') ?? picked(parsed, 'error') ?? narr.slice(0, 100);
      return `[${ts}] ⚠️ Error: ${String(msg).slice(0, 100)}`;
    }

    case 'other': {
      if (obs.title === 'ScheduleWakeup') {
        return `[${ts}] ⏰ Scheduled wakeup`;
      }
      if (obs.title === 'ExitPlanMode') {
        return `[${ts}] ✅ Exited plan mode`;
      }
      return `[${ts}] ${obs.title.slice(0, 80)}`;
    }

    default: {
      return `[${ts}] [${obs.type}] ${obs.title.slice(0, 80)}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a session summarizer. Given a chronological stream of observations from an AI coding agent session, produce a structured summary with:

1. A 1-3 paragraph narrative of what happened
2. All irreversible decisions made (and by whom)
3. All open items that still need action
4. An exact checkpoint — where the next agent should resume
5. Files that were created or modified

A "decision" is something that cannot be trivially undone: a file was committed, a design choice was locked in, Ben said "yes proceed" or explicitly chose an option. Ben's approvals ("yes", "proceed", "go", "thats good", "do it") are decisions with madeBy: "Ben".

An "open item" is something the agent was working on but didn't finish: a command is running, a question was asked but not answered, a tool call returned an error that wasn't resolved.

The "checkpoint" should be specific enough that a cold agent reading it knows exactly what to do next. If the session ended mid-task, say "Continue [specific task] by [specific next action]."

Be concise. Every claim must be traceable to a specific observation. If there are no clear decisions, say so — do not fabricate. If nothing is open, say so.`;

export function buildSummarizationPrompt(input: {
  sessionId: string;
  project?: string;
  observations: Observation[];
  maxTokens?: number;
}): { system: string; user: string } {
  const projectLine = input.project ? `Project: ${input.project}` : '';
  const compressed = input.observations.map(compressObservation);

  // Token budget: reserve ~1000 for system + output format, ~3000 for observations
  const TARGET_OBS_TOKENS = 3000;
  let totalTokens = 0;
  const included: string[] = [];

  for (const line of compressed) {
    const lineTokens = line.length / 4; // rough estimate
    if (totalTokens + lineTokens > TARGET_OBS_TOKENS) break;
    included.push(line);
    totalTokens += lineTokens;
  }

  const obsBlock = included.join('\n');
  const truncatedNote =
    included.length < compressed.length
      ? `\n(Showing ${included.length} of ${compressed.length} observations — oldest omitted.)`
      : '';

  const user = `Summarize the following agent session.

Session ID: ${input.sessionId}
${projectLine}
Observations (${included.length} total):

--- BEGIN OBSERVATIONS ---
${obsBlock}
--- END OBSERVATIONS ---${truncatedNote}

Return JSON only. Do not include markdown fences or commentary.`;

  return { system: SYSTEM_PROMPT, user };
}

// ---------------------------------------------------------------------------
// LLM summarization
// ---------------------------------------------------------------------------

export async function summarizeObservations(
  input: ContextSummarizationInput,
  llm?: AxAIOpenAI,
): Promise<ContextSummarizationOutput> {
  const logger = getLogger();
  const client = llm ?? createModelClient('fast');

  const { system, user } = buildSummarizationPrompt({
    sessionId: input.sessionId,
    project: input.project,
    observations: input.observations,
    maxTokens: input.maxTokens,
  });

  logger.info(
    { sessionId: input.sessionId, observationCount: input.observations.length },
    'summarizeObservations: starting LLM call',
  );

  let rawResponse: string;
  try {
    const result = await client.chat(
      { chatPrompt: [{ role: 'user', content: `${system}\n\n---\n\n${user}` }] },
      { stream: false },
    );

    rawResponse =
      (result as any).results?.[0]?.content ??
      (result as any).results?.[0]?.text ??
      (result as any).message?.content ??
      (typeof result === 'string' ? result : JSON.stringify(result));
  } catch (err: any) {
    logger.error({ err, sessionId: input.sessionId }, 'summarizeObservations: LLM call failed');
    throw new Error(`Summarization failed: ${err.message ?? String(err)}`);
  }

  logger.info(
    { sessionId: input.sessionId, responseLength: rawResponse.length },
    'summarizeObservations: LLM response received',
  );

  return parseSummarizationOutput(rawResponse, input.sessionId);
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

export function parseSummarizationOutput(
  raw: string,
  sourceSessionId: string,
): ContextSummarizationOutput {
  const logger = getLogger();
  const warnings: string[] = [];

  // Strip markdown fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    logger.warn({ raw: raw.slice(0, 200) }, 'parseSummarizationOutput: JSON parse failed, using raw text');
    // Fallback: treat entire response as summary
    return {
      summary: raw.slice(0, 500),
      decisions: [],
      openItems: [],
      checkpoint: 'Unable to determine checkpoint — see summary.',
      filesTouched: [],
      estimatedCompleteness: 0.3,
      sourceSessionId,
      warnings: ['LLM response was not valid JSON. Summary is raw text.'],
      rawResponse: raw,
    };
  }

  const decisions: Decision[] = (Array.isArray(parsed.decisions) ? parsed.decisions : [])
    .map((d: any) => ({
      decision: String(d.decision ?? d.Decision ?? ''),
      rationale: String(d.rationale ?? d.Rationale ?? ''),
      madeBy: normalizeMadeBy(String(d.madeBy ?? d.MadeBy ?? 'Agent')),
      reversible: Boolean(d.reversible ?? d.Reversible ?? true),
    }))
    .filter((d: Decision) => d.decision.length > 0);

  const openItems: OpenItem[] = (Array.isArray(parsed.openItems) ? parsed.openItems : [])
    .map((o: any) => ({
      item: String(o.item ?? o.Item ?? ''),
      status: normalizeStatus(String(o.status ?? o.Status ?? 'in-progress')),
      nextAction: String(o.nextAction ?? o.NextAction ?? ''),
    }))
    .filter((o: OpenItem) => o.item.length > 0);

  const filesTouched: FileTouch[] = (
    Array.isArray(parsed.filesTouched) ? parsed.filesTouched : []
  ).map((f: any) => ({
    path: String(f.path ?? f.Path ?? ''),
    action: normalizeAction(String(f.action ?? f.Action ?? 'modified')),
  }));

  const completeness = parseFloat(parsed.estimatedCompleteness);
  let estimatedCompleteness =
    Number.isFinite(completeness)
      ? Math.max(0, Math.min(1, Math.round(completeness * 100) / 100))
      : 0.5;

  if (!Number.isFinite(parseFloat(parsed.estimatedCompleteness))) {
    warnings.push('estimatedCompleteness was not a valid number — defaulting to 0.5');
  }

  const checkpoint = String(parsed.checkpoint ?? parsed.Checkpoint ?? '');
  if (!checkpoint) {
    warnings.push('No checkpoint in LLM output — summary may not be actionable');
  }

  return {
    summary: String(parsed.summary ?? parsed.Summary ?? '').slice(0, 2000),
    decisions,
    openItems,
    checkpoint: checkpoint || 'See summary for context.',
    filesTouched,
    estimatedCompleteness,
    sourceSessionId,
    warnings: warnings.length > 0 ? warnings : undefined,
    rawResponse: raw,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryParseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function picked(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  if (typeof val === 'string' && val.length > 0) return val;
  if (typeof val === 'number') return String(val);
  if (typeof val === 'boolean') return String(val);
  return undefined;
}

function extractFilePath(narrative: string | undefined): string | undefined {
  if (!narrative) return undefined;
  const parsed = tryParseJson(narrative);
  return picked(parsed, 'file_path');
}

function cleanOutput(raw: string): string {
  // Collapse whitespace, strip ANSI, truncate
  return raw
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMadeBy(raw: string): 'Ben' | 'Agent' {
  const lower = raw.toLowerCase();
  return lower.startsWith('b') || lower.includes('human') ? 'Ben' : 'Agent';
}

function normalizeStatus(raw: string): 'blocked' | 'in-progress' | 'waiting-on-ben' {
  const lower = raw.toLowerCase();
  if (lower.includes('block')) return 'blocked';
  if (lower.includes('wait') || lower.includes('ben')) return 'waiting-on-ben';
  return 'in-progress';
}

function normalizeAction(raw: string): 'created' | 'modified' | 'deleted' {
  const lower = raw.toLowerCase();
  if (lower.includes('creat') || lower.includes('wrote')) return 'created';
  if (lower.includes('delet') || lower.includes('remov')) return 'deleted';
  return 'modified';
}

// ---------------------------------------------------------------------------
// Metric function (for GEPA optimization)
// ---------------------------------------------------------------------------

export interface SummarizationGroundTruth {
  expectedDecisions: string[];
  expectedOpenItems: string[];
  expectedCheckpoint: string;
}

export function summarizationMetric(params: {
  output: ContextSummarizationOutput;
  groundTruth: SummarizationGroundTruth;
}): { score: number; details: Record<string, number> } {
  const { output, groundTruth } = params;

  // Axis 1: Coverage — recall of ground-truth decisions and open items
  const decisionsLower = output.decisions.map((d) => d.decision.toLowerCase());
  const gtDecisionsLower = groundTruth.expectedDecisions.map((d) => d.toLowerCase());

  const decisionsRecall =
    gtDecisionsLower.length > 0
      ? gtDecisionsLower.filter((d) =>
          decisionsLower.some((od) => od.includes(d) || d.includes(od)),
        ).length / gtDecisionsLower.length
      : 1;

  const openItemsLower = output.openItems.map((o) => o.item.toLowerCase());
  const gtOpenLower = groundTruth.expectedOpenItems.map((o) => o.toLowerCase());

  const openItemsRecall =
    gtOpenLower.length > 0
      ? gtOpenLower.filter((o) =>
          openItemsLower.some((oo) => oo.includes(o) || o.includes(oo)),
        ).length / gtOpenLower.length
      : 1;

  const coverageScore = 0.4 * (decisionsRecall * 0.6 + openItemsRecall * 0.4);

  // Axis 2: Compression — lower token count is better
  const summaryTokens = output.summary.length / 4;
  // Cap: assume raw observations are ~10K tokens, anything under 2000 is good
  const compressionScore = 0.2 * Math.min(1, Math.max(0, 1 - summaryTokens / 2000));

  // Axis 3: Actionability — heuristic: checkpoint specificity
  // A good checkpoint is specific (multiple words, contains an action verb)
  const checkpointWords = output.checkpoint.split(/\s+/).filter(Boolean).length;
  const hasActionVerb =
    /\b(continue|implement|build|fix|add|remove|update|run|test|deploy|write|edit|create|delete|merge|commit)\b/i.test(
      output.checkpoint,
    );
  const checkpointScore =
    0.4 *
    (Math.min(1, checkpointWords / 20) * 0.5 + (hasActionVerb ? 0.5 : 0));

  const score = Math.round((coverageScore + compressionScore + checkpointScore) * 100) / 100;

  return {
    score,
    details: {
      decisionsRecall,
      openItemsRecall,
      coverageScore,
      compressionScore,
      checkpointScore,
    },
  };
}
