import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = resolve(PROJECT_ROOT, 'scripts/generate-docs.ts');
const REFERENCES_DIR = resolve(PROJECT_ROOT, 'crew/references');
const VAULT_AGENTS_MD = resolve(PROJECT_ROOT, 'vault/AGENTS.md');

const GENERATED_FILES = [
  'agents.md',
  'agents-registry.md',
  'agent-orchestration.md',
  'skills.md',
];

describe('doc-registry sync', () => {
  it('generated reference docs match on-disk docs', () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'ax-brain-crew-docs-test-'));

    try {
      execSync(`npx tsx ${SCRIPT} ${tempDir}`, {
        cwd: PROJECT_ROOT,
        stdio: 'pipe',
      });

      for (const filename of GENERATED_FILES) {
        const diskPath = resolve(REFERENCES_DIR, filename);
        const generatedPath = resolve(tempDir, filename);

        expect(existsSync(diskPath), `${filename} exists on disk`).toBe(true);
        expect(existsSync(generatedPath), `${filename} was generated`).toBe(true);

        const diskContent = readFileSync(diskPath, 'utf-8');
        const generatedContent = readFileSync(generatedPath, 'utf-8');

        expect(
          generatedContent,
          `${filename} matches generated output. Run 'npm run docs' to sync.`,
        ).toBe(diskContent);
      }

      // Check vault/AGENTS.md was updated in real run — only when not using temp dir
      // (temp dir means we wrote to temp, not real vault/AGENTS.md, so regenerate for real)
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('vault/AGENTS.md routing section is managed by generated content', () => {
    const content = readFileSync(VAULT_AGENTS_MD, 'utf-8');

    // After running npm run docs (which this suite assumes), the routing section
    // should now be wrapped in sentinel markers.
    expect(content).toContain('<!-- AX_CREW:ROUTING_START -->');
    expect(content).toContain('<!-- AX_CREW:ROUTING_END -->');

    // It should include all 6 agents, not just the stale 3
    for (const name of ['Scribe', 'Seeker', 'Sorter', 'Architect', 'Connector', 'Librarian']) {
      expect(content).toContain(name);
    }
  });
});
