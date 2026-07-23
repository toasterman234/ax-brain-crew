import { readFileSync, statSync } from 'node:fs';
import { resolveVaultPath, guardExcludedPath } from './vault-path.js';

export interface VaultReadInput {
  path: string;
}

export interface VaultReadOutput {
  path: string;
  content: string;
  modifiedAt: string;
  size: number;
}

export function vaultRead(input: VaultReadInput): VaultReadOutput {
  const { absolutePath, vaultRelativePath } = resolveVaultPath(input.path);
  guardExcludedPath(vaultRelativePath);

  const stats = statSync(absolutePath);
  if (stats.isDirectory()) {
    throw Object.assign(
      new Error(
        `Path is a directory, not a file: ${vaultRelativePath}. Use vaultList to see its contents.`,
      ),
      { code: 'EISDIR' },
    );
  }

  const content = readFileSync(absolutePath, 'utf-8');

  return {
    path: vaultRelativePath,
    content,
    modifiedAt: stats.mtime.toISOString(),
    size: stats.size,
  };
}
