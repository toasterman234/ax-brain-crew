import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, utimesSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AxMockAIService } from '@ax-llm/ax';
import { setVaultRoot } from '../src/tools/vault-path.js';

// Mock the model client so planMaintenance uses a scripted mock AI instead of
// the commandcode proxy. Count calls to verify the LLM node ran and that it's
// skipped when there's nothing to plan for.
let planCalls = 0;
vi.mock('../src/ai/clients.js', () => ({
  createModelClient: () => {
    const svc = new AxMockAIService({
      features: { functions: true, streaming: false },
      chatResponse: {
        results: [
          {
            index: 0,
            content:
              'Inbox Plan: [{"path":"Inbox/receipt.md","destination":"Finance/receipt.md","reason":"clearly a finance capture"}]\n' +
              'Orphan Link Plan: [{"path":"Knowledge/orphan.md","linkTarget":null,"reason":"no related note found"}]\n' +
              'Maintenance Summary: Filed one inbox note, flagged one orphan.',
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
      planCalls++;
      return realChat(...(args as []));
    };
    return svc;
  },
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_VAULT = resolve(__dirname, 'fixtures', 'defrag-flow-vault');

function reportFiles(): string[] {
  const dir = join(TEST_VAULT, 'Meta', 'health-reports');
  return existsSync(dir) ? readdirSync(dir) : [];
}

beforeEach(() => {
  planCalls = 0;
  rmSync(TEST_VAULT, { recursive: true, force: true });
  mkdirSync(join(TEST_VAULT, 'Meta', 'health-reports'), { recursive: true });
  mkdirSync(join(TEST_VAULT, 'Inbox'), { recursive: true });
  mkdirSync(join(TEST_VAULT, 'Knowledge'), { recursive: true });
  mkdirSync(join(TEST_VAULT, 'Finance'), { recursive: true });
  mkdirSync(join(TEST_VAULT, 'Daily'), { recursive: true });
  writeFileSync(
    join(TEST_VAULT, 'Inbox', 'receipt.md'),
    '---\ndate: 2026-07-20\ntype: note\ntags: []\nai-first: true\n---\n\nA receipt to file.\n',
  );
  const orphanPath = join(TEST_VAULT, 'Knowledge', 'orphan.md');
  writeFileSync(
    orphanPath,
    '---\ndate: 2020-01-01\ntype: note\ntags: []\nai-first: true\n---\n\nNo links here.\n',
  );
  // Backdate the orphan so scanVault's staleness check (90+ days) flags it.
  const oldTime = new Date('2020-01-01').getTime() / 1000;
  utimesSync(orphanPath, oldTime, oldTime);
  // Daily/ is protected — never touched even if listed.
  writeFileSync(
    join(TEST_VAULT, 'Daily', '2026-07-20.md'),
    '---\ndate: 2026-07-20\ntype: daily\ntags: []\nai-first: true\n---\n\ndaily log\n',
  );
  setVaultRoot(TEST_VAULT);
});

afterEach(() => {
  rmSync(TEST_VAULT, { recursive: true, force: true });
});

describe('defrag flow', () => {
  it('runs in dry-run without writing anything to the vault', async () => {
    const { runDefragFlow } = await import('../src/flows/defrag.js');

    const beforeReports = reportFiles();
    const inboxExistedBefore = existsSync(join(TEST_VAULT, 'Inbox', 'receipt.md'));

    const { output, finalResponse } = await runDefragFlow({
      request: 'defrag my vault',
      dryRun: true,
    });

    expect(reportFiles()).toEqual(beforeReports);
    expect(output.reportWritten).toBe(false);
    // Dry-run: nothing actually moved.
    expect(existsSync(join(TEST_VAULT, 'Inbox', 'receipt.md'))).toBe(inboxExistedBefore);
    expect(finalResponse).toMatch(/reply "proceed"/i);
  });

  it('plans inbox filing and orphan handling via the LLM node', async () => {
    const { runDefragFlow } = await import('../src/flows/defrag.js');

    const { output } = await runDefragFlow({ request: 'defrag my vault', dryRun: true });

    expect(planCalls).toBeGreaterThan(0);
    expect(output.staleFlagged).toBeGreaterThan(0);
  });

  it('never touches Daily/ even in a real (non-dry-run) apply', async () => {
    const { runDefragFlow } = await import('../src/flows/defrag.js');

    const before = readFileSync(join(TEST_VAULT, 'Daily', '2026-07-20.md'), 'utf-8');
    await runDefragFlow({ request: 'defrag my vault', dryRun: false });
    const after = readFileSync(join(TEST_VAULT, 'Daily', '2026-07-20.md'), 'utf-8');

    expect(after).toBe(before);
  });

  it('proceed path: moves the inbox note per the LLM plan and writes a report', async () => {
    const { runDefragFlow } = await import('../src/flows/defrag.js');

    const { output } = await runDefragFlow({ request: 'defrag my vault', dryRun: false });

    expect(existsSync(join(TEST_VAULT, 'Inbox', 'receipt.md'))).toBe(false);
    expect(existsSync(join(TEST_VAULT, 'Finance', 'receipt.md'))).toBe(true);
    expect(output.reportWritten).toBe(true);
    expect(reportFiles().some((f) => f.startsWith('defrag-'))).toBe(true);
  });
});
