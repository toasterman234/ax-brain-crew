import { writeFileSync, existsSync, statSync } from 'node:fs';
import { resolveVaultPath, guardExcludedPath, ensureParentDir } from './vault-path.js';

export interface VaultWriteInput {
  path: string;
  content: string;
  overwrite?: boolean;
  dryRun?: boolean;
}

export interface VaultWriteOutput {
  path: string;
  operation: 'created' | 'skipped' | 'dry_run';
  preview?: string;
  reason?: string;
}

import { looksLikeToolResultEcho } from './vault-tool-echo-guard.js';

export function vaultWrite(input: VaultWriteInput): VaultWriteOutput {
  const { absolutePath, vaultRelativePath } = resolveVaultPath(input.path);
  guardExcludedPath(vaultRelativePath);

  if (looksLikeToolResultEcho(input.content)) {
    return {
      path: vaultRelativePath,
      operation: 'skipped',
      reason:
        'Refusing to write: content looks like a raw vault.read tool result ' +
        '(a {path, content, modifiedAt, size} object), not real note text. ' +
        'If you read a template, extract its `.content` field and fill in the ' +
        'placeholders before writing — do not pass the tool result through.',
    };
  }

  if (existsSync(absolutePath)) {
    if (statSync(absolutePath).isDirectory()) {
      return {
        path: vaultRelativePath,
        operation: 'skipped',
        reason: `Path is a directory, not a file: ${vaultRelativePath}. Write to a file path instead.`,
      };
    }
    if (!input.overwrite) {
      return {
        path: vaultRelativePath,
        operation: 'skipped',
        reason: `File already exists. Use overwrite:true to replace.`,
      };
    }
  }

  if (input.dryRun) {
    return {
      path: vaultRelativePath,
      operation: 'dry_run',
      preview: input.content.slice(0, 500),
      reason: 'Dry run — no file was written.',
    };
  }

  ensureParentDir(absolutePath);
  writeFileSync(absolutePath, input.content, 'utf-8');

  return {
    path: vaultRelativePath,
    operation: 'created',
  };
}
