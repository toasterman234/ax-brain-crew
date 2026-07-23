import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setVaultRoot } from '../src/tools/vault-path.js';
import { vaultRead } from '../src/tools/vault-read.js';
import { vaultWrite } from '../src/tools/vault-write.js';
import { vaultAppend } from '../src/tools/vault-append.js';
import { vaultSearch } from '../src/tools/vault-search.js';
import { vaultList } from '../src/tools/vault-list.js';
import { vaultMove } from '../src/tools/vault-move.js';
import {
  vaultReadFrontmatter,
  vaultUpdateFrontmatter,
} from '../src/tools/vault-frontmatter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_VAULT = resolve(__dirname, 'fixtures', 'tool-test-vault');

beforeAll(() => {
  rmSync(TEST_VAULT, { recursive: true, force: true });
  mkdirSync(TEST_VAULT, { recursive: true });
  mkdirSync(join(TEST_VAULT, 'Inbox'), { recursive: true });
  mkdirSync(join(TEST_VAULT, 'Projects'), { recursive: true });
  mkdirSync(join(TEST_VAULT, 'Knowledge'), { recursive: true });
  writeFileSync(
    join(TEST_VAULT, 'greeting.md'),
    '---\ndate: 2026-07-19\ntype: note\ntags:\n  - hello\nai-first: true\n---\n\n# Hello World\n\nThis is a test greeting note.',
  );
  writeFileSync(
    join(TEST_VAULT, 'Knowledge', 'research.md'),
    '---\ndate: 2026-07-18\ntype: reference\ntags:\n  - ax-llm\ntopic: AI Agents\n---\n\n# Research on AxLLM\n\nAxLLM is an agent framework that enables structured program execution.',
  );
  setVaultRoot(TEST_VAULT);
});

afterAll(() => {
  rmSync(TEST_VAULT, { recursive: true, force: true });
});

describe('vaultRead', () => {
  it('reads a normal note', () => {
    const result = vaultRead({ path: 'greeting.md' });
    expect(result.path).toBe('greeting.md');
    expect(result.content).toContain('# Hello World');
    expect(result.size).toBeGreaterThan(0);
  });

  it('reads a nested note', () => {
    const result = vaultRead({ path: 'Knowledge/research.md' });
    expect(result.content).toContain('AxLLM is an agent framework');
  });
});

describe('vaultWrite', () => {
  it('creates a new note', () => {
    const result = vaultWrite({
      path: 'Inbox/new-note.md',
      content: '# New Note\n\nFresh content.',
    });
    expect(result.operation).toBe('created');

    const readBack = vaultRead({ path: 'Inbox/new-note.md' });
    expect(readBack.content).toContain('Fresh content');
  });

  it('prevents overwrite by default', () => {
    const result = vaultWrite({
      path: 'greeting.md',
      content: 'overwrite attempt',
    });
    expect(result.operation).toBe('skipped');
    expect(result.reason).toContain('already exists');
  });

  it('allows overwrite with flag', () => {
    const result = vaultWrite({
      path: 'greeting.md',
      content: 'overwritten',
      overwrite: true,
    });
    expect(result.operation).toBe('created');
    const readBack = vaultRead({ path: 'greeting.md' });
    expect(readBack.content).toBe('overwritten');
  });

  it('dry-run does not write', () => {
    const result = vaultWrite({
      path: 'Inbox/dry-run-test.md',
      content: '# Dry Run\n\nShould not exist.',
      dryRun: true,
    });
    expect(result.operation).toBe('dry_run');
    expect(result.preview).toContain('# Dry Run');
    expect(() => vaultRead({ path: 'Inbox/dry-run-test.md' })).toThrow();
  });
});

describe('vaultAppend', () => {
  it('appends to an existing note', () => {
    const result = vaultAppend({
      path: 'greeting.md',
      content: '## Appended Section\n\nMore stuff.',
    });
    expect(result.operation).toBe('appended');

    const readBack = vaultRead({ path: 'greeting.md' });
    expect(readBack.content).toContain('## Appended Section');
  });

  it('errors on missing file', () => {
    const result = vaultAppend({
      path: 'nonexistent.md',
      content: 'test',
    });
    expect(result.operation).toBe('error');
  });

  it('dry-run does not append', () => {
    const result = vaultAppend({
      path: 'greeting.md',
      content: 'DRY RUN',
      dryRun: true,
    });
    expect(result.operation).toBe('dry_run');
    const readBack = vaultRead({ path: 'greeting.md' });
    expect(readBack.content).not.toContain('DRY RUN');
  });
});

describe('vaultSearch', () => {
  it('finds notes by content', () => {
    const result = vaultSearch({ query: 'AxLLM' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0]!.path).toContain('Knowledge/research.md');
  });

  it('respects limit', () => {
    const result = vaultSearch({ query: 'note', limit: 1 });
    expect(result.results.length).toBeLessThanOrEqual(1);
  });

  it('returns empty for no matches', () => {
    const result = vaultSearch({ query: 'xyznonexistent' });
    expect(result.results.length).toBe(0);
  });

  it('can search specific directory', () => {
    const result = vaultSearch({ query: 'AxLLM', directory: 'Knowledge' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });
});

describe('vaultList', () => {
  it('lists root directory', () => {
    const result = vaultList({ directory: '.' });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.some((i) => i.name === 'Inbox')).toBe(true);
    expect(result.items.some((i) => i.name === 'greeting.md')).toBe(true);
  });

  it('lists subdirectory', () => {
    const result = vaultList({ directory: 'Knowledge' });
    expect(result.items.some((i) => i.name === 'research.md')).toBe(true);
  });

  it('sorts directories first', () => {
    const result = vaultList({ directory: '.' });
    const types = result.items.map((i) => i.type);
    const firstDir = types.indexOf('directory');
    expect(firstDir).toBe(0);
  });
});

describe('vaultMove', () => {
  it('moves a file', () => {
    const result = vaultMove({
      source: 'Inbox/new-note.md',
      destination: 'Projects/moved-note.md',
    });
    expect(result.operation).toBe('moved');

    expect(() => vaultRead({ path: 'Inbox/new-note.md' })).toThrow();
    const atDest = vaultRead({ path: 'Projects/moved-note.md' });
    expect(atDest.content).toContain('Fresh content');
  });

  it('errors on missing source', () => {
    const result = vaultMove({
      source: 'nonexistent.md',
      destination: 'Projects/nope.md',
    });
    expect(result.operation).toBe('error');
  });

  it('dry-run does not move', () => {
    const result = vaultMove({
      source: 'Projects/moved-note.md',
      destination: 'Knowledge/another.md',
      dryRun: true,
    });
    expect(result.operation).toBe('dry_run');
    expect(() => vaultRead({ path: 'Projects/moved-note.md' })).not.toThrow();
  });

  it('errors on existing destination', () => {
    const result = vaultMove({
      source: 'Projects/moved-note.md',
      destination: 'Knowledge/research.md',
    });
    expect(result.operation).toBe('error');
  });
});

describe('vaultFrontmatter', () => {
  beforeAll(() => {
    writeFileSync(
      join(TEST_VAULT, 'Knowledge', 'research.md'),
      '---\ndate: 2026-07-18\ntype: reference\ntags:\n  - ax-llm\ntopic: AI Agents\n---\n\n# Research on AxLLM\n\nAxLLM is an agent framework.',
    );
  });

  it('reads frontmatter', () => {
    const result = vaultReadFrontmatter({ path: 'Knowledge/research.md' });
    expect(result.frontmatter).toBeTruthy();
    expect((result.frontmatter as Record<string, unknown>).date).toBe('2026-07-18');
    expect((result.frontmatter as Record<string, unknown>).topic).toBe('AI Agents');
  });

  it('updates frontmatter preserving other fields', () => {
    const result = vaultUpdateFrontmatter({
      path: 'Knowledge/research.md',
      fields: { topic: 'AI Tooling', confidence: 'high' },
    });
    expect(result.operation).toBe('updated');

    const readBack = vaultReadFrontmatter({ path: 'Knowledge/research.md' });
    expect((readBack.frontmatter as Record<string, unknown>).topic).toBe('AI Tooling');
    expect((readBack.frontmatter as Record<string, unknown>).confidence).toBe('high');
    expect((readBack.frontmatter as Record<string, unknown>).date).toBe('2026-07-18');
  });

  it('dry-run does not modify frontmatter', () => {
    const result = vaultUpdateFrontmatter({
      path: 'Knowledge/research.md',
      fields: { topic: 'SHOULD NOT SAVE' },
      dryRun: true,
    });
    expect(result.operation).toBe('dry_run');
    const readBack = vaultReadFrontmatter({ path: 'Knowledge/research.md' });
    expect((readBack.frontmatter as Record<string, unknown>).topic).not.toBe('SHOULD NOT SAVE');
  });
});
