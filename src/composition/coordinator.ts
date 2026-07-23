import { agent, fn, f, AxAgentClarificationError } from '@ax-llm/ax';
import { createRouterClient } from '../ai/clients.js';
import type { ValidatedAgent } from '../registry/loader.js';
import {
  type OrchestratorConfig,
  defaultRouterConfig,
} from './orchestrator-config.js';
import { executeAgent } from '../runtime/executor.js';

// E3 → E4/E5 — routing coordinator with orchestrator mode.
//
// E3 (parity): router mode — record-and-final() stubs, one-shot pick, ~83%
//   specialist accuracy. This is the EXACT same behavior as before, now
//   configurable via defaultRouterConfig().
//
// E4/E5 (orchestrator): orchestrator mode — real specialist calls, loop,
//   synthesize. The coordinator calls a specialist, reads the result, decides
//   whether to call another, and produces a final answer — all in one agent run.
//   Replaces the dispatcher's external while/suggestedNextAgent chain.
//
// Build paths:
//   buildRoutingCoordinator(agents) — router mode, E3 parity (backwards compat)
//   buildRoutingCoordinator(agents, config) — config-driven, mode branch

export const COORDINATOR_ID = 'conductor';

export interface NativeRouteResult {
  /** Selected specialist id, or 'clarify' (coordinator asked for more info), or 'none'. */
  routedAgent: string;
  clarificationQuestion: string | null;
  raw?: string;
}

export interface OrchestratorTrace {
  steps: Array<{
    specialistId: string;
    input: string;
    output: string;
    durationMs: number;
  }>;
  finalAnswer: string;
}

/**
 * Build a routing coordinator whose child-agent functions are the specialists.
 *
 * @param agents — all validated agents from the registry
 * @param config — optional; defaults to router-baseline (E3 parity)
 */
export function buildRoutingCoordinator(
  agents: ValidatedAgent[],
  config?: OrchestratorConfig,
): {
  coordinator: ReturnType<typeof agent>;
  getSelected: () => string | null;
  getTrace: () => OrchestratorTrace | null;
  reset: () => void;
} {
  const specialists = agents.filter((a) => a.id !== COORDINATOR_ID);
  let selected: string | null = null;
  const trace: OrchestratorTrace = { steps: [], finalAnswer: '' };

  // Resolve config: explicit config, or router baseline using all specialists.
  const resolved: OrchestratorConfig = config ?? defaultRouterConfig(
    specialists.map((s) => s.id),
  );

  // Filter specialists to only those listed in the config.
  const teamIds = new Set(resolved.specialistIds);
  const team = specialists.filter((a) => teamIds.has(a.id));

  // Playbook wiring: `agent()` doesn't accept playbook directly — that's wired
  // at the executor level via `buildAgentInstance`. For the coordinator as a
  // pure routing/orchestration function, playbook is a no-op here. When a
  // variant specifies a named snapshot, that snapshot is loaded at dispatch
  // time (see serve.ts orchestrator-run endpoint, Slice P).

  // ── Build specialist handlers ──────────────────────────────────────

  const functions = team.map((a) => {
    const desc = `Delegate the task to the ${a.name} specialist. ${a.description} ` +
      `Choose this when the request matches any of: ${a.triggers
        .slice(0, 6)
        .join('; ')}.`;

    if (resolved.mode === 'router') {
      // E3 parity stub: record the pick, end immediately.
      return fn(a.id)
        .description(desc)
        .namespace('team')
        .arg('task', f.string('The fully-framed task to hand to this specialist'))
        .returns(f.string('Acknowledgement'))
        .handler(async (_args: { task: string }, extra?: any) => {
          selected = a.id;
          extra?.protocol?.final(`Routed to ${a.id}`);
          return `Routed to ${a.id}`;
        })
        .build();
    }

    // Orchestrator mode: REAL specialist call.
    return fn(a.id)
      .description(desc)
      .namespace('team')
      .arg('task', f.string('The fully-framed task to hand to this specialist'))
      .returns(f.string('The specialist output — read this to decide the next step.'))
      .handler(async (args: { task: string }) => {
        selected = a.id;
        const startedAt = Date.now();
        try {
          const result = await executeAgent({
            agent: a,
            input: args.task,
            dryRun: false,
          });
          const output = result.success
            ? typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result)
            : `Error: ${result.error ?? 'unknown error'}`;
          trace.steps.push({
            specialistId: a.id,
            input: args.task,
            output,
            durationMs: Date.now() - startedAt,
          });
          return `[${a.name}] ${output}`;
        } catch (err) {
          const msg = `Error: ${String(err)}`;
          trace.steps.push({
            specialistId: a.id,
            input: args.task,
            output: msg,
            durationMs: Date.now() - startedAt,
          });
          return `[${a.name}] ${msg}`;
        }
      })
      .build();
  });

  const coordinator = agent(resolved.signature, {
    agentIdentity: {
      name: 'Conductor',
      description: resolved.identity,
    },
    functions,
    contextFields: [],
    directResponse: resolved.directResponse as any,
  });

  return {
    coordinator,
    getSelected: () => selected,
    getTrace: () => (resolved.mode === 'orchestrator' ? trace : null),
    reset: () => {
      selected = null;
      trace.steps = [];
      trace.finalAnswer = '';
    },
  };
}

/**
 * Route one request natively. Returns the selected specialist id, or 'clarify'
 * when the coordinator asked for more information, or 'none' if it somehow ended
 * without selecting.
 */
export async function routeNatively(
  request: string,
  agents: ValidatedAgent[],
  config?: OrchestratorConfig,
): Promise<NativeRouteResult> {
  const llm = createRouterClient();
  const { coordinator, getSelected } = buildRoutingCoordinator(agents, config);

  try {
    const out = await coordinator.forward(llm, { userRequest: request });
    return {
      routedAgent: getSelected() ?? 'none',
      clarificationQuestion: null,
      raw: (out as any)?.routingSummary,
    };
  } catch (err) {
    if (err instanceof AxAgentClarificationError) {
      return {
        routedAgent: 'clarify',
        clarificationQuestion: (err as any).question ?? null,
      };
    }
    throw err;
  }
}
