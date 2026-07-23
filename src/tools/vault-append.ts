import { appendFileSync, existsSync } from 'node:fs';
import { resolveVaultPath, guardExcludedPath } from './vault-path.js';
import { looksLikeToolResultEcho } from './vault-tool-echo-guard.js';

export interface VaultAppendInput {
  path: string;
  content: string;
  dryRun?: boolean;
}

export interface VaultAppendOutput {
  path: string;
  operation: 'appended' | 'dry_run' | 'error';
  preview?: string;
  reason?: string;
}

export function vaultAppend(input: VaultAppendInput): VaultAppendOutput {
  const { absolutePath, vaultRelativePath } = resolveVaultPath(input.path);
  guardExcludedPath(vaultRelativePath);

  if (!existsSync(absolutePath)) {
    return {
      path: vaultRelativePath,
      operation: 'error',
      reason: 'Target file does not exist.',
    };
  }

  if (looksLikeToolResultEcho(input.content)) {
    return {
      path: vaultRelativePath,
      operation: 'error',
      reason:
        'Refusing to append: content looks like a raw vault.read tool result ' +
        '(a {path, content, modifiedAt, size} object), not real note text.',
    };
  }

  if (input.dryRun) {
    return {
      path: vaultRelativePath,
      operation: 'dry_run',
      preview: input.content.slice(0, 500),
      reason: 'Dry run — nothing was appended.',
    };
  }

  appendFileSync(absolutePath, '\n' + input.content, 'utf-8');

  return {
    path: vaultRelativePath,
    operation: 'appended',
  };
}
