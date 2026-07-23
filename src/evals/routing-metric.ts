import type { AxMetricFn } from '@ax-llm/ax';

// E5 Slice 1 — routing eval metric.
//
// One deterministic scorer for "did the coordinator route to the right
// specialist", shared by (a) the standalone baseline runner (scripts/eval-routing.ts)
// and (b) agent.optimize()'s AxMetricFn in Slice 2 — so the number GEPA maximizes
// is exactly the number we report. Deterministic (no LLM judge): routing has a
// crisp ground truth, so a code metric is cheaper, lower-variance, and overrides
// the built-in judge when passed to optimize().

/**
 * The old router escalates vague requests to `conductor` and only says `clarify`
 * when nothing fits; the native coordinator IS the conductor, so its escalation
 * signal is `clarify`. Both collapse to one "escalate" bucket for scoring.
 */
export const ESCALATE = new Set(['conductor', 'clarify', 'none']);

/**
 * Read which specialist an optimize()/forward() prediction selected.
 * Returns the specialist id (e.g. 'librarian'), 'clarify' when the coordinator
 * asked for more info, or 'none' when it neither routed nor clarified.
 */
export function selectedFromPrediction(prediction: any): string {
  if (prediction?.completionType === 'askClarification') return 'clarify';
  const calls: any[] = prediction?.functionCalls ?? [];
  const team = calls.find(
    (c) => typeof c?.qualifiedName === 'string' && c.qualifiedName.startsWith('team.'),
  );
  if (team) return String(team.qualifiedName).slice('team.'.length);
  return 'none';
}

/**
 * Pure routing score in [0,1]. A specialist-labeled case scores 1 only on an
 * exact specialist match. A `clarify`-labeled (genuinely ambiguous) case scores 1
 * when the router escalated instead of confidently mis-routing to a specialist.
 */
export function scoreRouting(selected: string, expected: string): number {
  if (expected === 'clarify') return ESCALATE.has(selected) ? 1 : 0;
  return selected === expected ? 1 : 0;
}

/**
 * AxMetricFn for agent.optimize() (Slice 2). The task record must carry the
 * ground-truth label as `expectedAgent` (tasks are built as
 * { input: { userRequest }, expectedAgent }).
 */
export const routingMetric: AxMetricFn = ({ prediction, example }) => {
  const selected = selectedFromPrediction(prediction);
  const expected = String((example as any)?.expectedAgent ?? '');
  return scoreRouting(selected, expected);
};
