import { describe, expect, it } from 'vitest';
import { applyAdvancePhase, phaseTagFromFrontmatter, reconcileInvalidDone } from '../src/tools/phase-transition.js';

const fixtureRoot = new URL('./fixtures/phase-gate-vault/', import.meta.url).pathname;

describe('phase transition helper', () => {
  it('extracts phase from frontmatter tags', () => {
    expect(phaseTagFromFrontmatter({ tags: ['foo', 'phase/build'] })).toBe('build');
    expect(phaseTagFromFrontmatter({ tags: ['foo'] })).toBeNull();
  });

  it('advances a phase when the gate passes', () => {
    const result = applyAdvancePhase(
      {
        projectId: 'cleanproject000001',
        status: 'in-progress',
        progress: 50,
        tags: ['phase/scope'],
      },
      {
        vaultRoot: fixtureRoot,
        nowIso: '2026-07-21T18:30:00.000Z',
        nowMinute: '2026-07-21T18:30',
      },
    );

    expect(result.ok).toBe(true);
    expect(result.phase).toBe('scope');
    expect(result.frontmatter.status).toBe('done');
    expect(result.frontmatter.progress).toBe(100);
    expect(result.frontmatter.updatedAt).toBe('2026-07-21T18:30:00.000Z');
    expect(result.frontmatter.last_valid_status).toBe('in-progress');
    expect(result.frontmatter.gate_validated_phase).toBe('scope');
    expect(String(result.frontmatter.last_result)).toContain('Advanced scope to done');
  });

  it('refuses a phase when the gate fails', () => {
    const result = applyAdvancePhase(
      {
        projectId: 'gatedproject00001',
        status: 'in-progress',
        progress: 50,
        tags: ['phase/build'],
      },
      {
        vaultRoot: fixtureRoot,
        nowIso: '2026-07-21T18:30:00.000Z',
        nowMinute: '2026-07-21T18:30',
      },
    );

    expect(result.ok).toBe(false);
    expect(result.phase).toBe('build');
    expect(result.frontmatter.status).toBe('in-progress');
    expect(result.frontmatter.request_status).toBe('error');
    expect(String(result.frontmatter.last_result)).toContain('Blocked:');
  });

  it('returns applied no-op when already done', () => {
    const result = applyAdvancePhase(
      {
        projectId: 'cleanproject000001',
        status: 'done',
        progress: 100,
        tags: ['phase/verify'],
      },
      {
        vaultRoot: fixtureRoot,
        nowIso: '2026-07-21T18:30:00.000Z',
        nowMinute: '2026-07-21T18:30',
      },
    );

    expect(result.ok).toBe(true);
    expect(result.frontmatter.request_status).toBe('applied');
    expect(String(result.frontmatter.last_result)).toContain('already done');
  });

  it('reconciles an invalid done state back to the last valid status', () => {
    const result = reconcileInvalidDone(
      {
        status: 'done',
        progress: 100,
        tags: ['phase/plan'],
        last_valid_status: 'todo',
      },
      'missing plan block',
      { nowIso: '2026-07-21T18:45:00.000Z' },
    );

    expect(result.changed).toBe(true);
    expect(result.frontmatter.status).toBe('todo');
    expect(result.frontmatter.progress).toBe(0);
    expect(result.frontmatter.request_status).toBe('reconciled');
    expect(String(result.frontmatter.last_result)).toContain('Auto-reverted plan from done to todo');
  });

  it('falls back to in-progress when no prior valid status is recorded', () => {
    const result = reconcileInvalidDone(
      {
        status: 'done',
        progress: 100,
        tags: ['phase/verify'],
      },
      'missing verification record',
      { nowIso: '2026-07-21T18:45:00.000Z' },
    );

    expect(result.changed).toBe(true);
    expect(result.frontmatter.status).toBe('in-progress');
    expect(result.frontmatter.progress).toBe(50);
    expect(String(result.frontmatter.last_result)).toContain('missing verification record');
  });
});
