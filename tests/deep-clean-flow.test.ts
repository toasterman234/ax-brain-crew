import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AxMockAIService } from '@ax-llm/ax';
import { setVaultRoot } from '../src/tools/vault-path.js';

// Mock the model client so the classifier ax() node (used ONLY when a
// pre-existing, non-scan-format audit report is found) uses a scripted mock AI
// instead of the commandcode proxy. The chatResponse emits the classifier's
// output fields in ax's field-markdown format. createModelClient() itself is
// called once per flow run regardless of branch (it builds the flow's `llm`
// argument) — so to detect whether the LLM was ACTUALLY invoked, count calls
// to the mock's own `.chat()`, not client construction.
let classifierCalls = 0;
vi.mock('../src/ai/clients.js', () => ({
  createModelClient: () => {
    const svc = new AxMockAIService({
      features: { functions: true, streaming: false },
      chatResponse: {
        results: [
          {
            index: 0,
            content:
              'Fixes: [{"type":"frontmatter","path":"Inbox/stale-note.md","fields":{"status":"archived"},"issue":"missing status"},{"type":"fix_link","path":"Knowledge/broken-links.md","brokenLink":"Missing Note","issue":"broken link"}]\n' +
              'Cleanup Summary: Two notes need attention: one stale, one with broken links.',
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
      classifierCalls++;
      return realChat(...(args as []));
    };
    return svc;
  },
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_VAULT = resolve(__dirname, 'fixtures', 'deep-clean-flow-vault');

function reportFiles(): string[] {
  const dir = join(TEST_VAULT, 'Meta', 'health-reports');
  return existsSync(dir) ? readdirSync(dir) : [];
}

beforeEach(() => {
  classifierCalls = 0;
  rmSync(TEST_VAULT, { recursive: true, force: true });
  mkdirSync(join(TEST_VAULT, 'Meta', 'health-reports'), { recursive: true });
  mkdirSync(join(TEST_VAULT, 'Inbox'), { recursive: true });
  mkdirSync(join(TEST_VAULT, 'Knowledge'), { recursive: true });
  // A note with a real mechanical issue (missing frontmatter) so the
  // deterministic scan has something to find on the no-prior-report path.
  writeFileSync(
    join(TEST_VAULT, 'Inbox', 'no-frontmatter.md'),
    '# A note with no frontmatter at all\n\nbody text\n',
  );
  setVaultRoot(TEST_VAULT);
});

afterEach(() => {
  rmSync(TEST_VAULT, { recursive: true, force: true });
});

describe('deep-clean flow', () => {
  it('runs in dry-run without writing anything to the vault', async () => {
    const { runDeepCleanFlow } = await import('../src/flows/deep-clean.js');

    const before = reportFiles();
    const { output, finalResponse } = await runDeepCleanFlow({
      request: 'deep clean my vault',
      dryRun: true,
    });

    // No new files written in dry-run (report dir unchanged — dry_run preview only).
    expect(reportFiles()).toEqual(before);
    expect(output.reportWritten).toBe(false);

    // No prior report → deterministic scan runs, no LLM classifier involved.
    expect(classifierCalls).toBe(0);

    // The scan's structured fixes flowed through into notesToFix.
    expect(output.notesToFix.length).toBeGreaterThan(0);

    // Plan surfaces the approval directive.
    expect(finalResponse).toMatch(/reply "proceed"/i);
  });

  it('self-sufficiency: runs a deterministic scan (no LLM) when no report exists', async () => {
    const { runDeepCleanFlow } = await import('../src/flows/deep-clean.js');

    // Report dir is empty (no vault-audit-*.md) — the exact gap that broke
    // "deep clean my vault", and the timeout that followed once an inline LLM
    // audit was tried instead.
    expect(reportFiles()).toEqual([]);

    const { output } = await runDeepCleanFlow({
      request: 'deep clean my vault',
      dryRun: true,
    });

    expect(output.ranAuditInline).toBe(true);
    // No LLM anywhere on this path — scan + deterministic apply only.
    expect(classifierCalls).toBe(0);
    expect(output.warnings.some((w) => /deterministic scan/i.test(w))).toBe(true);
    // The scan found the seeded missing-frontmatter note.
    expect(output.notesToFix.some((n) => n.includes('no-frontmatter.md'))).toBe(true);
    // A vault-audit report was written (preview, since dryRun) for next time.
    expect(output.auditReportPath).toMatch(/vault-audit-.*\.md$/);
  });

  it('skips the scan and uses the LLM classifier when a pre-existing report already exists', async () => {
    // Seed an existing, free-form (non-scan-format) audit report.
    writeFileSync(
      join(TEST_VAULT, 'Meta', 'health-reports', 'vault-audit-2026-07-19.md'),
      '# Vault Audit\n\nSome findings written by a human or the LLM-driven vault-audit skill.',
    );

    const { runDeepCleanFlow } = await import('../src/flows/deep-clean.js');
    const { output } = await runDeepCleanFlow({
      request: 'deep clean my vault',
      dryRun: true,
    });

    expect(output.ranAuditInline).toBe(false);
    expect(output.auditReportPath).toContain('vault-audit-2026-07-19.md');
    // Pre-existing free-form report → the LLM classifier interprets it.
    expect(classifierCalls).toBeGreaterThan(0);
    expect(output.notesToFix.length).toBeGreaterThan(0);
  });

  it('proceed path: CREATES a frontmatter block on a note with none at all', async () => {
    // vault.updateFrontmatter only updates an EXISTING block and errors on a
    // note with none — the exact bug the live shakeout caught (2026-07-20).
    // The self-sufficiency scan path targets this note directly.
    const { runDeepCleanFlow } = await import('../src/flows/deep-clean.js');
    const { output } = await runDeepCleanFlow({
      request: 'deep clean my vault',
      dryRun: false,
    });

    const noteAfter = readFileSync(
      join(TEST_VAULT, 'Inbox', 'no-frontmatter.md'),
      'utf-8',
    );
    expect(noteAfter).toMatch(/^---\n/);
    expect(noteAfter).toMatch(/ai-first:\s*true/);
    expect(noteAfter).toContain('# A note with no frontmatter at all');
    expect(output.reportWritten).toBe(true);
  });

  it('proceed path: applies a real frontmatter fix when dryRun is false', async () => {
    // Seed an audit report (skip the scan, use the classifier path) and the
    // note the mocked classifier targets.
    writeFileSync(
      join(TEST_VAULT, 'Meta', 'health-reports', 'vault-audit-2026-07-19.md'),
      '# Vault Audit\n\nInbox/stale-note.md is missing status frontmatter.',
    );
    writeFileSync(
      join(TEST_VAULT, 'Inbox', 'stale-note.md'),
      '---\ntitle: Stale\n---\n\nbody\n',
    );

    const { runDeepCleanFlow } = await import('../src/flows/deep-clean.js');
    const { output } = await runDeepCleanFlow({
      request: 'deep clean my vault',
      dryRun: false, // real apply
    });

    // The deterministic apply actually wrote: the note now has status: archived,
    // and the cleanup report file exists.
    const noteAfter = readFileSync(
      join(TEST_VAULT, 'Inbox', 'stale-note.md'),
      'utf-8',
    );
    expect(noteAfter).toMatch(/status:\s*archived/);
    expect(output.reportWritten).toBe(true);
    expect(reportFiles().some((f) => f.startsWith('deep-clean-'))).toBe(true);
  });
});
