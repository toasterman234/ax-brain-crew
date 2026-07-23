import { describe, it, expect, beforeAll } from 'vitest';
import { setVaultRoot, resolveVaultPath, VaultPathError } from '../src/tools/vault-path.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_VAULT = resolve(__dirname, 'fixtures', 'test-vault');

beforeAll(() => {
  rmSync(TEST_VAULT, { recursive: true, force: true });
  mkdirSync(TEST_VAULT, { recursive: true });
  mkdirSync(join(TEST_VAULT, 'subdir'), { recursive: true });
  mkdirSync(join(TEST_VAULT, 'Inbox'), { recursive: true });
  writeFileSync(join(TEST_VAULT, 'test-note.md'), '---\ndate: 2026-07-19\ntype: note\n---\n\n# Test Note\n\nContent here.');
  writeFileSync(join(TEST_VAULT, 'subdir', 'nested.md'), '---\ndate: 2026-07-19\ntype: note\n---\n\n# Nested Note');
  setVaultRoot(TEST_VAULT);
});

describe('resolveVaultPath', () => {
  it('resolves a normal path', () => {
    const result = resolveVaultPath('test-note.md');
    expect(result.vaultRelativePath).toBe('test-note.md');
    expect(result.absolutePath).toContain('test-vault');
  });

  it('resolves a nested path', () => {
    const result = resolveVaultPath('subdir/nested.md');
    expect(result.vaultRelativePath).toBe('subdir/nested.md');
  });

  it('rejects .. traversal', () => {
    expect(() => resolveVaultPath('../secret.txt')).toThrow(VaultPathError);
  });

  it('rejects double-dot traversal', () => {
    expect(() => resolveVaultPath('subdir/../../../etc/passwd')).toThrow(VaultPathError);
  });

  it('rejects absolute path starting with /', () => {
    expect(() => resolveVaultPath('/etc/passwd')).toThrow(VaultPathError);
  });

  it('resolves a new file path that does not exist yet', () => {
    const result = resolveVaultPath('Inbox/new-note.md');
    expect(result.vaultRelativePath).toBe('Inbox/new-note.md');
  });

  it('resolves empty string to current dir', () => {
    const result = resolveVaultPath('');
    expect(result.vaultRelativePath).toBe('.');
  });
});
