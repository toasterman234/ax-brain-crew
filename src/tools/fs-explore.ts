import { readdirSync, statSync } from 'node:fs';
import { resolve as resolvePath, isAbsolute, sep } from 'node:path';
import { getLogger } from '../observability/logger.js';

const PROJECT_INDICATORS = new Set([
  'package.json',
  'Cargo.toml',
  'go.mod',
  'requirements.txt',
  'pyproject.toml',
  'Makefile',
  'README.md',
  '.git',
  'Cargo.lock',
  'tsconfig.json',
  'next.config.js',
  'next.config.ts',
  'vite.config.ts',
  'vitest.config.ts',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
]);

export interface SysLsInput {
  path: string;
}

export interface SysLsItem {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  isProject: boolean;
}

export interface SysLsOutput {
  path: string;
  items: SysLsItem[];
}

export interface SysWalkInput {
  path: string;
  maxDepth?: number;
}

export interface SysWalkProject {
  path: string;
  indicators: string[];
}

export interface SysWalkOutput {
  path: string;
  projects: SysWalkProject[];
  totalScanned: number;
  maxDepthReached: boolean;
}

let _allowedPaths: string[] = [];

export function setScoutAllowedPaths(paths: string[]): void {
  _allowedPaths = paths
    .map((p) => resolvePath(p))
    .filter((p) => {
      try {
        statSync(p);
        return true;
      } catch {
        return false;
      }
    });
}

export function isPathAllowed(requestedPath: string): boolean {
  const normalized = isAbsolute(requestedPath)
    ? resolvePath(requestedPath)
    : resolvePath(requestedPath);

  for (const allowed of _allowedPaths) {
    if (normalized === allowed) return true;
    if (normalized.startsWith(allowed + sep)) return true;
  }
  return false;
}

function detectProjectIndicators(dirPath: string): string[] {
  const found: string[] = [];
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (PROJECT_INDICATORS.has(entry.name)) {
        found.push(entry.name);
      }
    }
  } catch {
    // Permission denied or doesn't exist — skip
  }
  return found;
}

export function sysLs(input: SysLsInput): SysLsOutput {
  const logger = getLogger();

  if (!isPathAllowed(input.path)) {
    logger.warn({ path: input.path }, 'sysLs: path not allowed');
    throw new Error(
      `Path "${input.path}" is not in the Scout allowed paths. Configure SCOUT_ALLOWED_PATHS in .env.`,
    );
  }

  const absolutePath = resolvePath(input.path);
  const entries = readdirSync(absolutePath, { withFileTypes: true });
  const items: SysLsItem[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const fullPath = resolvePath(absolutePath, entry.name);
    let type: 'file' | 'directory' | 'symlink' = 'file';
    let isProject = false;

    try {
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        type = 'directory';
        isProject = detectProjectIndicators(fullPath).length > 0;
      } else if (stats.isSymbolicLink()) {
        type = 'symlink';
      }
    } catch {
      type = 'file';
    }

    items.push({ name: entry.name, type, isProject });
  }

  items.sort((a, b) => {
    if (a.type !== b.type) {
      const order = { directory: 0, file: 1, symlink: 2 };
      return order[a.type] - order[b.type];
    }
    return a.name.localeCompare(b.name);
  });

  return { path: input.path, items };
}

export function sysWalk(input: SysWalkInput): SysWalkOutput {
  const logger = getLogger();

  if (!isPathAllowed(input.path)) {
    logger.warn({ path: input.path }, 'sysWalk: path not allowed');
    throw new Error(
      `Path "${input.path}" is not in the Scout allowed paths.`,
    );
  }

  const maxDepth = Math.min(input.maxDepth ?? 3, 5);
  const absolutePath = resolvePath(input.path);
  const projects: SysWalkProject[] = [];
  let totalScanned = 0;
  let maxDepthReached = false;

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) {
      maxDepthReached = true;
      return;
    }

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const indicators = detectProjectIndicators(dir);
    if (indicators.length > 0) {
      projects.push({
        path: dir,
        indicators,
      });
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      totalScanned++;

      try {
        const fullPath = resolvePath(dir, entry.name);
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
          walk(fullPath, depth + 1);
        }
      } catch {
        // Permission denied, skip
      }
    }
  }

  walk(absolutePath, 0);

  return {
    path: input.path,
    projects,
    totalScanned,
    maxDepthReached,
  };
}
