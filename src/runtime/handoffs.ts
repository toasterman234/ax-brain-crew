import { getConfig } from '../config.js';
import type { ValidatedAgent } from '../registry/loader.js';
import type { AgentResult, HandoffPacket } from '../types.js';

export interface HandoffValidation {
  allowed: boolean;
  reason: string;
}

export function validateHandoff(
  result: AgentResult,
  currentAgent: ValidatedAgent,
  chainIds: string[],
  depth: number,
  targetAgent: ValidatedAgent,
): HandoffValidation {
  const config = getConfig();

  if (!result.suggestedNextAgent) {
    return { allowed: false, reason: 'No handoff suggested' };
  }

  if (depth >= config.maxHandoffDepth) {
    return {
      allowed: false,
      reason: `Handoff depth exceeded: ${depth} >= ${config.maxHandoffDepth}`,
    };
  }

  if (!targetAgent) {
    return {
      allowed: false,
      reason: `Unknown agent: "${result.suggestedNextAgent}"`,
    };
  }

  if (chainIds.includes(targetAgent.id)) {
    return {
      allowed: false,
      reason: `Cycle detected: ${targetAgent.id} already ran in chain ${chainIds.join(' → ')}`,
    };
  }

  if (!currentAgent.handoffs.allowedTargets.includes(targetAgent.id)) {
    return {
      allowed: false,
      reason: `${currentAgent.name} is not configured to hand off to ${targetAgent.name}`,
    };
  }

  if (!result.nextAgentReason || result.nextAgentReason.trim().length === 0) {
    return {
      allowed: false,
      reason: 'No reason provided for handoff',
    };
  }

  return { allowed: true, reason: 'Handoff valid' };
}

export function buildHandoffPacket(
  result: AgentResult,
  currentAgent: ValidatedAgent,
  originalRequest: string,
): HandoffPacket {
  return {
    originalRequest,
    previousAgent: currentAgent.id,
    previousSummary: result.summary,
    reason: result.nextAgentReason ?? '',
    relevantFiles: result.evidence.map((e) => e.path),
    changedFiles: result.changedFiles,
    constraints: [],
  };
}
