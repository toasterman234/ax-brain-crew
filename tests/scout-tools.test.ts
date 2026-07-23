import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setScoutAllowedPaths, sysLs, sysWalk, isPathAllowed } from '../src/tools/fs-explore.js';

describe('Scout fs-explore', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'ax-brain-crew-scout-test-'));
    setScoutAllowedPaths([tempDir]);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('sysLs', () => {
    it('lists files and directories', () => {
      mkdirSync(resolve(tempDir, 'apps'), { recursive: true });
      writeFileSync(resolve(tempDir, 'README.md'), '# Test');
      writeFileSync(resolve(tempDir, 'package.json'), '{}');

      const result = sysLs({ path: tempDir });

      expect(result.path).toBe(tempDir);
      expect(result.items.some((i) => i.name === 'apps' && i.type === 'directory')).toBe(true);
      expect(result.items.some((i) => i.name === 'package.json' && i.type === 'file')).toBe(true);
      expect(result.items.some((i) => i.name === 'README.md' && i.type === 'file')).toBe(true);

      const appsDir = result.items.find((i) => i.name === 'apps');
      expect(appsDir?.isProject).toBe(false);
    });

    it('detects project directories by indicators', () => {
      const projDir = resolve(tempDir, 'my-project');
      mkdirSync(projDir, { recursive: true });
      writeFileSync(resolve(projDir, 'package.json'), '{}');
      writeFileSync(resolve(projDir, 'tsconfig.json'), '{}');
      mkdirSync(resolve(projDir, '.git'), { recursive: true });

      const result = sysLs({ path: tempDir });

      const proj = result.items.find((i) => i.name === 'my-project');
      expect(proj?.isProject).toBe(true);
    });

    it('throws for disallowed paths', () => {
      expect(() => sysLs({ path: '/etc' })).toThrow(/not in the Scout allowed paths/);
    });

    it('lists directories before files', () => {
      mkdirSync(resolve(tempDir, 'zzz-last'), { recursive: true });

      const result = sysLs({ path: tempDir });

      const dirIndex = result.items.findIndex((i) => i.type === 'directory');
      const fileIndex = result.items.findIndex((i) => i.type === 'file');
      expect(dirIndex).toBeLessThan(fileIndex);
    });
  });

  describe('sysWalk', () => {
    it('discovers projects at multiple depths', () => {
      const deep = resolve(tempDir, 'deep', 'nest', 'project');
      mkdirSync(deep, { recursive: true });
      writeFileSync(resolve(deep, 'package.json'), '{}');

      const result = sysWalk({ path: tempDir, maxDepth: 3 });

      expect(result.projects.length).toBeGreaterThanOrEqual(1);
      expect(result.projects.some((p) => p.path === deep)).toBe(true);
      expect(result.maxDepthReached).toBe(false);
    });

    it('respects maxDepth', () => {
      const result = sysWalk({ path: tempDir, maxDepth: 1 });

      expect(result.maxDepthReached).toBe(true);
    });

    it('caps maxDepth at 5', () => {
      const result = sysWalk({ path: tempDir, maxDepth: 10 });

      expect(result.maxDepthReached).toBe(false);
    });

    it('throws for disallowed paths', () => {
      expect(() => sysWalk({ path: '/tmp/not-allowed' })).toThrow(/not in the Scout allowed paths/);
    });
  });

  describe('isPathAllowed', () => {
    it('allows configured paths and their descendants', () => {
      expect(isPathAllowed(tempDir)).toBe(true);
      expect(isPathAllowed(resolve(tempDir, 'subdir'))).toBe(true);
    });

    it('rejects paths outside configured roots', () => {
      expect(isPathAllowed('/etc')).toBe(false);
      expect(isPathAllowed('/var/log')).toBe(false);
    });
  });
});
