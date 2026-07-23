import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getVaultRoot, isPathExcluded } from './vault-path.js';

export interface ScanIssue {
  type: 'broken_link' | 'missing_frontmatter' | 'stale_orphan';
  path: string;
  detail: string;
  brokenLink?: string;
  missingFields?: string[];
}

export interface VaultScanResult {
  totalNotes: number;
  issues: ScanIssue[];
  healthScore: number;
  reportMarkdown: string;
}

const REQUIRED_FRONTMATTER_FIELDS = ['date', 'type', 'tags', 'ai-first'];
const STALE_DAYS = 90;
const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

function splitFrontmatter(content: string): {
  fm: Record<string, unknown> | null;
  body: string;
} {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: null, body: content };
  try {
    return { fm: (parseYaml(m[1]!) as Record<string, unknown>) ?? null, body: m[2]! };
  } catch {
    return { fm: null, body: m[2]! };
  }
}

function walkMarkdownFiles(dir: string, root: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    const rel = full.replace(root + '/', '').replace(/\\/g, '/');
    if (isPathExcluded(rel)) continue;
    if (entry.isDirectory()) {
      walkMarkdownFiles(full, root, out);
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      out.push(full);
    }
  }
}

/**
 * Deterministic, mechanical vault audit — no LLM. Covers the parts of
 * crew/skills/vault-audit.md that don't need judgment: frontmatter
 * completeness, broken [[wikilinks]], and stale+orphan notes. Folder-convention
 * and tag-quality analysis (the skill's other two categories) need semantic
 * judgment and are left to the LLM-driven vault-audit skill / a future E2 flow.
 *
 * This exists because deep-clean's self-sufficiency branch used to run the
 * LLM-driven audit inline, which timed out crawling the vault at ~10s/round
 * over many rounds (see ax-native-rebuild.md E1 progress log, 2026-07-20).
 * Mechanical checks don't need an LLM at all — this runs in milliseconds.
 */
export function scanVault(): VaultScanResult {
  const root = getVaultRoot();
  const files: string[] = [];
  walkMarkdownFiles(root, root, files);

  interface NoteInfo {
    path: string;
    fm: Record<string, unknown> | null;
    links: string[];
    mtime: Date;
  }
  const notes: NoteInfo[] = [];
  for (const full of files) {
    const rel = full.replace(root + '/', '').replace(/\\/g, '/');
    let content: string;
    try {
      content = readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    const { fm, body } = splitFrontmatter(content);
    const links = [...body.matchAll(WIKILINK_RE)].map((m) => m[1]!.trim());
    notes.push({ path: rel, fm, links, mtime: statSync(full).mtime });
  }

  // Resolve link targets by basename (case-insensitive) — vault wikilinks
  // commonly omit folder + extension.
  const byBasename = new Map<string, string[]>();
  for (const n of notes) {
    const base = n.path.split('/').pop()!.replace(/\.md$/i, '').toLowerCase();
    byBasename.set(base, [...(byBasename.get(base) ?? []), n.path]);
  }
  const resolveLink = (target: string): string | null => {
    const norm = target.replace(/\.md$/i, '');
    const direct = notes.find(
      (n) => n.path.replace(/\.md$/i, '').toLowerCase() === norm.toLowerCase(),
    );
    if (direct) return direct.path;
    return byBasename.get(norm.split('/').pop()!.toLowerCase())?.[0] ?? null;
  };

  const incomingCount = new Map<string, number>();
  const issues: ScanIssue[] = [];

  for (const n of notes) {
    const missing = REQUIRED_FRONTMATTER_FIELDS.filter(
      (f) => !n.fm || n.fm[f] === undefined || n.fm[f] === null || n.fm[f] === '',
    );
    if (missing.length > 0) {
      issues.push({
        type: 'missing_frontmatter',
        path: n.path,
        detail: `missing frontmatter field(s): ${missing.join(', ')}`,
        missingFields: missing,
      });
    }
    for (const link of n.links) {
      const resolved = resolveLink(link);
      if (resolved) {
        incomingCount.set(resolved, (incomingCount.get(resolved) ?? 0) + 1);
      } else {
        issues.push({
          type: 'broken_link',
          path: n.path,
          detail: `broken link [[${link}]]`,
          brokenLink: link,
        });
      }
    }
  }

  const staleMs = STALE_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const n of notes) {
    const isStale = now - n.mtime.getTime() > staleMs;
    const hasOutgoing = n.links.length > 0;
    const hasIncoming = (incomingCount.get(n.path) ?? 0) > 0;
    if (isStale && !hasOutgoing && !hasIncoming) {
      issues.push({
        type: 'stale_orphan',
        path: n.path,
        detail: `no modification in ${STALE_DAYS}+ days, no incoming or outgoing links`,
      });
    }
  }

  const total = notes.length || 1;
  const frontmatterIssueCount = issues.filter((i) => i.type === 'missing_frontmatter').length;
  const brokenLinkCount = issues.filter((i) => i.type === 'broken_link').length;
  const staleCount = issues.filter((i) => i.type === 'stale_orphan').length;
  // Simplified weighting over the three mechanical categories this scan covers
  // (frontmatter 40%, links 40%, freshness 20%) — folder-convention and tag
  // quality (the full skill's other two categories) aren't scored here.
  const healthScore = Math.round(
    (Math.max(0, 1 - frontmatterIssueCount / total) * 0.4 +
      Math.max(0, 1 - brokenLinkCount / total) * 0.4 +
      Math.max(0, 1 - staleCount / total) * 0.2) *
      100,
  );

  const lines = issues.length
    ? issues.map((i) => `- [${i.type}] ${i.path} — ${i.detail}`).join('\n')
    : '- (no issues found)';
  const reportMarkdown =
    `# Vault Audit — deterministic scan\n\n` +
    `Notes scanned: ${notes.length}\n` +
    `Health score: ${healthScore}/100 (mechanical subset: frontmatter, links, freshness)\n\n` +
    `## Findings\n${lines}\n`;

  return { totalNotes: notes.length, issues, healthScore, reportMarkdown };
}
