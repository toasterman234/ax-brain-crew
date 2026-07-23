import { getConfig } from '../config.js';
import type { RouteDecision } from '../types.js';
import type { ValidatedAgent } from '../registry/loader.js';

export function enforcePolicy(
  decision: RouteDecision,
  agents: ValidatedAgent[],
): RouteDecision {
  const config = getConfig();
  const agent = agents.find((a) => a.id === decision.routeId);

  const conductor = agents.find((a) => a.id === 'conductor');

  if (decision.routeType === 'agent' && !agent) {
    if (conductor) {
      return {
        routeType: 'agent',
        routeId: 'conductor',
        confidence: 0.6,
        reason: `Agent "${decision.routeId}" not found — falling back to Conductor for scoping`,
        alternatives: [],
        clarificationQuestion: null,
      };
    }
    return {
      routeType: 'none',
      routeId: null,
      confidence: 0,
      reason: `Agent "${decision.routeId}" not found in registry`,
      alternatives: [],
      clarificationQuestion: null,
    };
  }

  if (decision.routeType === 'agent' && decision.confidence < config.routingClarifyThreshold) {
    if (conductor) {
      return {
        routeType: 'agent',
        routeId: 'conductor',
        confidence: 0.6,
        reason: `Low confidence (${decision.confidence.toFixed(2)}) — falling back to Conductor for scoping`,
        alternatives: [],
        clarificationQuestion: null,
      };
    }
    return {
      routeType: 'none',
      routeId: null,
      confidence: decision.confidence,
      reason: `Confidence too low: ${decision.confidence.toFixed(2)} < ${config.routingClarifyThreshold}`,
      alternatives: [],
      clarificationQuestion: null,
    };
  }

  if (
    decision.routeType === 'agent' &&
    decision.confidence >= config.routingClarifyThreshold &&
    decision.confidence < config.routingConfidenceThreshold
  ) {
    if (decision.routeId === 'conductor') {
      return decision;
    }
    if (conductor) {
      return {
        routeType: 'agent',
        routeId: 'conductor',
        confidence: 0.65,
        reason: `Moderate confidence (${decision.confidence.toFixed(2)}) for ${decision.routeId} — routing to Conductor to scope first`,
        alternatives: [],
        clarificationQuestion: null,
      };
    }
    return {
      routeType: 'clarify',
      routeId: decision.routeId,
      confidence: decision.confidence,
      reason: `Confidence moderate: ${decision.confidence.toFixed(2)}`,
      alternatives: [],
      clarificationQuestion: `Route to ${decision.routeId}? (confidence: ${(decision.confidence * 100).toFixed(0)}%) Reason: ${decision.reason}`,
    };
  }

  return decision;
}

export function enforceToolSafety(
  decision: RouteDecision,
  agents: ValidatedAgent[],
): string[] {
  const warnings: string[] = [];
  const agent = agents.find((a) => a.id === decision.routeId);

  if (!agent) return warnings;

  const writeTools = agent.allowedTools.filter((t) => t.approvalLevel > 0);
  if (writeTools.length > 0) {
    const dryRun = getConfig().dryRun;
    if (dryRun) {
      warnings.push(
        `Agent "${agent.name}" has write tools: ${writeTools.map((t) => t.name).join(', ')}. Dry-run is active — no files will be modified.`,
      );
    } else {
      warnings.push(
        `Agent "${agent.name}" has write tools: ${writeTools.map((t) => t.name).join(', ')} is active. Files may be modified.`,
      );
    }
  }

  return warnings;
}
