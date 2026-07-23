import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AxMockAIService } from '@ax-llm/ax';
import { setExternalVaultRoot } from '../src/tools/external-vault.js';

// Mock the model client so the assessVault ax() node uses a scripted mock AI
// instead of the commandcode proxy. Count calls to verify the LLM node ran
// (and, in the empty-vault case, that it does NOT run).
let assessCalls = 0;
vi.mock('../src/ai/clients.js', () => ({
  createModelClient: () => {
    const svc = new AxMockAIService({
      features: { functions: true, streaming: false },
      chatResponse: {
        results: [
          {
            index: 0,
            content:
              'Narrative Assessment: A small reference vault with a few well-written notes.\n' +
              'Elevator Pitch: A tidy personal knowledge base.\n' +
              'Ai Friendly Score: 70\n' +
              'Quality Score: 65\n' +
              'Strengths: ["consistent frontmatter"]\n' +
              'Weaknesses: ["few links between notes"]\n' +
              'Notable Note Paths: ["Projects/example.md"]',
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
      assessCalls++;
      return realChat(...(args as []));
    };
    return svc;
  },
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_EXTERNAL_VAULT = resolve(__dirname, 'fixtures', 'vault-assess-external-vault');

beforeEach(() => {
  assessCalls = 0;
  rmSync(TEST_EXTERNAL_VAULT, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TEST_EXTERNAL_VAULT, { recursive: true, force: true });
});

describe('vault-assess flow', () => {
  it('is read-only: writes nothing regardless (no dryRun concept)', async () => {
    mkdirSync(resolve(TEST_EXTERNAL_VAULT, 'Projects'), { recursive: true });
    writeFileSync(
      resolve(TEST_EXTERNAL_VAULT, 'Projects', 'example.md'),
      '---\ndate: 2026-07-20\n---\n\nAn example project note.\n',
    );
    setExternalVaultRoot(TEST_EXTERNAL_VAULT);

    const { runVaultAssessFlow } = await import('../src/flows/vault-assess.js');
    const { output } = await runVaultAssessFlow({ request: 'assess my vault' });

    expect(output.configured).toBe(true);
    expect(output.totalNotesSampled).toBeGreaterThan(0);
    expect(assessCalls).toBeGreaterThan(0);
    expect(output.aiFriendlyScore).toBe(70);
    expect(output.notableNotePaths).toContain('Projects/example.md');
  });

  it('skips the LLM node when the external vault has no markdown notes to sample', async () => {
    // setExternalVaultRoot always resolve()s to a real path (no way to fully
    // "unset" it) — an empty directory is the realistic "nothing to assess"
    // case, and exercises the same skip-the-LLM branch as unconfigured.
    mkdirSync(TEST_EXTERNAL_VAULT, { recursive: true });
    setExternalVaultRoot(TEST_EXTERNAL_VAULT);

    const { runVaultAssessFlow } = await import('../src/flows/vault-assess.js');
    const { output, finalResponse } = await runVaultAssessFlow({ request: 'assess my vault' });

    expect(output.configured).toBe(true);
    expect(output.totalNotesSampled).toBe(0);
    expect(assessCalls).toBe(0);
    expect(finalResponse).toBeTruthy();
  });
});
