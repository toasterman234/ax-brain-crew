import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  registrySchema,
  type Registry,
} from './schemas.js';
import {
  TOOL_REGISTRY,
  type ToolDefinition,
} from '../tools/index.js';

export interface ValidatedAgent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  modelTier: 'router' | 'fast' | 'smart';
  model?: string;
  allowedTools: ToolDefinition[];
  triggers: string[];
  handoffs: {
    allowedTargets: string[];
  };
}

export class RegistryLoader {
  private registryPath: string;
  private baseDir: string;

  constructor(registryPath: string) {
    this.registryPath = registryPath;
    this.baseDir = resolve(registryPath, '..', '..');
  }

  load(): Registry {
    const raw = readFileSync(this.registryPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      throw new Error(
        `Failed to parse registry YAML: ${String(err)}`,
      );
    }

    const result = registrySchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(
        `Registry validation failed:\n${issues}`,
      );
    }

    return result.data;
  }

  validateAndResolve(registry: Registry): ValidatedAgent[] {
    const agents: ValidatedAgent[] = [];
    const knownToolNames = new Set(TOOL_REGISTRY.map((t) => t.name));

    for (const [id, def] of Object.entries(registry.agents)) {
      if (!def.name || def.name.trim().length === 0) {
        throw new Error(`Agent "${id}" has an empty name`);
      }

      const instructionsPath = resolve(this.baseDir, def.instructions);
      if (!existsSync(instructionsPath)) {
        throw new Error(
          `Instructions file not found for agent "${id}": ${instructionsPath}`,
        );
      }

      let instructions: string;
      try {
        instructions = readFileSync(instructionsPath, 'utf-8');
      } catch (err) {
        throw new Error(
          `Failed to read instructions for agent "${id}": ${String(err)}`,
        );
      }

      if (instructions.trim().length === 0) {
        throw new Error(
          `Instructions file is empty for agent "${id}"`,
        );
      }

      for (const toolName of def.allowedTools) {
        if (!knownToolNames.has(toolName)) {
          throw new Error(
            `Unknown tool "${toolName}" in agent "${id}". Known tools: ${[...knownToolNames].join(', ')}`,
          );
        }
      }

      const modelTiers = ['router', 'fast', 'smart'] as const;
      if (!modelTiers.includes(def.modelTier as typeof modelTiers[number])) {
        throw new Error(
          `Unknown model tier "${def.modelTier}" in agent "${id}"`,
        );
      }

      if (def.handoffs?.allowedTargets) {
        const allAgentIds = new Set(Object.keys(registry.agents));
        for (const target of def.handoffs.allowedTargets) {
          if (!allAgentIds.has(target)) {
            throw new Error(
              `Unknown handoff target "${target}" in agent "${id}"`,
            );
          }
        }
      }

      const resolvedTools = def.allowedTools.map(
        (name) => TOOL_REGISTRY.find((t) => t.name === name)!,
      );

      agents.push({
        id,
        name: def.name,
        description: def.description,
        instructions,
        modelTier: def.modelTier as 'router' | 'fast' | 'smart',
        model: def.model,
        allowedTools: resolvedTools,
        triggers: def.triggers,
        handoffs: {
          allowedTargets: def.handoffs?.allowedTargets ?? [],
        },
      });
    }

    return agents;
  }

  loadAll(): ValidatedAgent[] {
    const registry = this.load();
    return this.validateAndResolve(registry);
  }
}
