import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setVaultRoot } from '../src/tools/vault-path.js';
import { scanVault } from '../src/tools/vault-scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_VAULT = resolve(__dirname, 'fixtures', 'vault-scan-vault');

beforeEach(() => {
  rmSync(TEST_VAULT, { recursive: true, force: true });
  mkdirSync(join(TEST_VAULT, 'Inbox'), { recursive: true });
  mkdirSync(join(TEST_VAULT, 'Knowledge'), { recursive: true });
  setVaultRoot(TEST_VAULT);
});

afterEach(() => {
  rmSync(TEST_VAULT, { recursive: true, force: true });
});

describe('scanVault', () => {
  it('finds a note missing required frontmatter fields', () => {
    writeFileSync(join(TEST_VAULT, 'Inbox', 'bare.md'), '# Bare note\n\nbody\n');

    const result = scanVault();

    const issue = result.issues.find((i) => i.type === 'missing_frontmatter');
    expect(issue).toBeDefined();
    expect(issue?.path).toBe('Inbox/bare.md');
    expect(issue?.missingFields).toEqual(
      expect.arrayContaining(['date', 'type', 'tags', 'ai-first']),
    );
  });

  it('finds a broken wikilink and resolves a valid one', () => {
    writeFileSync(
      join(TEST_VAULT, 'Knowledge', 'target.md'),
      '---\ndate: 2026-07-20\ntype: reference\ntags: []\nai-first: true\n---\n\ncontent\n',
    );
    writeFileSync(
      join(TEST_VAULT, 'Inbox', 'linker.md'),
      '---\ndate: 2026-07-20\ntype: note\ntags: []\nai-first: true\n---\n\n' +
        'Links to [[target]] (valid) and [[Does Not Exist]] (broken).\n',
    );

    const result = scanVault();

    const broken = result.issues.filter((i) => i.type === 'broken_link');
    expect(broken).toHaveLength(1);
    expect(broken[0]?.brokenLink).toBe('Does Not Exist');
    // The valid link to target.md must NOT be flagged.
    expect(broken.some((i) => i.brokenLink === 'target')).toBe(false);
  });

  it('flags a stale note with no incoming or outgoing links', () => {
    const p = join(TEST_VAULT, 'Inbox', 'stale.md');
    writeFileSync(
      p,
      '---\ndate: 2026-01-01\ntype: note\ntags: []\nai-first: true\n---\n\nold\n',
    );
    const oldTime = new Date('2020-01-01').getTime() / 1000;
    utimesSync(p, oldTime, oldTime);

    const result = scanVault();

    expect(result.issues.some((i) => i.type === 'stale_orphan' && i.path === 'Inbox/stale.md')).toBe(
      true,
    );
  });

  it('reports a clean vault with zero issues and a full health score', () => {
    writeFileSync(
      join(TEST_VAULT, 'Inbox', 'clean.md'),
      '---\ndate: 2026-07-20\ntype: note\ntags: []\nai-first: true\n---\n\nno links, but fresh\n',
    );

    const result = scanVault();

    expect(result.totalNotes).toBe(1);
    expect(result.issues).toEqual([]);
    expect(result.healthScore).toBe(100);
  });
});
