import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDerivedFieldsToNote, deriveProjectNoteStatus, refreshDerivedStatusNote } from '../src/tools/note-derived-status.js';

function baseNote(extra: string) {
  return `---
date: 2026-07-21
type: project
status: active
---

# Example

## Control
current_focus::
blocker::
latest_proof::
result::
derived_phase::
derived_status::
derived_result::
derived_updated_at::

## Problem
A real problem statement with enough content to satisfy the minimum threshold for derivation checks.

## Approach
A real approach statement with enough content to satisfy the minimum threshold for derivation checks.

## Plan
### Goal
Ship the thing.

### Tasks
- Do the thing.

### Open decisions
- None.

## Evidence
### Scope evidence

### Plan evidence

${extra}`;
}

describe('note-derived status', () => {
  it('derives build awaiting-proof when build evidence is missing', () => {
    const note = baseNote('### Build evidence\n\n### Verification evidence\n');
    const out = deriveProjectNoteStatus(note, { nowIso: '2026-07-21T20:00:00Z' });
    expect(out.derived_phase).toBe('build');
    expect(out.derived_status).toBe('awaiting-proof');
    expect(out.latestProof).toBe('');
    expect(out.autoBlocker).toBe('missing: Build evidence has no resolvable proof links');
  });

  it('derives verify awaiting-proof and extracts latest proof from build evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'derive-note-'));
    writeFileSync(join(root, 'deliverable.md'), '# deliverable');
    const note = baseNote('### Build evidence\n- [[deliverable]]\n\n### Verification evidence\n');
    const out = deriveProjectNoteStatus(note, { vaultRoot: root, nowIso: '2026-07-21T20:00:00Z' });
    expect(out.derived_phase).toBe('verify');
    expect(out.derived_status).toBe('awaiting-proof');
    expect(out.latestProof).toBe('deliverable');
    expect(out.autoBlocker).toBe('missing: Verification evidence has no resolvable proof links');
  });

  it('derives complete and prefers verify evidence over build for latest proof', () => {
    const root = mkdtempSync(join(tmpdir(), 'derive-note-'));
    writeFileSync(join(root, 'deliverable.md'), '# deliverable');
    mkdirSync(join(root, 'Meta', 'reviews'), { recursive: true });
    writeFileSync(join(root, 'Meta', 'reviews', 'review.md'), '# review');
    const note = baseNote('### Build evidence\n- [[deliverable]]\n\n### Verification evidence\n- [[Meta/reviews/review]]\n');
    const out = deriveProjectNoteStatus(note, { vaultRoot: root, nowIso: '2026-07-21T20:00:00Z' });
    expect(out.derived_phase).toBe('complete');
    expect(out.derived_status).toBe('awaiting-result');
    expect(out.latestProof).toBe('Meta/reviews/review');
    expect(out.autoBlocker).toBe('');
  });

  it('derives blocked when blocker is present; sets autoBlocker empty (human already filled it)', () => {
    const note = baseNote('### Build evidence\n\n### Verification evidence\n').replace('blocker::', 'blocker:: waiting on Ben');
    const out = deriveProjectNoteStatus(note, { nowIso: '2026-07-21T20:00:00Z' });
    expect(out.derived_phase).toBe('build');
    expect(out.derived_status).toBe('blocked');
    expect(out.autoBlocker).toBe('');
  });

  it('applies derived fields back into the note, filling empty human fields', () => {
    const note = baseNote('### Build evidence\n\n### Verification evidence\n');
    const out = applyDerivedFieldsToNote(note, {
      derived_phase: 'build',
      derived_status: 'awaiting-proof',
      derived_result: '',
      derived_updated_at: '2026-07-21T20:00:00Z',
      explanation: 'phase = build because no build evidence resolves yet',
      latestProof: '',
      autoBlocker: 'missing: Build evidence has no resolvable proof links',
    });
    expect(out).toContain('derived_phase:: build');
    expect(out).toContain('derived_status:: awaiting-proof');
    expect(out).toContain('derived_updated_at:: 2026-07-21T20:00:00Z');
    expect(out).toContain('blocker:: missing: Build evidence has no resolvable proof links');
  });

  it('refreshes derived fields only when values actually change', () => {
    const note = baseNote('### Build evidence\n\n### Verification evidence\n');
    const first = refreshDerivedStatusNote(note, { nowIso: '2026-07-21T20:00:00Z' });
    expect(first.changed).toBe(true);
    const second = refreshDerivedStatusNote(first.raw, { nowIso: '2026-07-21T20:00:00Z' });
    expect(second.changed).toBe(false);
  });

  it('never overwrites a human-set blocker with autoBlocker', () => {
    const note = baseNote('### Build evidence\n\n### Verification evidence\n').replace('blocker::', 'blocker:: waiting on Ben');
    const derived = deriveProjectNoteStatus(note, { nowIso: '2026-07-21T20:00:00Z' });
    const applied = applyDerivedFieldsToNote(note, derived);
    expect(applied).toContain('blocker:: waiting on Ben');
    expect(applied).not.toContain('blocker:: missing:');
  });

  it('sets latest_proof from the best available evidence category', () => {
    const root = mkdtempSync(join(tmpdir(), 'derive-note-'));
    writeFileSync(join(root, 'e2-review.md'), '# e2 review');
    const note = baseNote(
      '### Build evidence\n- [[e2-review]]\n\n### Verification evidence\n- [[missing-review]]\n',
    );
    const out = deriveProjectNoteStatus(note, { vaultRoot: root, nowIso: '2026-07-21T20:00:00Z' });
    const applied = applyDerivedFieldsToNote(note, out);
    expect(applied).toContain('latest_proof:: e2-review');
  });

  it('writes autoBlocker for scope-phase notes missing Problem', () => {
    const note = `---
type: project
---

# Minimal

## Control
blocker::
latest_proof::
result::

## Problem
S

## Approach
S
`;
    const out = deriveProjectNoteStatus(note, { nowIso: '2026-07-21T20:00:00Z' });
    expect(out.derived_phase).toBe('scope');
    expect(out.autoBlocker).toBe('missing: Problem section insufficient');
  });
});
