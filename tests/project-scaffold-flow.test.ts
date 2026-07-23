import { describe, it, expect } from 'vitest';
import {
  buildProjectScaffoldFlow,
  generateCardId,
  todayIso,
  toTitleCase,
  stripFrontmatter,
  describeLifecycles,
  ensureCanonicalInitiativeNote,
} from '../src/flows/project-scaffold.js';

// ---------------------------------------------------------------------------
// project-scaffold flow tests (E2 batch 3)
//
// These test the deterministic helpers and flow structure. The flow's ax()
// LLM node is NOT exercised here (requires live API key). Flow build + output
// shape are tested.
// ---------------------------------------------------------------------------

describe('project-scaffold deterministic helpers', () => {
  it('generateCardId produces 16-char lowercase alphanumeric', () => {
    const id = generateCardId();
    expect(id).toMatch(/^[a-z0-9]{16}$/);
    // Uniqueness across 100 calls.
    const ids = new Set(Array.from({ length: 100 }, () => generateCardId()));
    expect(ids.size).toBe(100);
  });

  it('todayIso returns YYYY-MM-DD', () => {
    const d = todayIso();
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('toTitleCase converts kebab-case', () => {
    expect(toTitleCase('my-project-name')).toBe('My Project Name');
    expect(toTitleCase('vault-flow')).toBe('Vault Flow');
  });

  it('toTitleCase handles snake_case', () => {
    expect(toTitleCase('my_project_name')).toBe('My Project Name');
  });

  it('toTitleCase handles mixed', () => {
    expect(toTitleCase('issues-learnings_enforcement')).toBe('Issues Learnings Enforcement');
  });

  it('stripFrontmatter removes YAML frontmatter', () => {
    const input = `---
date: 2026-07-21
type: project
---

# Hello

World`;
    expect(stripFrontmatter(input)).toBe('# Hello\n\nWorld');
  });

  it('stripFrontmatter passes through when no frontmatter', () => {
    const input = '# Just a heading\n\nContent';
    expect(stripFrontmatter(input)).toBe('# Just a heading\n\nContent');
  });

  it('stripFrontmatter handles trailing --- close', () => {
    const input = `---
key: value
---

Body`;
    expect(stripFrontmatter(input)).toBe('Body');
  });

  it('stripFrontmatter handles edge: only opening ---', () => {
    const input = '---\nkey: value\n';
    expect(stripFrontmatter(input)).toBe(input); // no close delimiter — treat as body
  });

  it('describeLifecycles includes both known templates', () => {
    const desc = describeLifecycles();
    expect(desc).toContain('scope-plan-build-verify');
    expect(desc).toContain('research');
    expect(desc).toContain('scope → plan → build → verify');
    expect(desc).toContain('frame → gather → synthesize → verify');
  });
});

describe('project-scaffold canonical note seeding', () => {
  it('seeds canonical sections into a note without frontmatter', () => {
    const raw = '# My initiative\n\nNeed to make this real and governed.';
    const out = ensureCanonicalInitiativeNote({
      raw,
      name: 'My Initiative',
      lifecycle: 'scope-plan-build-verify',
      phases: [
        { phase: 'scope', title: 'Clarify scope', description: 'Write the scope note.' },
        { phase: 'plan', title: 'Plan the work', description: 'Write the plan block.' },
      ],
      today: '2026-07-21',
    });

    expect(out).toContain('type: project');
    expect(out).toContain('## Problem');
    expect(out).toContain('## Approach');
    expect(out).toContain('## Plan');
    expect(out).toContain('### Goal');
    expect(out).toContain('### Tasks');
    expect(out).toContain('### Open decisions');
  });

  it('preserves existing meaningful Problem and Approach sections', () => {
    const raw = `---
date: 2026-07-20
type: project
---

## Problem

This existing problem statement is already detailed enough to be useful and should remain unchanged by the scaffold helper.

## Approach

This existing approach section already explains the solution direction with enough detail that the helper should preserve it.
`;

    const out = ensureCanonicalInitiativeNote({
      raw,
      name: 'Preserve Me',
      lifecycle: 'scope-plan-build-verify',
      phases: [{ phase: 'scope', title: 'Clarify scope', description: '' }],
      today: '2026-07-21',
    });

    expect(out).toContain('This existing problem statement is already detailed enough');
    expect(out).toContain('This existing approach section already explains');
    expect(out).toContain('## Plan');
  });

  it('replaces an incomplete plan section with a canonical plan block', () => {
    const raw = `---
date: 2026-07-20
type: project
---

## Problem

This note already has enough problem detail to count as a real project problem statement with meaningful content.

## Approach

This note already has enough approach detail to count as a real solution direction with meaningful content.

## Plan

Just some prose, but no labeled sections yet.
`;

    const out = ensureCanonicalInitiativeNote({
      raw,
      name: 'Plan Fix',
      lifecycle: 'research',
      phases: [
        { phase: 'frame', title: 'Frame the question', description: '' },
        { phase: 'gather', title: 'Gather sources', description: '' },
      ],
      today: '2026-07-21',
    });

    expect(out).toContain('## Plan');
    expect(out).toContain('### Goal');
    expect(out).toContain('### Tasks');
    expect(out).toContain('### Open decisions');
    expect(out).not.toContain('Just some prose, but no labeled sections yet.');
  });
});

describe('project-scaffold flow structure', () => {
  it('buildProjectScaffoldFlow returns a flow without throwing', () => {
    const f = buildProjectScaffoldFlow();
    expect(f).toBeDefined();
    expect(typeof f.forward).toBe('function');
  });
});
