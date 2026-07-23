import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getLogger } from '../observability/logger.js';
import { normalizeRequest } from '../routing/normalize.js';
import { skillRoute } from '../routing/skill-router.js';
import { classifyRequest } from '../routing/agent-router.js';
import {
  enforcePolicy,
  enforceToolSafety,
} from '../routing/routing-policy.js';
import { TOOL_REGISTRY } from '../tools/index.js';
import { executeAgent } from './executor.js';
import {
  validateHandoff,
  buildHandoffPacket,
} from './handoffs.js';
import { getAgent, type ValidatedAgent } from '../registry/registry.js';
import { getAllSkills } from '../skills/executor.js';
import { getLangfuse, flushLangfuse } from '../observability/langfuse.js';
import { matchFlow } from '../flows/registry.js';
import {
  buildRoutingCoordinator,
} from '../composition/coordinator.js';
import type { OrchestratorConfig } from '../composition/orchestrator-config.js';
import { createRouterClient } from '../ai/clients.js';

// Side-effect imports: each flow file calls registerFlow() at module level
import '../flows/braindump-triage.js';
import '../flows/deep-clean.js';
import '../flows/defrag.js';
import '../flows/prior-art.js';
import '../flows/project-scaffold.js';
import '../flows/tag-garden.js';
import '../flows/triage-route.js';
import '../flows/vault-assess.js';
import '../flows/vault-audit.js';
import type { RouteDecision, AgentResult, HandoffPacket } from '../types.js';

// Appended to an approval-gated skill's prompt so the delegate agent produces a
// plan instead of just doing the work. Writes are already blocked (forced
// dry-run); this makes the response read as a proposal.
const APPROVAL_PLAN_DIRECTIVE =
  '\n\nIMPORTANT: This skill requires user approval before making changes. ' +
  'Produce a concrete PLAN of exactly what you would change (which notes, which ' +
  'moves/edits), but do NOT present it as done — it is a proposal awaiting ' +
  'confirmation. All write tools are in dry-run and will only preview.';

// Detect an explicit "go ahead and run it for real" signal in a follow-up
// message, so a confirmed approval-gated skill executes without re-prompting.
//
// SECURITY: this MUST run against the user's LATEST raw message only (see
// `DispatchInput.confirmationText`), never the assembled request/transcript.
// The assembled request prepends the prior conversation (`## Conversation so
// far …`), which includes the crew's own approval prompt text ('Reply "proceed"
// (or "yes, go ahead")'). Matching against that transcript let ANY later
// approval-gated turn auto-approve regardless of what the user actually typed
// (transcript poisoning). It also matched confirm words embedded anywhere in a
// longer task ("deep clean my vault and confirm the results with me"), causing
// first-turn false-positive auto-writes.
//
// The rule: only treat a message as a proceed signal when it is a SHORT,
// STANDALONE confirmation — the whole message is essentially just a
// confirmation phrase (allowing minor punctuation/filler), NOT a task
// instruction that merely contains a confirm word.

// Single dominant confirmation words. A one-word message equal to any of these
// is a proceed signal; in a multi-word message these count as confirm tokens.
const CONFIRM_WORDS = new Set([
  'proceed',
  'confirm',
  'confirmed',
  'yes',
  'yep',
  'yeah',
  'yup',
  'ok',
  'okay',
  'sure',
  'y',
  'approve',
  'approved',
  'affirmative',
]);

// Standalone multi-word confirmation phrases (matched as the whole message).
const CONFIRM_PHRASES = [
  'go ahead',
  'do it',
  'run it',
  'execute it',
  'apply it',
  'apply the plan',
  'apply the changes',
  'make the changes',
  'yes please',
  'go for it',
  'sounds good',
  'looks good',
  'ship it',
  'send it',
];

// Filler/connective words allowed to accompany a confirmation without turning it
// into a task. Deliberately excludes real task verbs (deep, clean, defrag,
// audit, triage, migrate, calendar, …) so those never read as approval.
const CONFIRM_FILLER = new Set([
  ...CONFIRM_WORDS,
  'please',
  'now',
  'then',
  'and',
  'go',
  'ahead',
  'do',
  'it',
  'just',
  'lets',
  "let's",
  'the',
  'plan',
  'changes',
  'make',
  'apply',
  'run',
  'execute',
  'for',
]);

/**
 * True only when `message` is a short, standalone confirmation ("proceed",
 * "yes, go ahead", "ok do it") — NOT a longer task that merely contains a
 * confirm word. Pass the user's LATEST raw message, never the assembled
 * request/transcript.
 */
export function hasProceedSignal(message: string): boolean {
  const cleaned = (message ?? '')
    .toLowerCase()
    .replace(/[.!?,;:"()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return false;

  const tokens = cleaned.split(' ');
  // A genuine confirmation is brief; anything longer is a task request.
  if (tokens.length > 5) return false;

  // Whole message is a known standalone confirmation phrase.
  if (CONFIRM_PHRASES.includes(cleaned)) return true;

  // Single dominant confirmation word.
  if (tokens.length === 1) return CONFIRM_WORDS.has(tokens[0]!);

  // Multi-word: must contain a confirm word/phrase AND every token must be a
  // confirm word or allowed filler — no real task verb may sneak in.
  const hasConfirm =
    tokens.some((t) => CONFIRM_WORDS.has(t)) ||
    CONFIRM_PHRASES.some((p) => cleaned.includes(p));
  if (!hasConfirm) return false;
  return tokens.every((t) => CONFIRM_FILLER.has(t));
}

export interface TraceEvent {
  kind: 'route' | 'agent' | 'tool' | 'tool_result' | 'langfuse';
  agent?: string;
  tool?: string;
  args?: unknown;
  result?: unknown;
  /** Shared ID linking tool_call → tool_result events (client matches on this) */
  callId?: string;
  detail?: string;
  /** Source location + tuning tips from the tool registry */
  source?: { file: string; line: number; function: string; tuningTips?: string[] };
  /** Langfuse trace URL (sent once per run when tracing is enabled) */
  langfuseUrl?: string;
  /** Raw Langfuse trace id — lets a downstream client (Slack bridge) attach
   *  feedback scores to this exact run. Sent alongside langfuseUrl. */
  traceId?: string;
}

export interface DispatchInput {
  request: string;
  agents: ValidatedAgent[];
  /**
   * The user's LATEST raw message, used SOLELY for the approvalRequired proceed
   * check — kept distinct from `request` (which prepends the conversation
   * transcript for routing). Reusing `request` here re-enabled the gate bypass
   * (the transcript carries the crew's own 'Reply "proceed"' prompt). When
   * omitted (e.g. the `ask` one-shot, where the latest message IS the request
   * with no transcript), `request` is used — safe because there is no history.
   */
  confirmationText?: string;
  onEvent?: (event: TraceEvent) => void;
  /** Optional Langfuse grouping — session id + where the request came from. */
  traceMeta?: { sessionId?: string; source?: string };
  /**
   * When set and mode is 'orchestrator', the native coordinator loop replaces
   * the dispatcher's linear handoff chain for conductor-routed requests.
   * (Slice P — orchestrator integration.)
   */
  activeOrchestratorConfig?: OrchestratorConfig | null;
}

export interface DispatchOutput {
  route: RouteDecision;
  results: AgentResult[];
  handoffs: { from: string; to: string; reason: string }[];
  finalResponse: string;
  warnings: string[];
  /**
   * Populated when the run failed: the reason a failed run persists into
   * runs.error. Null on a clean completion. Callers use this (not just result
   * status) to finalize the run row (see persistence.finalizeRun).
   */
  error: string | null;
}

export async function dispatch(input: DispatchInput): Promise<DispatchOutput> {
  const logger = getLogger();
  const config = getConfig();
  const { request, agents, onEvent } = input;
  // Proceed check runs against the latest user message ONLY. Falls back to
  // `request` only when no separate confirmation text was threaded (the `ask`
  // one-shot path, which has no transcript to poison).
  const confirmationText = input.confirmationText ?? request;
  const runId = randomUUID();
  logger.info({ runId, request }, 'run.started');

  // --- Langfuse tracing (no-op when disabled) ---
  const lf = getLangfuse();
  const trace = lf?.trace({
    name: 'crew.request',
    input: request,
    sessionId: input.traceMeta?.sessionId,
    tags: ['ax-brain-crew', input.traceMeta?.source ?? 'cli'].filter(Boolean),
    metadata: { runId },
  });
  // Emit Langfuse trace URL so the visual lab can link to it
  if (trace && lf) {
    const baseUrl = process.env.LANGFUSE_BASEURL ?? process.env.LANGFUSE_BASE_URL ?? process.env.QODER_LANGFUSE_BASE_URL ?? '';
    onEvent?.({ kind: 'langfuse', langfuseUrl: `${baseUrl}/trace/${trace.id}`, traceId: trace.id });
  }

  // Close the trace and flush on every return path. Derives `error` when the
  // caller didn't set it: any failed agent result (or an explicit dispatch-level
  // failure) becomes the persisted runs.error reason. A clean run leaves it null.
  const finalize = async (
    partial: Omit<DispatchOutput, 'error'> & { error?: string | null },
  ): Promise<DispatchOutput> => {
    const failed = partial.results.find((r) => r.status === 'failed');
    const error =
      partial.error ??
      (failed
        ? failed.summary || failed.response || 'Agent run failed'
        : null);
    const out: DispatchOutput = { ...partial, error };
    trace?.update({
      output: out.finalResponse,
      metadata: { route: out.route.routeId, routeType: out.route.routeType },
    });
    await flushLangfuse();
    return out;
  };

  // Run one agent wrapped in a Langfuse span + generation, tapping its tools.
  // dryRunOverride forces dry-run regardless of config (used to enforce
  // approvalRequired on skills — plan-only until the user confirms).
  const runAgentTraced = async (
    agentDef: ValidatedAgent,
    agentInput: string,
    verboseFormat = false,
    dryRunOverride?: boolean,
  ) => {
    const span = trace?.span({ name: `agent:${agentDef.id}`, input: agentInput });
    const startedAt = new Date();
    const exec = await executeAgent({
      agent: agentDef,
      input: agentInput,
      dryRun: dryRunOverride ?? config.dryRun,
      verboseFormat,
      runId,
      onToolCall: (tool, args) => {
        const callId = randomUUID();
        const meta = TOOL_REGISTRY.find((t) => t.name === tool);
        onEvent?.({ kind: 'tool', tool, args, source: meta?.source, callId });
        const toolSpan = span?.span({ name: `tool:${tool}`, input: args });
        return (result: unknown) => {
          toolSpan?.end({ output: result });
          onEvent?.({ kind: 'tool_result', tool, result, source: meta?.source, callId });
        };
      },
    });
    span?.generation({
      name: agentDef.id,
      model: agentDef.model ?? config.modelTiers[agentDef.modelTier],
      input: agentInput,
      output: exec.result.response,
      startTime: startedAt,
      endTime: new Date(),
      metadata: { status: exec.result.status, tier: agentDef.modelTier },
    });
    span?.end({ output: exec.result.response });
    return exec;
  };

  let route: RouteDecision = {
    routeType: 'none',
    routeId: null,
    confidence: 0,
    reason: 'dispatch not yet routed',
    alternatives: [],
    clarificationQuestion: null,
  };

  try {
  const explicit = normalizeRequest(request, agents);
  if (explicit) {
    route = explicit;
    logger.info({ route }, 'route.selected (explicit)');
  } else {
    const skillMatch = skillRoute(request);
    if (skillMatch) {
      route = skillMatch;
      logger.info({ route }, 'route.selected (skill)');
    } else {
      logger.info('route.started (classifier)');
      const routeStart = new Date();
      const classified = await classifyRequest(request, agents);
      route = enforcePolicy(classified, agents);
      logger.info({ route }, 'route.selected (classified)');
      trace?.generation({
        name: 'route.classify',
        model: config.modelTiers.router,
        input: request,
        output: route,
        startTime: routeStart,
        endTime: new Date(),
        metadata: { confidence: route.confidence, reason: route.reason },
      });
    }
  }

  if (route.routeType === 'skill') {
    // Check the flow registry first (ax-native flow() pipelines).
    // If the skill was migrated to a flow, run it directly.
    // Otherwise fall back to agent delegation for unmigrated skills.
    const flow = matchFlow(request);
    if (flow) {
      const confirmed = hasProceedSignal(confirmationText);
      const flowDryRun = flow.approvalRequired && !confirmed;
      route = {
        ...route,
        reason: `Flow "${flow.name}" (ax-native${flowDryRun ? ', plan-only pending approval' : ''})`,
      };
      onEvent?.({
        kind: 'route',
        agent: `${flow.id}-flow`,
        detail: flowDryRun
          ? `flow "${flow.name}" (approval required — plan only)`
          : `flow "${flow.name}"`,
      });
      const flowSpan = trace?.span({
        name: `flow:${flow.id}`,
        input: request,
      });
      try {
        const flowRun = await flow.run({ request, runId, dryRun: flowDryRun });
        flowSpan?.end({ output: flowRun.finalResponse });
        const warnings = flowRun.warnings ?? [];
        const result: AgentResult = {
          status: flowDryRun ? 'needs_input' : 'completed',
          response: flowRun.finalResponse,
          summary: warnings.length > 0
            ? `Flow "${flow.name}": ${warnings.length} warning(s)`
            : `Flow "${flow.name}" completed`,
          changedFiles: [],
          evidence: [],
          suggestedNextAgent: null,
          nextAgentReason: null,
          nextAgentContext: null,
          warnings: [
            ...warnings,
            ...(flowDryRun
              ? [`Flow "${flow.name}" requires approval; ran plan-only (dry-run) pending confirmation.`]
              : []),
          ],
        };
        return finalize({
          route,
          results: [result],
          handoffs: [],
          finalResponse: result.response,
          warnings: result.warnings,
        });
      } catch (err) {
        const reason = String(err);
        flowSpan?.end({ output: reason });
        logger.error({ runId, err }, `flow "${flow.id}" failed`);
        return finalize({
          route,
          results: [
            {
              status: 'failed',
              response: `Flow "${flow.name}" failed: ${reason}`,
              summary: `Flow "${flow.name}" failed`,
              changedFiles: [],
              evidence: [],
              suggestedNextAgent: null,
              nextAgentReason: null,
              nextAgentContext: null,
              warnings: [reason],
            },
          ],
          handoffs: [],
          finalResponse: `Flow "${flow.name}" failed: ${reason}`,
          warnings: [reason],
          error: reason,
        });
      }
    }

    // Fall back to skills.yaml for unmigrated (agent-driven) skills
    const skill = getAllSkills().find((s) => s.id === route.routeId);
    if (skill) {
      const needsExt = skill.allowedTools.some((t) => t.startsWith('ext.'));
      const needsMove = skill.allowedTools.includes('vault.move');
      const needsWrite = skill.allowedTools.includes('vault.write');
      const delegateAgentId = needsExt
        ? 'seeker'
        : needsWrite && !needsMove
          ? 'architect'
          : 'sorter';
      const delegateAgent = getAgent(delegateAgentId);
      if (delegateAgent) {
        const confirmed = hasProceedSignal(confirmationText);
        const gateActive = skill.approvalRequired && !confirmed;
        const augmentedRequest = gateActive
          ? `${skill.instructions}\
\
## User Request\
${request}${APPROVAL_PLAN_DIRECTIVE}`
          : `${skill.instructions}\
\
## User Request\
${request}`;
        route = {
          ...route,
          routeType: 'agent',
          routeId: delegateAgentId,
          reason: `Skill "${skill.name}" delegated to ${delegateAgent.name}`,
        };
        onEvent?.({
          kind: 'route',
          agent: delegateAgentId,
          detail: gateActive
            ? `skill "${skill.name}" (approval required — plan only)`
            : `skill "${skill.name}"`,
        });
        onEvent?.({ kind: 'agent', agent: delegateAgentId });

        const execResult = await runAgentTraced(
          delegateAgent,
          augmentedRequest,
          true,
          gateActive ? true : undefined,
        );

        if (gateActive) {
          const result: AgentResult = {
            ...execResult.result,
            status: 'needs_input',
            response:
              `${execResult.result.response}\
\
` +
              `---\
**Approval required.** "${skill.name}" makes changes to your vault, ` +
              `so this was a plan only — nothing was written. Reply "proceed" (or ` +
              `"yes, go ahead") to run it for real.`,
            warnings: [
              ...execResult.result.warnings,
              `Skill "${skill.id}" requires approval; ran plan-only (dry-run) pending confirmation.`,
            ],
          };
          return finalize({
            route,
            results: [result],
            handoffs: [],
            finalResponse: result.response,
            warnings: result.warnings,
          });
        }

        if (execResult.success) {
          const handoffsToProcess: Array<{ from: string; to: string; reason: string }> = [];
          if (execResult.result.suggestedNextAgent) {
            handoffsToProcess.push({
              from: delegateAgentId,
              to: execResult.result.suggestedNextAgent,
              reason: execResult.result.nextAgentReason ?? '',
            });
          }
          return finalize({
            route,
            results: [execResult.result],
            handoffs: handoffsToProcess,
            finalResponse: execResult.result.response,
            warnings: [
              ...enforceToolSafety(route, agents).filter(Boolean) as string[],
              ...execResult.result.warnings,
            ],
          });
        }

        return finalize({
          route,
          results: [execResult.result],
          handoffs: [],
          finalResponse: execResult.result.response,
          warnings: [...enforceToolSafety(route, agents).filter(Boolean) as string[], ...execResult.result.warnings],
          error: execResult.result.warnings.join('; '),
        });
      }
    }
  }


  if (route.routeType !== 'agent' || !route.routeId) {
    const conductor = getAgent('conductor');
    if (conductor) {
      logger.info('route.fallback (conductor)');
      route = {
        routeType: 'agent',
        routeId: 'conductor',
        confidence: 0.6,
        reason: route.clarificationQuestion ?? route.reason ?? 'Falling back to Conductor for scoping',
        alternatives: [],
        clarificationQuestion: null,
      };
    } else {
      return finalize({
        route,
        results: [],
        handoffs: [],
        finalResponse:
          route.clarificationQuestion ?? route.reason ?? 'Could not route request',
        warnings: [route.reason],
      });
    }
  }

  // routeId is guaranteed non-null here: the block above either returns or
  // reassigns `route` with a concrete routeId ('conductor'), but TS loses that
  // narrowing across the reassignment — assert it locally.
  const agent = route.routeId ? getAgent(route.routeId) : null;
  if (!agent) {
    return finalize({
      route,
      results: [],
      handoffs: [],
      finalResponse: `Agent "${route.routeId}" not found`,
      warnings: [`Agent "${route.routeId}" not found`],
    });
  }

  const safetyWarnings = enforceToolSafety(route, agents);

  const results: AgentResult[] = [];
  const handoffs: { from: string; to: string; reason: string }[] = [];
  const chainIds: string[] = [];
  let depth = 0;
  let currentAgent = agent;
  let currentRequest = request;

  onEvent?.({ kind: 'route', agent: agent.id, detail: route.reason });

  // ── Orchestrator intercept (Slice P) ────────────────────────────
  // When the active config has mode 'orchestrator' and the route is
  // conductor, run the native coordinator loop instead of the linear
  // handoff chain. The coordinator calls specialists, reads results,
  // loops, and synthesizes — all in one agent run.
  if (
    input.activeOrchestratorConfig &&
    input.activeOrchestratorConfig.mode === 'orchestrator' &&
    route.routeId === 'conductor'
  ) {
    logger.info(
      { runId, configId: input.activeOrchestratorConfig.id },
      'orchestrator.intercept (native coordinator loop)',
    );
    const { coordinator, getTrace, reset } =
      buildRoutingCoordinator(agents, input.activeOrchestratorConfig);
    reset();

    const llm = createRouterClient();
    const t0 = Date.now();
    try {
      const output = await coordinator.forward(llm, { userRequest: request });
      const trace = getTrace();
      const finalAnswer = trace?.finalAnswer ?? '';
      const responseText =
        typeof output === 'string'
          ? output
          : `${finalAnswer}\n\n---\n*Orchestrated by Conductor (${
              trace?.steps.length ?? 0
            } specialist calls, ${Date.now() - t0}ms)*`;

      // Emit trace events for each specialist call
      if (trace) {
        for (const step of trace.steps) {
          onEvent?.({
            kind: 'tool',
            tool: `team.${step.specialistId}`,
            args: { request: step.input.slice(0, 120) },
            callId: randomUUID(),
          });
          onEvent?.({
            kind: 'tool_result',
            tool: `team.${step.specialistId}`,
            result: step.output.slice(0, 500),
            callId: randomUUID(),
          });
        }
      }

      const orchestratorResult: AgentResult = {
        status: 'completed',
        response: responseText,
        summary:
          trace && trace.steps.length > 0
            ? `Orchestrated ${trace.steps.length} specialist(s): ${trace.steps
                .map((s) => s.specialistId)
                .join(', ')}`
            : `Orchestrated by Conductor (${Date.now() - t0}ms)`,
        changedFiles: [],
        evidence: [],
        suggestedNextAgent: null,
        nextAgentReason: null,
        nextAgentContext: null,
        warnings: [],
      };

      return finalize({
        route: { ...route, reason: `Orchestrator (${input.activeOrchestratorConfig.id})` },
        results: [orchestratorResult],
        handoffs: [],
        finalResponse: responseText,
        warnings: [],
      });
    } catch (err) {
      const reason = String(err);
      logger.error({ runId, err }, 'orchestrator.intercept (failed)');
      return finalize({
        route: { ...route, reason: `Orchestrator failed: ${reason}` },
        results: [
          {
            status: 'failed',
            response: `Orchestrator failed: ${reason}`,
            summary: 'Orchestrator failed',
            changedFiles: [],
            evidence: [],
            suggestedNextAgent: null,
            nextAgentReason: null,
            nextAgentContext: null,
            warnings: [reason],
          },
        ],
        handoffs: [],
        finalResponse: `Orchestrator failed: ${reason}`,
        warnings: [reason],
        error: reason,
      });
    }
  }

  while (depth <= config.maxHandoffDepth) {
    logger.info(
      {
        runId,
        agentId: currentAgent.id,
        depth,
        chain: chainIds.join(' → '),
      },
      'agent.started',
    );

    onEvent?.({ kind: 'agent', agent: currentAgent.id });

    const execResult = await runAgentTraced(currentAgent, currentRequest);

    results.push(execResult.result);

    if (!execResult.success || execResult.result.status === 'failed') {
      logger.info(
        { agentId: currentAgent.id, error: execResult.error },
        'agent.completed (failed)',
      );
      break;
    }

    logger.info(
      { agentId: currentAgent.id, status: execResult.result.status },
      'agent.completed',
    );

    if (!execResult.result.suggestedNextAgent) {
      break;
    }

    chainIds.push(currentAgent.id);

    const targetAgent = getAgent(execResult.result.suggestedNextAgent);
    if (!targetAgent) {
      execResult.result.warnings.push(
        `Handoff to unknown agent "${execResult.result.suggestedNextAgent}" ignored`,
      );
      break;
    }

    const validation = validateHandoff(
      execResult.result,
      currentAgent,
      chainIds,
      depth,
      targetAgent,
    );

    if (!validation.allowed) {
      execResult.result.warnings.push(
        `Handoff rejected: ${validation.reason}`,
      );
      logger.info({ reason: validation.reason }, 'handoff.rejected');
      break;
    }

    logger.info(
      { from: currentAgent.id, to: targetAgent.id },
      'handoff.accepted',
    );

    handoffs.push({
      from: currentAgent.id,
      to: targetAgent.id,
      reason: execResult.result.nextAgentReason!,
    });

    const packet = buildHandoffPacket(
      execResult.result,
      currentAgent,
      request,
    );

    currentRequest = formatHandoffRequest(packet);
    currentAgent = targetAgent;
    depth++;
  }

  const lastResult = results[results.length - 1];
  const finalResponse = lastResult?.response ?? 'No response';

  logger.info({ runId, status: lastResult?.status }, 'run.completed');

  return finalize({
    route,
    results,
    handoffs,
    finalResponse,
    warnings: [
      ...safetyWarnings,
      ...results.flatMap((r) => r.warnings),
    ],
  });
  } catch (err) {
    // A throw anywhere in routing/classification/execution (e.g. a bubbled
    // AxAIServiceError from a downed proxy that escaped the executor's own
    // catch, or a classifier failure) must still return a finalized failed
    // output — otherwise the caller's run row stays 'started' forever. `route`
    // holds whatever was resolved before the throw.
    const reason = String(err);
    logger.error({ runId, err }, 'run.failed (dispatch threw)');
    return finalize({
      route,
      results: [],
      handoffs: [],
      finalResponse: `Run failed: ${reason}`,
      warnings: [reason],
      error: reason,
    });
  }
}

function formatHandoffRequest(packet: HandoffPacket): string {
  return [
    `## Handoff from ${packet.previousAgent}`,
    '',
    `**Original request:** ${packet.originalRequest}`,
    '',
    `**Previous agent summary:** ${packet.previousSummary}`,
    '',
    `**Handoff reason:** ${packet.reason}`,
    '',
    `**Relevant files:** ${packet.relevantFiles.join(', ') || 'none'}`,
    '',
    packet.constraints.length > 0
      ? `**Constraints:**\n${packet.constraints.map((c) => `- ${c}`).join('\n')}`
      : '',
  ].join('\n');
}
