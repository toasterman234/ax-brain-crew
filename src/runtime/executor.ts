import {
  agent,
  AxAIServiceError,
  AxAIServiceAbortedError,
  AxAIServiceNetworkError,
  AxAIServiceTimeoutError,
  AxAIServiceStreamTerminatedError,
  AxAIServiceStatusError,
} from '@ax-llm/ax';
import { getConfig } from '../config.js';
import { createModelClient, resolveModelId } from '../ai/clients.js';
import { getModelCapability } from '../ai/model-capabilities.js';
import { buildAgentTools } from '../agents/factory.js';
import { getLogger } from '../observability/logger.js';
import { seedPlaybook } from '../playbooks/seed.js';
import { loadPlaybookSnapshot, savePlaybookSnapshot, appendPlaybookEvent } from '../playbooks/persist.js';
import type { ValidatedAgent } from '../registry/loader.js';
import type { AgentResult, ChangedFile, EvidenceItem } from '../types.js';

// ─── Retry alignment ────────────────────────────────────────────────────
// Ax v23 has its own infrastructure retry loop (up to 3 retries with
// exponential backoff for 5xx/network/timeout/stream errors). When our crew-
// level AbortSignal.timeout() fires during ax's retry backoff sleep, ax
// throws AxAIServiceAbortedError("infrastructure-retry-backoff") — a
// completely misleading error that makes it look like the proxy is down.
//
// The fix: disable ax's retry (retry: { maxRetries: 0 }) and retry at the
// crew level, where we control the abort signal and can produce accurate
// error messages. The crew retry loop respects the same abort signal:
// before each retry, check if the turn has timed out, and if so, surface
// the real error rather than continuing.

/** HTTP status codes the crew retries on (matches ax's built-in set). */
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 529]);

/** Crew-level retry config — shorter max delay than ax (30s vs 60s) since
 *  the full turn budget is only 120s. */
const CREW_RETRY = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  backoffFactor: 2,
};

/**
 * True when the error is an infrastructure failure a retry MIGHT fix.
 * Explicitly excludes AbortedError — retrying an aborted request is nonsense.
 */
function isRetryableInfrastructureError(err: unknown): boolean {
  if (err instanceof AxAIServiceAbortedError) return false;
  if (err instanceof AxAIServiceStatusError) {
    return RETRYABLE_STATUS_CODES.has(err.status);
  }
  return (
    err instanceof AxAIServiceNetworkError ||
    err instanceof AxAIServiceTimeoutError ||
    err instanceof AxAIServiceStreamTerminatedError
  );
}


// ─── Daemon crash guard ──────────────────────────────────────────────────
// On a timeout/abort, ax's forward() can orphan an in-flight fetch's abort
// rejection (no awaiter once the main promise has already rejected). That
// surfaces as an unhandledRejection which HARD-CRASHES the process before the
// catch below can finalize the run as failed — turning a recoverable timeout
// into a dead daemon + a stuck 'started' row (observed during E1). We install a
// scoped safety net once: swallow ONLY timeout/abort-shaped orphan rejections
// (the primary rejection is still caught in-band and finalizes the run); every
// other unhandled rejection is rethrown so genuine bugs still crash + stay
// visible. Paired with using a single abort pathway (abortSignal only) below.
let crashGuardInstalled = false;
function installTimeoutCrashGuard(): void {
  if (crashGuardInstalled) return;
  crashGuardInstalled = true;
  process.on('unhandledRejection', (reason) => {
    if (isTimeoutError(reason)) {
      getLogger().warn(
        { reason: String(reason) },
        'Swallowed orphaned timeout/abort rejection (run already finalized in-band)',
      );
      return;
    }
    // Preserve default crash semantics for genuine unhandled rejections.
    throw reason;
  });
}
installTimeoutCrashGuard();

export interface ExecutionContext {
  agent: ValidatedAgent;
  input: string;
  dryRun: boolean;
  // Threads the dispatcher's runId into ax's forward() as sessionId so RLM
  // action logs don't bleed across concurrent runs.
  runId?: string;
  // True only for skill runs (inbox-triage, vault-assess, ...) — see buildTaskPrompt.
  verboseFormat?: boolean;
  // Per-call function-call round budget. Overrides the global CREW_MAX_STEPS
  // default (4) — flow nodes that must genuinely crawl the vault (e.g. an inline
  // audit) need more rounds than a quick chat turn.
  maxSteps?: number;
  // Called when a tool starts; may return a callback invoked with the tool's
  // result so tracers can capture inputs, outputs, and duration.
  onToolCall?: (
    toolName: string,
    input: unknown,
  ) => ((result: unknown) => void) | void;
}

export interface ExecutionResult {
  success: boolean;
  result: AgentResult;
  error?: string;
}

function buildTaskPrompt(
  agentDef: ValidatedAgent,
  userInput: string,
  dryRun: boolean,
  verboseFormat: boolean,
): string {
  const dryRunNote = dryRun
    ? '\n\nIMPORTANT: Dry-run mode is active. All write operations will return previews without modifying files. Mention this in your response.'
    : '';

  // Only skill runs (inbox-triage, vault-assess, vault-audit, deep-clean, ...) get the
  // structured report format — plain agent chat ("hi", "save this thought") stays
  // conversational and shouldn't be forced through TL;DR/confidence-tag/Next-steps.
  const formatStandard = verboseFormat
    ? `
## Response Formatting Standard
The "response" field is the ONLY part of your output a human actually reads. Default to the
Markdown shape below UNLESS this skill's own instructions specify a different output (e.g.
braindump-triage writes real per-item notes + a Base view instead of an inline table — in
that case follow the skill's instructions and keep "response" to a short pointer at those
files, not a duplicate table).

**TL;DR:** one line stating the overall outcome before any detail.

Then a single Markdown table, one row per item/claim/finding, columns exactly:

| Item | Original | Confidence | Source | Related | Next |
|---|---|---|---|---|---|

- **Item** — the claim or thing being triaged, short.
- **Original** — a "[[wikilink#anchor\\|link]]" back to the exact raw text the user wrote for
  this item, or "—" if there is no raw source (e.g. this row was generated, not user-supplied).
  If the user pasted a multi-item list and no raw copy exists yet in \`raw/\`, WRITE ONE FIRST:
  save the verbatim, unedited paste to \`raw/<date>-<slug>.md\` with one \`## <item-slug>\` heading
  per item, then link each table row to its own anchor. Never edit \`raw/\` after creating it.
- **Confidence** — "[HIGH]", "[MED]", or "[LOW]", plus a few words on why.
- **Source** — "vault: Path/To/Note.md" for something read directly from the vault,
  "web: https://source" for something from a completed research.enqueue job, "agentmemory: ..."
  for something recalled from memory, or "—" if there is no source (e.g. a pure thesis/ask).
  If a claim needs broader research than the vault has, say so here instead of silently
  answering from the vault alone and implying that's the full picture.
- **Related** — "[[wikilinks]]" to other vault notes this connects to, or "—" if none. ONLY link
  to a note that actually exists in this vault (verify with vault.search/vault.read first) — an
  unresolved wikilink opens as an empty note in Obsidian, which is worse than no link. If the
  related thing lives outside the vault (agentmemory, another repo) and is worth a real link,
  write a short real note for it first (e.g. in Knowledge/) and link to THAT, not to the
  external system's own identifier.
- **Next** — the concrete follow-up action for THIS row, as its own trailing column cell —
  never folded into the Item cell, never in a separate section below the table. If an action
  spans multiple rows (e.g. "file these three rows into one Projects/ note"), write it into
  the Next cell of each row it applies to — do not add a section after the table for it.

Nothing goes below the table. Every next step, every cross-row note, lives inside a row's Next
cell — a trailing "crew-wide" list is exactly what this format replaces.
`
    : '';

  // Scope-first directive: every agent must exhaust its tools before asking
  // the user or handing off. Conductor has this in its instructions already;
  // specialists get a condensed version.
  const scopeDirective = agentDef.id === 'conductor'
    ? ''
    : `## Scoping Rule
Before acting on this request, use your available tools to gather context and resolve ambiguity. Only hand off to conductor or ask for help when your tools cannot answer the question.`;

  return `${scopeDirective}

${agentDef.instructions}

## Current Request
${userInput}${dryRunNote}
${formatStandard}`;
}

// The typed output fields ax parses out of the agent's structured response.
// A bare `string` output always validates, so ax never runs its
// parse-validate-retry loop; typed fields turn that machinery back on.
//
// changedFiles/evidenceItems are plain `string` fields, NOT `json`/array
// fields. ax treats any `json`/array/object field as a "complex field" and
// runs an internal parse-validate-retry loop (up to 3 attempts) that, on
// failure, throws and fails the ENTIRE forward() call — including the other
// fields (taskStatus, responseText, ...) that parsed fine. One malformed
// token in a 10-item evidence array was enough to kill a whole run with zero
// salvageable output (incident-008 — seeker's AxGenerateError: Invalid JSON).
// Keeping these as strings and parsing them ourselves in toAgentResult lets a
// bad array degrade to `[]` with a warning instead of failing the run.
//
// Field names are deliberately descriptive (taskStatus, responseText, ...):
// ax v23 added a signature validator that rejects "too generic" names like
// `status`, `response`, `summary`, `evidence`, `warnings`. toAgentResult maps
// these back onto the crew's AgentResult shape.
const AGENT_OUTPUT_SIGNATURE =
  'task:string -> ' +
  'taskStatus:class "completed, needs_input, blocked, failed", ' +
  'responseText:string, ' +
  'summaryText:string, ' +
  'changedFiles?:string "JSON array of {path, operation, previousPath?, description} objects, or omit if none", ' +
  'evidenceItems?:string "JSON array of {path, excerpt?, relevance} objects, or omit if none", ' +
  'suggestedNextAgent?:string, ' +
  'nextAgentReason?:string, ' +
  'nextAgentContext?:string, ' +
  'warningMessages?:string[]';

// Best-effort JSON-array parse for a field ax no longer validates for us
// (see AGENT_OUTPUT_SIGNATURE above). Malformed or missing input degrades to
// an empty array instead of failing the run; the caller is told via warnings.
export function parseJsonArrayField<T>(
  value: unknown,
  warnings: string[],
  fieldLabel: string,
): T[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    warnings.push(
      `${fieldLabel} was not valid JSON — ignored (raw: ${value.slice(0, 150)})`,
    );
    return [];
  }
}

// Detect when an agent's "response" is really a raw vault note it just read and
// regurgitated instead of doing its job (see incident-008: the investigator
// echoed incident-workflow.md verbatim and the run was still marked completed).
// A vault note opens with a YAML frontmatter fence carrying our house keys
// (type/ai-first/date). A genuine agent response is prose/tables/a summary — it
// does not begin with our frontmatter block. Precise on purpose: only fires on
// a leading frontmatter fence, so normal answers that merely mention "---" or
// quote a snippet are unaffected.
export function looksLikeRawFileEcho(response: string): boolean {
  const trimmed = response.trimStart();
  if (!trimmed.startsWith('---\n') && !trimmed.startsWith('---\r\n')) {
    return false;
  }
  const end = trimmed.indexOf('\n---', 4);
  const frontmatter = (end === -1 ? trimmed.slice(0, 400) : trimmed.slice(0, end))
    .toLowerCase();
  // Our vault frontmatter always carries at least one of these house keys.
  const houseKeys = ['ai-first:', 'type:', 'tags:', 'date:'];
  return houseKeys.filter((k) => frontmatter.includes(k)).length >= 2;
}

// Coerce a nullable/blank suggestedNextAgent into a real handoff target or null.
// Models routinely emit "null"/"none"/"" for "no handoff" — treat those as none.
function normalizeHandoffTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /^(null|none|n\/a)$/i.test(trimmed)) return null;
  return trimmed;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

// Map ax's typed forward() result into the crew's AgentResult shape.
function toAgentResult(
  out: Record<string, unknown>,
  fallbackName: string,
): AgentResult {
  const response =
    typeof out.responseText === 'string' ? out.responseText : '';
  const status =
    (out.taskStatus as AgentResult['status']) ?? 'completed';
  const warnings = Array.isArray(out.warningMessages)
    ? [...(out.warningMessages as string[])]
    : [];
  const changedFiles = parseJsonArrayField<ChangedFile>(
    out.changedFiles,
    warnings,
    'changedFiles',
  );
  const evidence = parseJsonArrayField<EvidenceItem>(
    out.evidenceItems,
    warnings,
    'evidenceItems',
  );
  return {
    status,
    response: response || `${fallbackName} returned no response`,
    summary:
      typeof out.summaryText === 'string' && out.summaryText.trim()
        ? out.summaryText
        : response.slice(0, 200),
    changedFiles,
    evidence,
    suggestedNextAgent: normalizeHandoffTarget(out.suggestedNextAgent),
    nextAgentReason: optionalString(out.nextAgentReason),
    nextAgentContext: optionalString(out.nextAgentContext),
    warnings,
  };
}

/**
 * Build a fresh AxAgent instance with the canonical playbook wiring
 * (persisted seed, learn:true, onUpdate→save).  This is the single
 * agent-construction path shared by executor (runtime) and serve (admin
 * ops — update/evolve). Pass `functions` for runtime use; omit for
 * playbook-only admin operations.
 */
export function buildAgentInstance(
  agentDef: ValidatedAgent,
  options?: { functions?: any[]; studentAI?: any; teacherAI?: any },
) {
  const persistedPlaybook = loadPlaybookSnapshot(agentDef.id);
  return agent(AGENT_OUTPUT_SIGNATURE, {
    agentIdentity: {
      name: agentDef.name,
      description: agentDef.description,
    },
    functions: options?.functions ?? [],
    bubbleErrors: [AxAIServiceError],
    playbook: {
      playbook: persistedPlaybook ?? seedPlaybook(agentDef.id),
      learn: true,
      studentAI: options?.studentAI,
      teacherAI: options?.teacherAI,
      onUpdate: (result) => {
        savePlaybookSnapshot(agentDef.id, result.snapshot);
        appendPlaybookEvent(agentDef.id, {
          ts: new Date().toISOString(),
          status: result.status,
          skipReason: result.skipReason,
          signalKinds: result.signals.map((s) => s.kind),
          feedback: result.feedback,
        });
      },
    },
  });
}

export async function executeAgent(
  ctx: ExecutionContext,
): Promise<ExecutionResult> {
  const logger = getLogger();
  const {
    agent: agentDef,
    input,
    dryRun,
    verboseFormat = false,
    runId,
    maxSteps: maxStepsOverride,
  } = ctx;

  const modelTier = agentDef.modelTier;
  const llm = createModelClient(modelTier, agentDef.model);

  // Tool-calling behavior travels with the actual model this agent runs on, not
  // a global hardcode. DeepSeek V4 → 'prompt' (no native tool_choice); native-
  // capable models (GPT/Claude/…) → 'auto'. Unlisted models fall back to 'auto'
  // (ax's default) so the crew stays model-agnostic. See model-capabilities.ts.
  const resolvedModelId = resolveModelId(modelTier, agentDef.model);
  const functionCallMode = getModelCapability(resolvedModelId).functionCallMode;

  logger.info(
    {
      agentId: agentDef.id,
      modelTier,
      dryRun,
      tools: agentDef.allowedTools.map((t) => t.name),
    },
    `Executing ${agentDef.name}`,
  );

  // Buffer tool-call trace events per attempt instead of forwarding them to
  // ctx.onToolCall live. A crew-level infra retry re-runs forward() from
  // scratch with the SAME tool set, so a real tool call happens on every
  // attempt — without buffering, a retried run doubles (or triples) every
  // 🔧 line in the Slack trace even though only one attempt's result is ever
  // used. Each attempt's events are flushed (shown) only if that attempt is
  // terminal (succeeds, or fails in a way that won't be retried); events from
  // an attempt that's about to be silently retried are discarded.
  interface BufferedToolEvent {
    tool: string;
    args: unknown;
    result?: unknown;
    hasResult: boolean;
  }
  let attemptEvents: BufferedToolEvent[] = [];
  const bufferedOnToolCall = ctx.onToolCall
    ? (toolName: string, args: unknown) => {
        const record: BufferedToolEvent = { tool: toolName, args, hasResult: false };
        attemptEvents.push(record);
        return (result: unknown) => {
          record.result = result;
          record.hasResult = true;
        };
      }
    : undefined;
  const flushAttemptEvents = (): void => {
    if (!ctx.onToolCall) return;
    for (const rec of attemptEvents) {
      const finish = ctx.onToolCall(rec.tool, rec.args);
      if (rec.hasResult && typeof finish === 'function') finish(rec.result);
    }
  };

  const tools = buildAgentTools(
    agentDef.allowedTools.map((t) => t.name),
    dryRun,
    bufferedOnToolCall,
  );

  const taskPrompt = buildTaskPrompt(agentDef, input, dryRun, verboseFormat);

  const agentInstance = buildAgentInstance(agentDef, {
    functions: tools as any[],
    studentAI: llm,
  });

  // Per-agent step floors: agents with a genuinely multi-step playbook need
  // more function-call rounds than a quick chat turn. The investigator runs an
  // 8-step incident workflow (assess → recurrence check → diagnose → classify
  // → root cause → write report → append log → report back) and stalls out at
  // the default 4 (incident-008).
  const AGENT_MAX_STEPS: Record<string, number> = { investigator: 12 };
  const maxSteps =
    maxStepsOverride ??
    AGENT_MAX_STEPS[agentDef.id] ??
    Number(process.env.CREW_MAX_STEPS ?? 4);
  const timeoutMs = getConfig().llmTimeoutMs;

  // ── Run forward() with crew-level infrastructure retry ────────────
  // Per-attempt abort signals (incident-012 fix): the 120s budget is enforced
  // as a deadline against Date.now(), not a single AbortSignal.timeout() that
  // spans the entire retry loop. Each forward() call gets a scoped signal for
  // ITS remaining budget — so a timeout exposes the real error (HTTP 429,
  // network failure) instead of a misleading "LLM turn exceeded" from a
  // stale signal that fired during retry backoff (incident-004, incident-012).
  const turnDeadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= CREW_RETRY.maxRetries; attempt++) {
    attemptEvents = [];
    const remainingMs = turnDeadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    try {
      const attemptSignal = AbortSignal.timeout(remainingMs);
      const result = (await agentInstance.forward(
        llm,
        { task: taskPrompt },
        {
          maxSteps,
          abortSignal: attemptSignal,
          functionCallMode,
          // Disable ax's internal retry (see retry alignment above).
          retry: { maxRetries: 0 },
          ...(runId ? { sessionId: runId } : {}),
        },
      )) as Record<string, unknown>;

      // forward() succeeded — this attempt is terminal (never retried from here
      // on), so its tool calls are real and should be surfaced.
      flushAttemptEvents();

      const agentResult = toAgentResult(result, agentDef.name);

      // Output-quality gate: an agent that echoed a raw vault note as its
      // response did NOT complete its task, even though ax validated the
      // typed output. Fail the run so the bridge surfaces it and it isn't
      // silently logged as `completed` (incident-008).
      if (
        agentResult.status !== 'failed' &&
        looksLikeRawFileEcho(agentResult.response)
      ) {
        const msg =
          `${agentDef.name} returned raw file contents instead of a real ` +
          `response (output-quality gate) — likely echoed a vault note it read`;
        logger.error(
          { agentId: agentDef.id, responseLength: agentResult.response.length },
          'Output-quality gate tripped — raw file echo',
        );
        return {
          success: false,
          error: msg,
          result: {
            ...agentResult,
            status: 'failed',
            summary: `Agent ${agentDef.name} failed (raw file echo)`,
            warnings: [...agentResult.warnings, msg],
          },
        };
      }

      logger.info(
        {
          agentId: agentDef.id,
          status: agentResult.status,
          responseLength: agentResult.response.length,
          modelTier,
          attempt: attempt + 1,
        },
        `${agentDef.name} execution complete`,
      );
      return { success: true, result: agentResult };
    } catch (err) {
      lastError = err;

      const clarification = extractClarification(err);
      if (clarification) {
        // Terminal outcome (not retried) — the tool calls that led here were real.
        flushAttemptEvents();
        logger.info({ agentId: agentDef.id }, 'Agent requested clarification');
        return {
          success: true,
          result: {
            status: 'needs_input',
            response: clarification,
            summary: `${agentDef.name} needs clarification`,
            changedFiles: [],
            evidence: [],
            suggestedNextAgent: null,
            nextAgentReason: null,
            nextAgentContext: null,
            warnings: [],
          },
        };
      }

      // Everything from here on is a terminal failure UNLESS the three checks
      // below all pass and we fall through to a silent retry — in that one
      // case we discard this attempt's buffered tool events, since a fresh
      // attempt is about to re-run the same tools and the user should only
      // see the trace once.
      const budgetLeft = turnDeadline - Date.now();
      const willRetry =
        budgetLeft > 0 &&
        isRetryableInfrastructureError(err) &&
        attempt !== CREW_RETRY.maxRetries;
      if (!willRetry) flushAttemptEvents();

      if (budgetLeft <= 0) break;
      if (!isRetryableInfrastructureError(err)) break;
      if (attempt === CREW_RETRY.maxRetries) break;

      const delay = Math.min(
        CREW_RETRY.initialDelayMs * CREW_RETRY.backoffFactor ** attempt,
        CREW_RETRY.maxDelayMs,
      );

      // Cap the sleep to remaining turn budget so we never sleep past the
      // deadline — if the budget is too small for the full delay, sleep what
      // we can and let the next iteration's remainingMs check break naturally.
      const sleepMs = Math.min(delay, budgetLeft);

      logger.warn(
        {
          agentId: agentDef.id,
          attempt: attempt + 1,
          maxRetries: CREW_RETRY.maxRetries,
          delayMs: sleepMs,
          budgetLeftMs: budgetLeft,
          error: String(err).slice(0, 200),
        },
        'Infrastructure error — retrying at crew level',
      );

      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }

  // ── Exhausted all retry attempts (or hit non-retryable error) ─────
  const err = lastError!;
  const timedOut = Date.now() >= turnDeadline || isTimeoutError(err);

  // Surface the real error when we have one — don't bury "HTTP 429" or
  // "network error" under a generic "LLM turn exceeded" message. The turn
  // budget IS enforced (per-attempt abort signals + sleep capping), but the
  // human-facing text should name what actually happened.
  const errText = timedOut
    ? err instanceof AxAIServiceStatusError
      ? `LLM infrastructure error: HTTP ${err.status} after ${CREW_RETRY.maxRetries + 1} attempt${CREW_RETRY.maxRetries ? 's' : ''} (turn budget ${timeoutMs}ms exhausted)`
      : err instanceof AxAIServiceNetworkError
        ? `LLM infrastructure error: network failure after ${CREW_RETRY.maxRetries + 1} attempt${CREW_RETRY.maxRetries ? 's' : ''} — ${err.originalError.message.slice(0, 120)}`
        : err instanceof AxAIServiceTimeoutError
          ? `LLM turn exceeded ${timeoutMs}ms and was aborted (${CREW_RETRY.maxRetries + 1} attempt${CREW_RETRY.maxRetries ? 's' : ''})`
          : `LLM turn exceeded ${timeoutMs}ms and was aborted` +
            (err instanceof AxAIServiceAbortedError
              ? ''
              : ` (last error: ${String(err).slice(0, 120)})`)
    : String(err);

  logger.error({ err, agentId: agentDef.id }, 'Agent execution failed');
  return {
    success: false,
    error: errText,
    result: {
      status: 'failed',
      response: `Execution error: ${errText}`,
      summary: `Agent ${agentDef.name} failed`,
      changedFiles: [],
      evidence: [],
      suggestedNextAgent: null,
      nextAgentReason: null,
      nextAgentContext: null,
      warnings: [errText],
    },
  };
}

// True when the thrown error is a request timeout / abort — either ax's own
// timeout/abort service errors, or the DOMException from AbortSignal.timeout().
function isTimeoutError(err: unknown): boolean {
  const e = err as { name?: string; constructor?: { name?: string } };
  const name = e?.name ?? '';
  const ctor = e?.constructor?.name ?? '';
  return (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    /Timeout|Aborted/.test(ctor) ||
    /timed? ?out|aborted/i.test(String(err))
  );
}

// Ax throws AxAgentClarificationError when the agent needs more info from the
// user; unwrap its question so callers can present it as a normal turn.
function extractClarification(err: unknown): string | null {
  const e = err as { name?: string; message?: string };
  const isClarify =
    e?.name === 'AxAgentClarificationError' ||
    String(err).includes('AxAgentClarificationError');
  if (!isClarify) return null;
  const msg = e?.message ?? String(err);
  return (
    msg.replace(/^.*?AxAgentClarificationError:\s*/, '').trim() ||
    'Could you clarify your request?'
  );
}
