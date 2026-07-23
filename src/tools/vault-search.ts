import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname, resolve as resolvePath } from 'node:path';
import { getVaultRoot, resolveVaultPath, isPathExcluded } from './vault-path.js';

export interface VaultSearchInput {
  query: string;
  directory?: string;
  extension?: string;
  limit?: number;
}

export interface VaultSearchResult {
  path: string;
  modifiedAt: string;
  snippet: string;
}

function findLineWithQuery(content: string, query: string): string {
  const lowerQuery = query.toLowerCase();
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.toLowerCase().includes(lowerQuery)) {
      return line.trim().slice(0, 200);
    }
  }
  return content.slice(0, 200);
}

function searchDirectory(
  dir: string,
  query: string,
  extension: string | undefined,
  limit: number,
): VaultSearchResult[] {
  const results: VaultSearchResult[] = [];
  const root = getVaultRoot();

  const searchDir = (dirPath: string) => {
    if (results.length >= limit) return;

    const entries = readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.name.startsWith('.')) continue;

      const fullPath = join(dirPath, entry.name);
      const relPath = fullPath.replace(root + '/', '').replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (isPathExcluded(relPath)) continue;
        searchDir(fullPath);
      } else if (entry.isFile()) {
        if (isPathExcluded(relPath)) continue;
        if (extension && extname(entry.name) !== extension) continue;
        if (extname(entry.name) !== '.md') continue;

        const content = readFileSync(fullPath, 'utf-8');
        // Match query words (≥3 chars) across path + content, not just the whole
        // phrase in content — so "open projects" surfaces files in Projects/ and
        // notes with a matching filename, not only exact-phrase content hits.
        const corpus = `${relPath}\n${content}`.toLowerCase();
        const terms = query
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length >= 3);
        const matched =
          terms.length > 0
            ? terms.some((t) => corpus.includes(t))
            : corpus.includes(query.toLowerCase());
        if (matched) {
          const stats = statSync(fullPath);
          results.push({
            path: relPath,
            modifiedAt: stats.mtime.toISOString(),
            snippet: findLineWithQuery(content, query),
          });
        }
      }
    }
  };

  searchDir(resolvePath(root, dir));
  return results;
}

export function vaultSearch(input: VaultSearchInput): {
  results: VaultSearchResult[];
  totalFound: number;
} {
  const searchDir = input.directory || '.';
  const limit = Math.min(input.limit || 10, 50);

  resolveVaultPath(searchDir);
  const results = searchDirectory(searchDir, input.query, input.extension, limit);

  return {
    results,
    totalFound: results.length,
  };
}
