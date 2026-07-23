import { renameSync, existsSync } from 'node:fs';
import { resolveVaultPath, guardExcludedPath, ensureParentDir } from './vault-path.js';

export interface VaultMoveInput {
  source: string;
  destination: string;
  dryRun?: boolean;
}

export interface VaultMoveOutput {
  source: string;
  destination: string;
  operation: 'moved' | 'dry_run' | 'error';
  reason?: string;
}

export function vaultMove(input: VaultMoveInput): VaultMoveOutput {
  const src = resolveVaultPath(input.source);
  const dest = resolveVaultPath(input.destination);

  guardExcludedPath(src.vaultRelativePath);
  guardExcludedPath(dest.vaultRelativePath);

  if (!existsSync(src.absolutePath)) {
    return {
      source: src.vaultRelativePath,
      destination: dest.vaultRelativePath,
      operation: 'error',
      reason: 'Source file does not exist.',
    };
  }

  if (existsSync(dest.absolutePath)) {
    return {
      source: src.vaultRelativePath,
      destination: dest.vaultRelativePath,
      operation: 'error',
      reason: 'Destination already exists.',
    };
  }

  if (input.dryRun) {
    return {
      source: src.vaultRelativePath,
      destination: dest.vaultRelativePath,
      operation: 'dry_run',
      reason: 'Dry run — no file was moved.',
    };
  }

  ensureParentDir(dest.absolutePath);
  renameSync(src.absolutePath, dest.absolutePath);

  return {
    source: src.vaultRelativePath,
    destination: dest.vaultRelativePath,
    operation: 'moved',
  };
}
