// Orchestrator config — the structural half of a variant.
//
// A variant = structure (OrchestratorConfig) + a reference to a learned state
// (playbookSnapshotId pointing at a named snapshot). The two are mixed-and-
// matched so Ben can experiment with different specialist teams against the
// same learned knowledge, or different playbook states against the same team.
//
// Persisted on the Bench as ArtifactKind:'orchestrator' alongside signatures,
// generators, and flows. The two default configs below are the starting point:
//   - defaultRouterConfig() = today's coordinator.ts hardcoded values (E3 parity)
//   - defaultOrchestratorConfig() = the orchestrator loop (multi-step, real calls)
//
// Slice O: this file is read by coordinator.ts, the Bench CRUD, and the lab UI.

export interface OrchestratorConfig {
  id: string; // kebab slug, unique
  name: string;
  mode: 'router' | 'orchestrator';
  /** Which specialists are in the team namespace (by agent id). */
  specialistIds: string[];
  /** 'off' = force function call (router); 'auto' = coordinator can answer directly. */
  directResponse: 'off' | 'auto';
  /** Orchestrator loop budget (router ignores this). */
  maxSteps: number;
  /** ax signature string, e.g. 'userRequest:string -> routingSummary:string'. */
  signature: string;
  /** Plain-text agent identity description (what the coordinator says it is). */
  identity: string;
  /** Reference to a named, frozen playbook snapshot (null = live on-disk). */
  playbookSnapshotId: string | null;
  createdAt: number;
  updatedAt: number;
}

export const ROUTER_SIGNATURE = 'userRequest:string -> routingSummary:string';
export const ORCHESTRATOR_SIGNATURE =
  'userRequest:string -> plan:string, steps:string[], finalAnswer:string';

export const ROUTER_IDENTITY = `Routes a user request to exactly ONE specialist by calling that
specialist's function in the team namespace (e.g. team.librarian).
Pick the single best specialist for the request. If — and only if — no
specialist fits or the request is too vague to route confidently, call
askClarification with one short question instead of guessing.`;

export const ORCHESTRATOR_IDENTITY = `Orchestrate a user request through the specialist team.
You have access to every specialist as a function in the team namespace.
Call specialists as needed — you can call one, then read its result, then
decide whether to call another. Synthesize a final answer once you have
enough specialist output. Think step-by-step: what does the user really
need, which specialists have the right tools and knowledge, and in what
order should they be called?`;

export function defaultRouterConfig(
  specialistIds: string[],
): OrchestratorConfig {
  return {
    id: 'router-baseline',
    name: 'Router (baseline)',
    mode: 'router',
    specialistIds,
    directResponse: 'off',
    maxSteps: 1,
    signature: ROUTER_SIGNATURE,
    identity: ROUTER_IDENTITY,
    playbookSnapshotId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function defaultOrchestratorConfig(
  specialistIds: string[],
): OrchestratorConfig {
  return {
    id: 'orchestrator-v1',
    name: 'Orchestrator v1',
    mode: 'orchestrator',
    specialistIds,
    directResponse: 'auto',
    maxSteps: 8,
    signature: ORCHESTRATOR_SIGNATURE,
    identity: ORCHESTRATOR_IDENTITY,
    playbookSnapshotId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
