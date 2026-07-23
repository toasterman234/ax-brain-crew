import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const MIN_SECTION_CHARS = 40;
const NEGATIVE_RESULTS = new Set(['parked', 'failed', 'superseded', 'cancelled']);

export interface DerivedStatusFields {
  derived_phase: 'scope' | 'plan' | 'build' | 'verify' | 'complete' | 'needs-attention';
  derived_status:
    | 'active'
    | 'blocked'
    | 'awaiting-proof'
    | 'awaiting-result'
    | 'complete'
    | 'parked'
    | 'failed'
    | 'superseded'
    | 'cancelled'
    | 'needs-attention';
  derived_result: string;
  derived_updated_at: string;
  explanation: string;
  latestProof: string;
  autoBlocker: string;
}

function sectionRange(body: string, headingPatterns: RegExp[]): { start: number; end: number; content: string } | null {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (!h?.[2]) continue;
    const heading = h[2].trim();
    if (!headingPatterns.some((p) => p.test(heading))) continue;
    const headingLevel = h[1]!.length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? '';
      const nextH = next.match(/^(#{1,6})\s+/);
      if (nextH && nextH[1]!.length <= headingLevel) {
        end = j;
        break;
      }
    }
    return { start: i, end, content: lines.slice(i + 1, end).join('\n').trim() };
  }
  return null;
}

function meaningfulText(section: string): string {
  return section
    .split('\n')
    .filter((line) => !/^#{1,6}\s+/.test(line.trim()))
    .join('\n')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[`*_>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasMeaningfulSection(body: string, headingPatterns: RegExp[]): boolean {
  const section = sectionRange(body, headingPatterns);
  return !!section && meaningfulText(section.content).length >= MIN_SECTION_CHARS;
}

function hasPlanStructure(body: string): boolean {
  const plan = sectionRange(body, [/^plan$/i, /^plan\b/i]);
  if (!plan) return false;
  const text = plan.content;
  const hasLabel = (source: string, ...words: string[]) => {
    const alt = words.join('|');
    const re = new RegExp(
      `^\\s*(?:#{1,6}\\s+|[-*]\\s+)?(?:\\*\\*)?\\s*(?:${alt})(?:\\*\\*)?\\s*[:：]?\\s*$` +
        `|^\\s*(?:[-*]\\s+)?(?:\\*\\*)?\\s*(?:${alt})(?:\\*\\*)?\\s*[:：]\\s+\\S`,
      'im',
    );
    return re.test(source);
  };
  return (
    hasLabel(text, 'goal', 'goals') &&
    hasLabel(text, 'task', 'tasks') &&
    hasLabel(text, 'open decision', 'open decisions', 'decision', 'decisions')
  );
}

function readInlineField(body: string, name: string): string {
  const re = new RegExp(`^${name}::[ \\t]*([^\\n\\r]*)$`, 'im');
  const m = body.match(re);
  return (m?.[1] ?? '').trim();
}

function wikiTargets(text: string): string[] {
  return Array.from(text.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)).map((m) => (m[1] ?? '').trim()).filter(Boolean);
}

function walk(dir: string, fn: (file: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(full, fn);
    else if (entry.isFile()) fn(full);
  }
}

function linkResolvesInVault(vaultRoot: string, target: string): boolean {
  const direct = [resolve(vaultRoot, target), resolve(vaultRoot, `${target}.md`)];
  for (const path of direct) {
    try {
      if (statSync(path).isFile()) return true;
    } catch {
      // continue
    }
  }
  let found = false;
  walk(vaultRoot, (file) => {
    if (found || !file.endsWith('.md')) return;
    const base = file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/, '');
    if (base.toLowerCase() === target.toLowerCase()) found = true;
  });
  return found;
}

function hasResolvableEvidence(body: string, heading: string, vaultRoot?: string): boolean {
  const section = sectionRange(body, [new RegExp(`^${heading}$`, 'i'), new RegExp(`^${heading}\\b`, 'i')]);
  if (!section) return false;
  const targets = wikiTargets(section.content);
  if (targets.length === 0) return false;
  if (!vaultRoot) return true;
  return targets.some((target) => linkResolvesInVault(vaultRoot, target));
}

function firstResolvableLink(body: string, heading: string, vaultRoot?: string): string {
  const section = sectionRange(body, [new RegExp(`^${heading}$`, 'i'), new RegExp(`^${heading}\\b`, 'i')]);
  if (!section) return '';
  const targets = wikiTargets(section.content);
  if (targets.length === 0) return '';
  if (!vaultRoot) return targets[0] ?? '';
  return targets.find((t) => linkResolvesInVault(vaultRoot, t)) ?? '';
}

export function deriveProjectNoteStatus(raw: string, opts: { vaultRoot?: string; nowIso?: string } = {}): DerivedStatusFields {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const body = raw.startsWith('---\n') ? raw.replace(/^---\n[\s\S]*?\n---\n?/, '') : raw;

  const blockerRaw = readInlineField(body, 'blocker');
  // auto-generated blocker text (starts with "missing:") is informational only —
  // don't treat it as a real blocker for status derivation
  const blocker = blockerRaw.startsWith('missing:') ? '' : blockerRaw;
  const result = readInlineField(body, 'result').toLowerCase();

  // walk evidence categories in priority order: highest completed first
  const evidenceCategories = ['Verification evidence', 'Build evidence', 'Plan evidence', 'Scope evidence'];
  let latestProof = '';
  for (const cat of evidenceCategories) {
    latestProof = firstResolvableLink(body, cat, opts.vaultRoot);
    if (latestProof) break;
  }

  if (!hasMeaningfulSection(body, [/problem/i, /intent/i])) {
    return {
      derived_phase: 'scope',
      derived_status: blocker ? 'blocked' : 'active',
      derived_result: '',
      derived_updated_at: nowIso,
      explanation: blocker ? 'phase = scope; status = blocked because blocker is set' : 'phase = scope because Problem is insufficient',
      latestProof,
      autoBlocker: blocker ? '' : 'missing: Problem section insufficient',
    };
  }

  if (!hasMeaningfulSection(body, [/approach/i, /solution/i, /design/i, /what.?s built/i])) {
    return {
      derived_phase: 'scope',
      derived_status: blocker ? 'blocked' : 'active',
      derived_result: '',
      derived_updated_at: nowIso,
      explanation: blocker ? 'phase = scope; status = blocked because blocker is set' : 'phase = scope because Approach is insufficient',
      latestProof,
      autoBlocker: blocker ? '' : 'missing: Approach section insufficient',
    };
  }

  if (!hasPlanStructure(body)) {
    return {
      derived_phase: 'plan',
      derived_status: blocker ? 'blocked' : 'active',
      derived_result: '',
      derived_updated_at: nowIso,
      explanation: blocker ? 'phase = plan; status = blocked because blocker is set' : 'phase = plan because Plan is insufficient',
      latestProof,
      autoBlocker: blocker ? '' : 'missing: Plan structure (need Goal + Tasks + Open decisions)',
    };
  }

  const buildReady = hasResolvableEvidence(body, 'Build evidence', opts.vaultRoot);
  if (!buildReady) {
    return {
      derived_phase: 'build',
      derived_status: blocker ? 'blocked' : 'awaiting-proof',
      derived_result: '',
      derived_updated_at: nowIso,
      explanation: blocker ? 'phase = build; status = blocked because blocker is set' : 'phase = build because no build evidence resolves yet',
      latestProof,
      autoBlocker: blocker ? '' : 'missing: Build evidence has no resolvable proof links',
    };
  }

  const verifyReady = hasResolvableEvidence(body, 'Verification evidence', opts.vaultRoot);
  if (!verifyReady) {
    return {
      derived_phase: 'verify',
      derived_status: blocker ? 'blocked' : 'awaiting-proof',
      derived_result: '',
      derived_updated_at: nowIso,
      explanation: blocker ? 'phase = verify; status = blocked because blocker is set' : 'phase = verify because no verification evidence resolves yet',
      latestProof,
      autoBlocker: blocker ? '' : 'missing: Verification evidence has no resolvable proof links',
    };
  }

  if (NEGATIVE_RESULTS.has(result)) {
    return {
      derived_phase: 'complete',
      derived_status: result as DerivedStatusFields['derived_status'],
      derived_result: result,
      derived_updated_at: nowIso,
      explanation: `phase = complete; status = ${result} because result is explicitly set`,
      latestProof,
      autoBlocker: '',
    };
  }

  if (result === 'shipped' || result === 'proved') {
    return {
      derived_phase: 'complete',
      derived_status: 'complete',
      derived_result: result,
      derived_updated_at: nowIso,
      explanation: `phase = complete; status = complete because result is ${result}`,
      latestProof,
      autoBlocker: '',
    };
  }

  if (blocker) {
    return {
      derived_phase: 'complete',
      derived_status: 'blocked',
      derived_result: '',
      derived_updated_at: nowIso,
      explanation: 'phase = complete; status = blocked because blocker is set and result is still blank',
      latestProof,
      autoBlocker: '',
    };
  }

  return {
    derived_phase: 'complete',
    derived_status: 'awaiting-result',
    derived_result: '',
    derived_updated_at: nowIso,
    explanation: 'phase = complete because all evidence exists; status = awaiting-result because result is still blank',
    latestProof,
    autoBlocker: '',
  };
}

export function applyDerivedFieldsToNote(raw: string, derived: DerivedStatusFields): string {
  const replaceField = (source: string, name: string, value: string) => {
    const re = new RegExp(`^${name}::.*$`, 'm');
    if (re.test(source)) return source.replace(re, `${name}:: ${value}`.trimEnd());
    const controlIdx = source.indexOf('## Control');
    if (controlIdx === -1) return source;
    const insertAt = source.indexOf('\n', controlIdx);
    return `${source.slice(0, insertAt + 1)}${name}:: ${value}\n${source.slice(insertAt + 1)}`;
  };

  // human-authored fields — only fill when blank; never overwrite existing values
  const setIfEmpty = (source: string, name: string, value: string): string => {
    if (!value) return source;
    const current = readInlineField(source, name);
    if (current) return source;
    return replaceField(source, name, value);
  };

  let next = raw;
  next = replaceField(next, 'derived_phase', derived.derived_phase);
  next = replaceField(next, 'derived_status', derived.derived_status);
  next = replaceField(next, 'derived_result', derived.derived_result);
  next = replaceField(next, 'derived_updated_at', derived.derived_updated_at);
  next = setIfEmpty(next, 'latest_proof', derived.latestProof);
  next = setIfEmpty(next, 'blocker', derived.autoBlocker);
  return next;
}


export function refreshDerivedStatusNote(
  raw: string,
  opts: { vaultRoot?: string; nowIso?: string } = {},
): { changed: boolean; raw: string; derived: DerivedStatusFields } {
  const derived = deriveProjectNoteStatus(raw, opts);
  const next = applyDerivedFieldsToNote(raw, derived);
  return { changed: next !== raw, raw: next, derived };
}