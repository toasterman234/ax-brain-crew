import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';

let _externalVaultRoot: string | null = null;

export function setExternalVaultRoot(path: string): void {
  _externalVaultRoot = resolve(path);
}

export function getExternalVaultRoot(): string {
  return _externalVaultRoot ?? '';
}

export function isExternalVaultConfigured(): boolean {
  return _externalVaultRoot !== null && _externalVaultRoot.length > 0;
}

export function externalRead(path: string): { path: string; content: string; size: number } | null {
  if (!_externalVaultRoot) return null;
  const fullPath = resolve(_externalVaultRoot, path);
  if (!fullPath.startsWith(_externalVaultRoot)) return null;
  const content = readFileSync(fullPath, 'utf-8');
  const stats = statSync(fullPath);
  return { path, content, size: stats.size };
}

export function externalList(directory?: string): {
  directory: string;
  items: { name: string; path: string; type: 'file' | 'directory'; modifiedAt: string }[];
} | null {
  if (!_externalVaultRoot) return null;
  const dir = directory || '.';
  const fullPath = resolve(_externalVaultRoot, dir);
  if (!fullPath.startsWith(_externalVaultRoot)) return null;

  const entries = readdirSync(fullPath, { withFileTypes: true });
  const items = entries
    .filter((e) => !e.name.startsWith('.') || e.name === '.obsidian')
    .map((e) => {
      const fp = join(fullPath, e.name);
      const stats = statSync(fp);
      return {
        name: e.name,
        path: join(dir, e.name).replace(/\\/g, '/'),
        type: e.isDirectory() ? 'directory' as const : 'file' as const,
        modifiedAt: stats.mtime.toISOString(),
      };
    });

  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { directory: dir, items };
}

export function externalSearch(query: string, limit = 10): {
  results: { path: string; snippet: string }[];
  totalFound: number;
} | null {
  if (!_externalVaultRoot) return null;
  const results: { path: string; snippet: string }[] = [];
  const maxResults = Math.min(limit, 50);

  function searchDir(dirPath: string) {
    if (results.length >= maxResults) return;
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (entry.name.startsWith('.') && entry.name !== '.obsidian') continue;
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        searchDir(fullPath);
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        const content = readFileSync(fullPath, 'utf-8');
        if (content.toLowerCase().includes(query.toLowerCase())) {
          const line = content.split('\n').find((l) =>
            l.toLowerCase().includes(query.toLowerCase()),
          );
          results.push({
            path: fullPath.replace(_externalVaultRoot! + '/', '').replace(/\\/g, '/'),
            snippet: (line ?? content).trim().slice(0, 200),
          });
        }
      }
    }
  }

  searchDir(_externalVaultRoot);
  return { results, totalFound: results.length };
}
