import { realpathSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, normalize, sep, dirname } from 'node:path';
import { getConfig } from '../config.js';

export class VaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultPathError';
  }
}

let _resolvedVaultRoot: string | null = null;

export function setVaultRoot(path: string): void {
  const canonical = realpathSync(resolve(path));
  _resolvedVaultRoot = canonical;
}

export function getVaultRoot(): string {
  if (!_resolvedVaultRoot) {
    throw new VaultPathError('Vault root not set. Call setVaultRoot() first.');
  }
  return _resolvedVaultRoot;
}

export function isPathExcluded(vaultRelativePath: string): boolean {
  const config = getConfig();
  if (config.vaultExcludedDirs.length === 0) return false;

  const normalized = vaultRelativePath.replace(/\\/g, '/').replace(/\/$/, '');
  return config.vaultExcludedDirs.some(
    (excluded) =>
      normalized === excluded || normalized.startsWith(excluded + '/'),
  );
}

export function guardExcludedPath(vaultRelativePath: string): void {
  if (isPathExcluded(vaultRelativePath)) {
    throw new VaultPathError(
      `Access denied: "${vaultRelativePath}" is in an excluded directory.`,
    );
  }
}

export function resolveVaultPath(relativePath: string): {
  absolutePath: string;
  vaultRelativePath: string;
} {
  const root = getVaultRoot();
  const normalized = normalize(relativePath).replace(/\\/g, sep);

  if (normalize(relativePath) !== normalized) {
    throw new VaultPathError(
      `Path traversal detected in: "${relativePath}"`,
    );
  }

  if (relativePath.startsWith('/') || relativePath.startsWith(sep)) {
    throw new VaultPathError(
      `Absolute paths not allowed: "${relativePath}"`,
    );
  }

  const segments = normalized.split(sep);
  if (segments.includes('..')) {
    throw new VaultPathError(
      `Path traversal not allowed: "${relativePath}"`,
    );
  }

  const absolute = resolve(root, normalized);

  if (existsSync(absolute)) {
    let canonical: string;
    try {
      canonical = realpathSync(absolute);
    } catch {
      throw new VaultPathError(`Cannot resolve path: "${relativePath}"`);
    }

    if (!canonical.startsWith(root + sep) && canonical !== root) {
      throw new VaultPathError(
        `Symlink escape detected: "${relativePath}" resolves outside vault`,
      );
    }
  } else {
    const parent = resolve(absolute, '..');
    let canonicalParent: string;
    try {
      canonicalParent = realpathSync(parent);
    } catch {
      canonicalParent = parent;
    }

    if (
      !canonicalParent.startsWith(root + sep) &&
      canonicalParent !== root
    ) {
      throw new VaultPathError(
        `Path outside vault: "${relativePath}"`,
      );
    }
  }

  return {
    absolutePath: absolute,
    vaultRelativePath: normalized.replace(/\\/g, '/'),
  };
}

export function ensureParentDir(filePath: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
}
