import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getVaultRoot, isPathExcluded } from './vault-path.js';

export interface TagUsage {
  tag: string;
  count: number;
  paths: string[];
}

export interface NearDuplicateGroup {
  tags: string[];
  /** The most-used tag in the group; used as the default canonical suggestion. */
  suggestedCanonical: string;
}

export interface TagScanResult {
  totalUniqueTags: number;
  aggregateTagCount: number;
  usage: TagUsage[];
  /** Tags used on exactly one note. */
  orphanTags: string[];
  /** Mechanically-detected near-duplicate groups (case/separator/plural variants). */
  nearDuplicateGroups: NearDuplicateGroup[];
  /** Notes exceeding the max-tags-per-note convention (5, per tag-garden.md). */
  overTagged: { path: string; count: number }[];
}

const MAX_TAGS_PER_NOTE = 5;

function splitFrontmatter(content: string): Record<string, unknown> | null {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return null;
  try {
    return (parseYaml(m[1]!) as Record<string, unknown>) ?? null;
  } catch {
    return null;
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

function extractTags(fm: Record<string, unknown> | null): string[] {
  if (!fm) return [];
  const raw = fm.tags;
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return [];
}

/**
 * Normalize a tag for near-duplicate comparison: lowercase, collapse
 * separators (space/underscore → hyphen), and strip a trailing "s" (naive
 * singular/plural fold) so "AI" ~ "ai", "machine-learning" ~ "machine learning",
 * "project" ~ "projects" all compare equal. Hierarchy prefixes (a/b) are left
 * intact — merging across hierarchy levels is a judgment call, not mechanical.
 */
function normalizeForDuplicateCheck(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+$/, '')
    .replace(/s$/, '');
}

/**
 * Deterministic, mechanical tag inventory — no LLM. Covers everything in
 * tag-garden.md that's purely mechanical: frequency counts, orphans (used on
 * exactly one note), near-duplicates by case/separator/plural normalization,
 * and over-tagged notes. Deciding WHICH near-duplicate is canonical, and
 * whether two same-normalized tags actually mean the same thing, stays a
 * judgment call for the LLM node in the flow.
 */
export function scanTags(): TagScanResult {
  const root = getVaultRoot();
  const files: string[] = [];
  walkMarkdownFiles(root, root, files);

  const usageMap = new Map<string, { count: number; paths: string[] }>();
  const overTagged: { path: string; count: number }[] = [];

  for (const full of files) {
    const rel = full.replace(root + '/', '').replace(/\\/g, '/');
    let content: string;
    try {
      content = readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    const fm = splitFrontmatter(content);
    const tags = extractTags(fm);
    if (tags.length > MAX_TAGS_PER_NOTE) {
      overTagged.push({ path: rel, count: tags.length });
    }
    for (const tag of tags) {
      const entry = usageMap.get(tag) ?? { count: 0, paths: [] };
      entry.count++;
      entry.paths.push(rel);
      usageMap.set(tag, entry);
    }
  }

  const usage: TagUsage[] = [...usageMap.entries()]
    .map(([tag, v]) => ({ tag, count: v.count, paths: v.paths }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  const orphanTags = usage.filter((u) => u.count === 1).map((u) => u.tag);

  // Group by normalized form; only groups with 2+ distinct raw tags are real
  // near-duplicates.
  const byNormalized = new Map<string, string[]>();
  for (const u of usage) {
    const norm = normalizeForDuplicateCheck(u.tag);
    byNormalized.set(norm, [...(byNormalized.get(norm) ?? []), u.tag]);
  }
  const nearDuplicateGroups: NearDuplicateGroup[] = [...byNormalized.values()]
    .filter((group) => group.length > 1)
    .map((tags) => {
      const canonical = tags
        .map((t) => ({ t, count: usageMap.get(t)?.count ?? 0 }))
        .sort((a, b) => b.count - a.count)[0]!.t;
      return { tags, suggestedCanonical: canonical };
    });

  const aggregateTagCount = usage.reduce((sum, u) => sum + u.count, 0);

  return {
    totalUniqueTags: usage.length,
    aggregateTagCount,
    usage,
    orphanTags,
    nearDuplicateGroups,
    overTagged,
  };
}
