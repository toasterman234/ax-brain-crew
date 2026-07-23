import { resolve } from 'node:path';
import { setVaultRoot } from '../tools/vault-path.js';
import { setExternalVaultRoot } from '../tools/external-vault.js';
import { setScoutAllowedPaths } from '../tools/fs-explore.js';
import { setGithubCredentials } from '../tools/github-explore.js';
import { setMemoryCredentials } from '../tools/memory-explore.js';
import { setLifeosBaseUrl } from '../tools/lifeos-explore.js';
import { setWebCredentials } from '../tools/web-explore.js';
import { getConfig } from '../config.js';
import { getLogger } from '../observability/logger.js';

let _initialized = false;

export function initializeRuntime(): void {
  if (_initialized) return;

  const config = getConfig();
  const logger = getLogger();

  // Vault is optional — when empty, vault tools will return "vault not configured".
  if (config.obsidianVaultPath) {
    setVaultRoot(resolve(config.obsidianVaultPath));
  }

  if (config.externalVaultPath) {
    setExternalVaultRoot(resolve(config.externalVaultPath));
  }

  if (config.scoutAllowedPaths && !config.demoMode) {
    const paths = config.scoutAllowedPaths
      .split(/[,:;]/)
      .map((p) => p.trim())
      .filter(Boolean);
    setScoutAllowedPaths(paths);
    logger.info({ paths }, 'Scout allowed paths configured');
  }

  if (config.githubToken && config.githubUser && !config.demoMode) {
    setGithubCredentials(config.githubToken, config.githubUser);
    logger.info({ user: config.githubUser }, 'Scout GitHub configured');
  }

  if (config.agentmemoryBaseUrl && !config.demoMode) {
    setMemoryCredentials(config.agentmemoryBaseUrl, config.agentmemorySecret);
    logger.info(
      { baseUrl: config.agentmemoryBaseUrl, hasSecret: Boolean(config.agentmemorySecret) },
      'Memory (agentmemory) configured',
    );
  }

  if (config.lifeosBaseUrl && !config.demoMode) {
    setLifeosBaseUrl(config.lifeosBaseUrl);
    logger.info({ baseUrl: config.lifeosBaseUrl }, 'Life OS configured');
  }

  // Web search (Serper / Google). Keyless web.fetch always works; web.search
  // degrades to a "not configured" string when no key is found.
  // In demo mode, skip to avoid confusing errors.
  if (!config.demoMode) {
    setWebCredentials(config.serperApiKey);
    logger.info(
      { configured: Boolean(config.serperApiKey) },
      'Web search (Serper) configured',
    );
  }

  _initialized = true;
}
