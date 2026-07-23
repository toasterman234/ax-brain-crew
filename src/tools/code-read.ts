import { readFileSync, statSync, realpathSync } from 'node:fs';
import { resolve, normalize, sep } from 'node:path';

// Read-only access to the crew's own source tree so the Investigator can trace
// a failure down to the line of code that produced it (e.g. "the executor marks
// the run completed because responseText is a bare string"). This reads source
// only — it never writes, and it is fenced to the repo root with the same
// traversal/symlink guards the vault tools use, plus a secrets denylist.

export class CodeReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeReadError';
  }
}

// The repo root is the process working directory (the crew is launched from its
// own root — the same assumption DATABASE_PATH='./data/crew.sqlite' relies on).
function repoRoot(): string {
  return realpathSync(resolve(process.cwd()));
}

// Files that may hold secrets or credentials — never readable through this tool.
const DENY = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)secrets?(\/|$)/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)\.git(\/|$)/i,
];

export interface CodeReadInput {
  path: string; // repo-relative, e.g. "src/runtime/executor.ts"
  maxChars?: number;
}

export interface CodeReadOutput {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
}

export function codeRead(input: CodeReadInput): CodeReadOutput {
  const root = repoRoot();
  const rel = input.path;

  if (rel.startsWith('/') || rel.startsWith(sep)) {
    throw new CodeReadError(`Absolute paths not allowed: "${rel}"`);
  }
  const normalized = normalize(rel).replace(/\\/g, sep);
  if (normalized.split(sep).includes('..')) {
    throw new CodeReadError(`Path traversal not allowed: "${rel}"`);
  }
  if (DENY.some((re) => re.test(rel.replace(/\\/g, '/')))) {
    throw new CodeReadError(
      `Access denied: "${rel}" may contain secrets and is not readable.`,
    );
  }

  const absolute = resolve(root, normalized);
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch {
    throw new CodeReadError(`File not found: "${rel}"`);
  }
  if (!canonical.startsWith(root + sep) && canonical !== root) {
    throw new CodeReadError(`Path escapes the repo: "${rel}"`);
  }

  const stats = statSync(canonical);
  if (stats.isDirectory()) {
    throw new CodeReadError(
      `Path is a directory, not a file: "${rel}". Use sys.ls to list it.`,
    );
  }

  const max = Math.min(Math.max(input.maxChars ?? 20000, 500), 60000);
  const raw = readFileSync(canonical, 'utf-8');
  const truncated = raw.length > max;
  return {
    path: normalized.replace(/\\/g, '/'),
    content: truncated
      ? `${raw.slice(0, max)}\n…[truncated ${raw.length - max} chars]`
      : raw,
    size: stats.size,
    truncated,
  };
}
