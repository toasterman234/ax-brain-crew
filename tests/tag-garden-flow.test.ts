import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AxMockAIService } from '@ax-llm/ax';
import { setVaultRoot } from '../src/tools/vault-path.js';

// Mock the model client so the proposeRenames ax() node uses a scripted mock
// AI instead of the commandcode proxy. Count calls to verify the LLM node
// only runs when there's a near-duplicate group to reason about.
let proposeCalls = 0;
vi.mock('../src/ai/clients.js', () => ({
  createModelClient: () => {
    const svc = new AxMockAIService({
      features: { functions: true, streaming: false },
      chatResponse: {
        results: [
          {
            index: 0,
            content:
              'Rename Plan: [{"fromTags":["AI","ai"],"toTag":"ai","reason":"case near-duplicate"}]\n' +
              'Canonicalization Summary: Merging AI/ai into a single canonical "ai" tag.',
            finishReason: 'stop',
          },
        ],
        modelUsage: {
          ai: 'mock',
          model: 'mock',
          tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
      },
    }) as any;
    const realChat = svc.chat.bind(svc);
    svc.chat = (...args: unknown[]) => {
      proposeCalls++;
      return realChat(...(args as []));
    };
    return svc;
  },
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_VAULT = resolve(__dirname, 'fixtures', 'tag-garden-flow-vault');

function reportFiles(): string[] {
  const dir = join(TEST_VAULT, 'Meta', 'health-reports');
  return existsSync(dir) ? readdirSync(dir) : [];
}

beforeEach(() => {
  proposeCalls = 0;
  rmSync(TEST_VAULT, { recursive: true, force: true });
  mkdirSync(join(TEST_VAULT, 'Meta', 'health-reports'), { recursive: true });
  mkdirSync(join(TEST_VAULT, 'Knowledge'), { recursive: true });
  writeFileSync(
    join(TEST_VAULT, 'Knowledge', 'a.md'),
    '---\ndate: 2026-07-20\ntype: note\ntags:\n  - AI\nai-first: true\n---\n\nnote a\n',
  );
  writeFileSync(
    join(TEST_VAULT, 'Knowledge', 'b.md'),
    '---\ndate: 2026-07-20\ntype: note\ntags:\n  - ai\nai-first: true\n---\n\nnote b\n',
  );
  setVaultRoot(TEST_VAULT);
});

afterEach(() => {
  rmSync(TEST_VAULT, { recursive: true, force: true });
});

describe('tag-garden flow', () => {
  it('runs in dry-run without writing anything to the vault', async () => {
    const { runTagGardenFlow } = await import('../src/flows/tag-garden.js');

    const beforeReports = reportFiles();
    const beforeA = readFileSync(join(TEST_VAULT, 'Knowledge', 'a.md'), 'utf-8');

    const { output, finalResponse } = await runTagGardenFlow({
      request: 'clean up my tags',
      dryRun: true,
    });

    expect(reportFiles()).toEqual(beforeReports);
    expect(output.reportWritten).toBe(false);
    expect(readFileSync(join(TEST_VAULT, 'Knowledge', 'a.md'), 'utf-8')).toBe(beforeA);
    expect(finalResponse).toMatch(/reply "proceed"/i);
  });

  it('detects the AI/ai near-duplicate and proposes a canonical merge via the LLM', async () => {
    const { runTagGardenFlow } = await import('../src/flows/tag-garden.js');

    const { output } = await runTagGardenFlow({
      request: 'clean up my tags',
      dryRun: true,
    });

    expect(output.nearDuplicateGroupCount).toBeGreaterThan(0);
    expect(proposeCalls).toBeGreaterThan(0);
    expect(output.proposedRenames.length).toBeGreaterThan(0);
  });

  it('skips the LLM node when there are no near-duplicate groups', async () => {
    rmSync(TEST_VAULT, { recursive: true, force: true });
    mkdirSync(join(TEST_VAULT, 'Meta', 'health-reports'), { recursive: true });
    mkdirSync(join(TEST_VAULT, 'Knowledge'), { recursive: true });
    writeFileSync(
      join(TEST_VAULT, 'Knowledge', 'solo.md'),
      '---\ndate: 2026-07-20\ntype: note\ntags:\n  - unique-topic\nai-first: true\n---\n\nnote\n',
    );
    setVaultRoot(TEST_VAULT);

    const { runTagGardenFlow } = await import('../src/flows/tag-garden.js');
    const { output } = await runTagGardenFlow({ request: 'clean up my tags', dryRun: true });

    expect(output.nearDuplicateGroupCount).toBe(0);
    expect(proposeCalls).toBe(0);
    expect(output.proposedRenames).toEqual([]);
  });

  it('proceed path: applies the canonical rename to frontmatter on both notes', async () => {
    const { runTagGardenFlow } = await import('../src/flows/tag-garden.js');

    const { output } = await runTagGardenFlow({
      request: 'clean up my tags',
      dryRun: false,
    });

    const a = readFileSync(join(TEST_VAULT, 'Knowledge', 'a.md'), 'utf-8');
    const b = readFileSync(join(TEST_VAULT, 'Knowledge', 'b.md'), 'utf-8');
    expect(a).toMatch(/tags:\s*\n\s*-\s*ai\b/);
    expect(b).toMatch(/tags:\s*\n\s*-\s*ai\b/);
    expect(a).not.toMatch(/-\s*AI\b/);
    expect(output.reportWritten).toBe(true);
    expect(output.notesUpdated).toBeGreaterThan(0);
    expect(reportFiles().some((f) => f.startsWith('tag-garden-'))).toBe(true);
  });
});
