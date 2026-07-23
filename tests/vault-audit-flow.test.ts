import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AxMockAIService } from '@ax-llm/ax';
import { setVaultRoot } from '../src/tools/vault-path.js';

// Mock the model client so the summarizeObservations ax() node uses a
// scripted mock AI instead of the commandcode proxy. Count calls to the
// mock's own `.chat()` to verify the LLM node actually ran.
let observationCalls = 0;
vi.mock('../src/ai/clients.js', () => ({
  createModelClient: () => {
    const svc = new AxMockAIService({
      features: { functions: true, streaming: false },
      chatResponse: {
        results: [
          {
            index: 0,
            content:
              'Folder And Tag Observations: Notes appear to live in folders matching their type; no obvious near-duplicate tags observed from the scan text alone.',
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
      observationCalls++;
      return realChat(...(args as []));
    };
    return svc;
  },
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_VAULT = resolve(__dirname, 'fixtures', 'vault-audit-flow-vault');

function reportFiles(): string[] {
  const dir = join(TEST_VAULT, 'Meta', 'health-reports');
  return existsSync(dir) ? readdirSync(dir) : [];
}

beforeEach(() => {
  observationCalls = 0;
  rmSync(TEST_VAULT, { recursive: true, force: true });
  mkdirSync(join(TEST_VAULT, 'Meta', 'health-reports'), { recursive: true });
  mkdirSync(join(TEST_VAULT, 'Inbox'), { recursive: true });
  writeFileSync(
    join(TEST_VAULT, 'Inbox', 'no-frontmatter.md'),
    '# A note with no frontmatter\n\nbody text\n',
  );
  setVaultRoot(TEST_VAULT);
});

afterEach(() => {
  rmSync(TEST_VAULT, { recursive: true, force: true });
});

describe('vault-audit flow', () => {
  it('runs in dry-run without writing anything to the vault', async () => {
    const { runVaultAuditFlow } = await import('../src/flows/vault-audit.js');

    const before = reportFiles();
    const { output, finalResponse } = await runVaultAuditFlow({
      request: 'audit my vault',
      dryRun: true,
    });

    expect(reportFiles()).toEqual(before);
    expect(output.reportWritten).toBe(false);
    expect(finalResponse).toMatch(/reply "proceed"/i);
  });

  it('runs the deterministic scan and the LLM observation node', async () => {
    const { runVaultAuditFlow } = await import('../src/flows/vault-audit.js');

    const { output } = await runVaultAuditFlow({
      request: 'audit my vault',
      dryRun: true,
    });

    expect(output.totalNotes).toBe(1);
    expect(output.issueCount).toBeGreaterThan(0);
    expect(observationCalls).toBeGreaterThan(0);
    expect(output.folderAndTagObservations.length).toBeGreaterThan(0);
  });

  it('proceed path: writes a real vault-audit report', async () => {
    const { runVaultAuditFlow } = await import('../src/flows/vault-audit.js');

    const { output } = await runVaultAuditFlow({
      request: 'audit my vault',
      dryRun: false,
    });

    expect(output.reportWritten).toBe(true);
    expect(reportFiles().some((f) => f.startsWith('vault-audit-'))).toBe(true);
  });
});
