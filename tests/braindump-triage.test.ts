import { describe, it, expect } from 'vitest';
import {
  findRawFilePath,
  sanitizeSlug,
  wikilinkFromSlug,
  triageButtonBlock,
  triageBaseYaml,
  todayIso,
} from '../src/flows/braindump-triage.js';

describe('sanitizeSlug', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(sanitizeSlug('My Cool Idea')).toBe('my-cool-idea');
  });

  it('removes special characters', () => {
    expect(sanitizeSlug('hello! @world #123')).toBe('hello-world-123');
  });

  it('collapses multiple hyphens', () => {
    expect(sanitizeSlug('a---b')).toBe('a-b');
  });

  it('strips leading and trailing hyphens', () => {
    expect(sanitizeSlug('-hello-')).toBe('hello');
  });

  it('handles already-clean slugs unchanged', () => {
    expect(sanitizeSlug('already-clean')).toBe('already-clean');
  });

  it('handles empty string', () => {
    expect(sanitizeSlug('')).toBe('');
  });

  it('handles unicode punctuation', () => {
    expect(sanitizeSlug('café—résumé—flambé')).toBe('caf-r-sum-flamb');
  });
});

describe('wikilinkFromSlug', () => {
  it('builds a correct wikilink with heading anchor', () => {
    expect(wikilinkFromSlug('2026-07-20-braindump-original.md', 'my-item-slug'))
      .toBe('[[2026-07-20-braindump-original#my-item-slug|link]]');
  });

  it('handles raw file name without .md', () => {
    expect(wikilinkFromSlug('note.md', 'heading'))
      .toBe('[[note#heading|link]]');
  });
});

describe('triageButtonBlock', () => {
  it('contains all three button labels', () => {
    const block = triageButtonBlock();
    expect(block).toContain('🚀 Route to board');
    expect(block).toContain('🔎 Research');
    expect(block).toContain('🗄️ Archive');
  });

  it('contains the correct Meta Bind action IDs', () => {
    const block = triageButtonBlock();
    expect(block).toContain('id: triage-route');
    expect(block).toContain('id: triage-research');
    expect(block).toContain('id: triage-archive');
  });

  it('includes the BUTTON inline marker line', () => {
    expect(triageButtonBlock()).toContain(
      '`BUTTON[triage-route]` `BUTTON[triage-research]` `BUTTON[triage-archive]`',
    );
  });

  it('is deterministic — same output every call', () => {
    expect(triageButtonBlock()).toBe(triageButtonBlock());
  });
});

describe('triageBaseYaml', () => {
  it('contains the braindump-triage tag filter', () => {
    expect(triageBaseYaml()).toContain('braindump-triage');
  });

  it('contains the routed != true filter', () => {
    expect(triageBaseYaml()).toContain("routed != true");
  });

  it('contains the table view definition', () => {
    expect(triageBaseYaml()).toContain('type: table');
    expect(triageBaseYaml()).toContain('name: Triage — all un-routed items');
  });

  it('is deterministic', () => {
    expect(triageBaseYaml()).toBe(triageBaseYaml());
  });
});

describe('todayIso', () => {
  it('returns a YYYY-MM-DD string', () => {
    const date = todayIso();
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns a parseable date', () => {
    const date = todayIso();
    const parsed = new Date(date);
    expect(parsed.getTime()).toBeGreaterThan(0);
    expect(parsed.getUTCFullYear()).toBe(new Date().getUTCFullYear());
  });
});

describe('findRawFilePath', () => {
  it('returns the first path (no suffix) when raw/ is empty or missing', () => {
    const date = '2026-07-20';
    const result = findRawFilePath(date);
    expect(result.path).toBe(`raw/${date}-braindump-original.md`);
    expect(result.suffix).toBe(1);
  });

  it('returns a different path for a different date', () => {
    const result1 = findRawFilePath('2026-07-20');
    const result2 = findRawFilePath('2026-07-21');
    expect(result1.path).not.toBe(result2.path);
  });

  it('always returns .md extension', () => {
    const result = findRawFilePath('2026-01-01');
    expect(result.path.endsWith('.md')).toBe(true);
  });

  it('always starts with raw/', () => {
    const result = findRawFilePath('2026-12-25');
    expect(result.path.startsWith('raw/')).toBe(true);
  });
});
