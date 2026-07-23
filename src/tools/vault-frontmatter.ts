import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolveVaultPath, guardExcludedPath } from './vault-path.js';

export interface FrontmatterResult {
  path: string;
  frontmatter: Record<string, unknown> | null;
}

export interface UpdateFrontmatterInput {
  path: string;
  fields: Record<string, unknown>;
  dryRun?: boolean;
}

export interface UpdateFrontmatterOutput {
  path: string;
  operation: 'updated' | 'dry_run' | 'error';
  previousFields?: Record<string, unknown>;
  newFields?: Record<string, unknown>;
  reason?: string;
}

function splitFrontmatter(content: string): {
  frontmatter: string | null;
  body: string;
  parsed: Record<string, unknown> | null;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: null, body: content, parsed: null };
  }

  try {
    return {
      frontmatter: match[1]!,
      body: match[2]!,
      parsed: parseYaml(match[1]!) as Record<string, unknown>,
    };
  } catch {
    return { frontmatter: match[1]!, body: match[2]!, parsed: null };
  }
}

export function vaultReadFrontmatter(input: {
  path: string;
}): FrontmatterResult {
  const { absolutePath, vaultRelativePath } = resolveVaultPath(input.path);
  guardExcludedPath(vaultRelativePath);
  const content = readFileSync(absolutePath, 'utf-8');
  const { parsed } = splitFrontmatter(content);

  return {
    path: vaultRelativePath,
    frontmatter: parsed,
  };
}

export function vaultUpdateFrontmatter(
  input: UpdateFrontmatterInput,
): UpdateFrontmatterOutput {
  const { absolutePath, vaultRelativePath } = resolveVaultPath(input.path);
  guardExcludedPath(vaultRelativePath);

  if (!existsSync(absolutePath)) {
    return {
      path: vaultRelativePath,
      operation: 'error',
      reason: 'File does not exist.',
    };
  }

  const content = readFileSync(absolutePath, 'utf-8');
  const { frontmatter, body, parsed } = splitFrontmatter(content);

  if (frontmatter === null) {
    return {
      path: vaultRelativePath,
      operation: 'error',
      reason: 'No frontmatter found in file.',
    };
  }

  const previousFields = parsed ?? {};
  const newFields = { ...previousFields, ...input.fields };

  if (input.dryRun) {
    return {
      path: vaultRelativePath,
      operation: 'dry_run',
      previousFields,
      newFields,
      reason: 'Dry run — frontmatter was not updated.',
    };
  }

  const newContent = `---\n${stringifyYaml(newFields)}\n---\n${body}`;
  writeFileSync(absolutePath, newContent, 'utf-8');

  return {
    path: vaultRelativePath,
    operation: 'updated',
    previousFields,
    newFields,
  };
}
