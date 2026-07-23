import { RegistryLoader, type ValidatedAgent } from './loader.js';
import { getLogger } from '../observability/logger.js';

export type { ValidatedAgent } from './loader.js';

let _agents: ValidatedAgent[] | null = null;

export function loadRegistry(registryPath: string): ValidatedAgent[] {
  if (_agents) return _agents;

  const logger = getLogger();
  logger.info({ path: registryPath }, 'Loading agent registry');

  const loader = new RegistryLoader(registryPath);
  _agents = loader.loadAll();

  logger.info({ count: _agents.length }, 'Registry loaded');
  for (const a of _agents) {
    logger.info(
      {
        id: a.id,
        tier: a.modelTier,
        tools: a.allowedTools.length,
        triggers: a.triggers.length,
      },
      `Agent: ${a.name}`,
    );
  }

  return _agents;
}

export function getAgent(id: string): ValidatedAgent | undefined {
  if (!_agents) return undefined;
  return _agents.find((a) => a.id === id);
}

export function getAllAgents(): ValidatedAgent[] {
  return _agents ?? [];
}

export function resetRegistry(): void {
  _agents = null;
}
