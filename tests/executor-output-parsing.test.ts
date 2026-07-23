import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseJsonArrayField,
  looksLikeRawFileEcho,
} from '../src/runtime/executor.js';
import { looksLikeToolResultEcho } from '../src/tools/vault-tool-echo-guard.js';

describe('parseJsonArrayField', () => {
  it('parses a valid JSON array', () => {
    const warnings: string[] = [];
    const result = parseJsonArrayField(
      '[{"path":"a.md","relevance":"high"}]',
      warnings,
      'evidenceItems',
    );
    expect(result).toEqual([{ path: 'a.md', relevance: 'high' }]);
    expect(warnings).toEqual([]);
  });

  it('degrades to [] with a warning on malformed JSON (incident-008 repro)', () => {
    // The exact failure class from incident-008: a truncated/malformed token
    // in a field ax used to treat as a "complex field" and fail the whole run
    // on. Now it's a plain string we parse defensively.
    const warnings: string[] = [];
    const result = parseJsonArrayField(
      '[{"path":"a.md","relevance":-}]',
      warnings,
      'evidenceItems',
    );
    expect(result).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('evidenceItems');
  });

  it('treats missing/empty input as an empty array with no warning', () => {
    const warnings: string[] = [];
    expect(parseJsonArrayField(undefined, warnings, 'changedFiles')).toEqual([]);
    expect(parseJsonArrayField('', warnings, 'changedFiles')).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('treats a non-array JSON value as empty', () => {
    const warnings: string[] = [];
    const result = parseJsonArrayField('{"not":"an array"}', warnings, 'evidenceItems');
    expect(result).toEqual([]);
  });
});

describe('looksLikeRawFileEcho', () => {
  it('flags a response that is really vault frontmatter (incident-008 repro)', () => {
    const echoed =
      '---\ndate: 2026-07-19\ntype: reference\ntags:\n  - system\nai-first: true\n---\n\n# Incident Workflow\n';
    expect(looksLikeRawFileEcho(echoed)).toBe(true);
  });

  it('does not flag a normal prose response', () => {
    expect(looksLikeRawFileEcho('Verdict: NEW\nSeverity: medium\n')).toBe(false);
  });

  it('does not flag a response that merely quotes a snippet with one house key', () => {
    expect(
      looksLikeRawFileEcho('The note starts with:\n---\ndate: 2026-07-19\n---\n'),
    ).toBe(false);
  });
});

// Regression lock for incident-008 Failure 2: the investigator returned the raw
// contents of vault/Meta/incident-workflow.md as its response, and the executor
// marked the run `completed`. The gate must catch the ACTUAL file that was
// echoed — not just a synthetic stand-in — so that editing that file's
// frontmatter can't silently defeat the gate and let this regress.
describe('output-quality gate — real incident-008 payload', () => {
  const incidentWorkflow = fileURLToPath(
    new URL('../vault/Meta/incident-workflow.md', import.meta.url),
  );

  it('flags the real incident-workflow.md contents (the file that was echoed)', () => {
    const echoed = readFileSync(incidentWorkflow, 'utf8');
    expect(looksLikeRawFileEcho(echoed)).toBe(true);
  });
});

// The write-time guard (incident-008/009 follow-up) had no test. It stops an
// agent from writing the raw {path, content, modifiedAt, size} result of a
// vault.read straight back into a note.
describe('looksLikeToolResultEcho — write-time guard', () => {
  it('flags a raw VaultReadOutput object passed as note content', () => {
    const echoed = JSON.stringify({
      path: 'Templates/incident-report.md',
      content: '# Incident Report\n...',
      modifiedAt: '2026-07-23T00:00:00.000Z',
      size: 4096,
    });
    expect(looksLikeToolResultEcho(echoed)).toBe(true);
  });

  it('does not flag real synthesized note markdown', () => {
    expect(
      looksLikeToolResultEcho('# Incident 011\n\nVerdict: NEW\nSeverity: medium\n'),
    ).toBe(false);
  });

  it('does not flag a JSON object that lacks the full read-result shape', () => {
    expect(looksLikeToolResultEcho('{"path":"a.md","content":"x"}')).toBe(false);
  });

  it('does not flag non-JSON content that merely starts with a brace', () => {
    expect(looksLikeToolResultEcho('{ this is not json, just prose }')).toBe(false);
  });
});
