import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isVaultInitialized, KNOWN_VAULT_FOLDERS } from '../src/onboarding/state.js';

describe('isVaultInitialized (onboarding guard)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'ax-brain-crew-guard-test-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns false when AGENTS.md does not exist', () => {
    expect(isVaultInitialized(tempDir)).toBe(false);
  });

  it('returns false when AGENTS.md exists but no known vault folders', () => {
    const dir = resolve(tempDir, 'empty');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'AGENTS.md'), '# Test Vault');

    expect(isVaultInitialized(dir)).toBe(false);
  });

  it('returns false when vault folders exist but no AGENTS.md', () => {
    const dir = resolve(tempDir, 'folders-no-agents');
    mkdirSync(resolve(dir, 'Inbox'), { recursive: true });
    mkdirSync(resolve(dir, 'Projects'), { recursive: true });

    expect(isVaultInitialized(dir)).toBe(false);
  });

  it('returns true when AGENTS.md and at least one known folder exist', () => {
    const dir = resolve(tempDir, 'initialized');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'AGENTS.md'), '# Ax Brain Crew — Vault Guide');
    mkdirSync(resolve(dir, 'Inbox'), { recursive: true });
    mkdirSync(resolve(dir, 'Projects'), { recursive: true });

    expect(isVaultInitialized(dir)).toBe(true);
  });

  it('returns true when AGENTS.md and Meta folder exist', () => {
    const dir = resolve(tempDir, 'meta-only');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'AGENTS.md'), '# Vault');
    mkdirSync(resolve(dir, 'Meta'), { recursive: true });

    expect(isVaultInitialized(dir)).toBe(true);
  });

  it('returns true for the actual ax-brain-crew vault', () => {
    // This test verifies the guard works against the real vault
    const vaultPath = resolve(import.meta.dirname, '..', 'vault');

    const result = isVaultInitialized(vaultPath);
    expect(result).toBe(true);
  });

  it('KNOWN_VAULT_FOLDERS covers the core folder names', () => {
    const known = KNOWN_VAULT_FOLDERS as readonly string[];
    expect(known).toContain('Inbox');
    expect(known).toContain('Projects');
    expect(known).toContain('Areas');
    expect(known).toContain('Knowledge');
    expect(known).toContain('Meta');
  });
});
