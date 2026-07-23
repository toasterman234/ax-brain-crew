import type { RouteDecision } from '../types.js';
import type { ValidatedAgent } from '../registry/loader.js';

export function normalizeRequest(
  input: string,
  agents: ValidatedAgent[],
): RouteDecision | null {
  const trimmed = input.trim();

  const prefixMatch = trimmed.match(/^\/([\w-]+)/);
  if (prefixMatch) {
    const agentId = prefixMatch[1]!.toLowerCase();
    const agent = agents.find((a) => a.id === agentId);
    if (agent) {
      return {
        routeType: 'agent',
        routeId: agent.id,
        confidence: 1.0,
        reason: `Explicit /${agentId} prefix`,
        alternatives: [],
        clarificationQuestion: null,
      };
    }

    return {
      routeType: 'none',
      routeId: null,
      confidence: 0,
      reason: `Unknown agent prefix: /${agentId}`,
      alternatives: [],
      clarificationQuestion: `Agent "/${agentId}" is not registered. Available: ${agents.map((a) => a.id).join(', ')}`,
    };
  }

  return null;
}
