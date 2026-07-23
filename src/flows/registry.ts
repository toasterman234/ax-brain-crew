/**
 * Flow Registry — single source of truth for ax-native flow() pipelines.
 *
 * Each flow file calls registerFlow({ ... }) at module level.
 * The dispatcher calls matchFlow(input) instead of 9 separate intercept blocks.
 * The serve endpoint reads getAllFlows() for the visual lab.
 *
 * This replaces crew/skills.yaml for flow-migrated skills (9 of 13).
 * The 4 remaining agent-driven skills stay in skills.yaml until migrated.
 */

export interface FlowRun {
  finalResponse: string;
  output: unknown;
  warnings?: string[];
}

export interface FlowMeta {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  approvalRequired: boolean;
  sourceFile: string;
  run: (args: { request: string; runId: string; dryRun?: boolean }) => Promise<FlowRun>;
}

const registry = new Map<string, FlowMeta>();

export function registerFlow(meta: FlowMeta): void {
  if (registry.has(meta.id)) {
    throw new Error(`Duplicate flow id: ${meta.id}`);
  }
  registry.set(meta.id, meta);
}

export function getFlow(id: string): FlowMeta | undefined {
  return registry.get(id);
}

export function getAllFlows(): FlowMeta[] {
  return Array.from(registry.values());
}

export function matchFlow(input: string): FlowMeta | null {
  const normalized = input.toLowerCase();
  for (const flow of getAllFlows()) {
    for (const trigger of flow.triggers) {
      if (normalized.includes(trigger.toLowerCase())) {
        return flow;
      }
    }
  }
  return null;
}

export function resetFlowRegistry(): void {
  registry.clear();
}
