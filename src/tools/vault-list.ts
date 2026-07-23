import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { getVaultRoot, resolveVaultPath, isPathExcluded } from './vault-path.js';

export interface VaultListInput {
  directory?: string;
}

export interface VaultListItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  modifiedAt: string;
}

export function vaultList(input: VaultListInput = {}): {
  directory: string;
  items: VaultListItem[];
} {
  const root = getVaultRoot();
  const dir = input.directory || '.';
  const { absolutePath, vaultRelativePath } = resolveVaultPath(dir);

  const entries = readdirSync(absolutePath, { withFileTypes: true });
  const items: VaultListItem[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = resolve(absolutePath, entry.name);
    const relativePath = fullPath.replace(root + '/', '').replace(/\\/g, '/');
    if (isPathExcluded(relativePath)) continue;
    const stats = statSync(fullPath);

    items.push({
      name: entry.name,
      path: fullPath.replace(root + '/', '').replace(/\\/g, '/'),
      type: entry.isDirectory() ? 'directory' : 'file',
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    directory: vaultRelativePath,
    items,
  };
}
