import type { RouteDecision } from '../types.js';
import { matchSkill } from '../skills/executor.js';

export function skillRoute(input: string): RouteDecision | null {
  const skill = matchSkill(input);
  if (!skill) return null;

  return {
    routeType: 'skill',
    routeId: skill.id,
    confidence: 0.9,
    reason: `Matched skill trigger for "${skill.name}"`,
    alternatives: [],
    clarificationQuestion: null,
  };
}
