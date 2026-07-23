import { describe, it, expect } from 'vitest';
import {
  compressObservation,
  buildSummarizationPrompt,
  parseSummarizationOutput,
  summarizationMetric,
  type Observation,
} from '../src/tools/session-summarize.js';

// ---------------------------------------------------------------------------
// compressObservation
// ---------------------------------------------------------------------------

describe('compressObservation', () => {
  it('compresses a conversation-type observation', () => {
    const obs: Observation = {
      timestamp: '2026-07-16T05:20:29.767Z',
      type: 'conversation',
      title: 'prompt_submit',
      narrative: 'can you continue where this agent cut off?',
    };
    const result = compressObservation(obs);
    expect(result).toContain('Ben:');
    expect(result).toContain('can you continue where this agent cut off');
    expect(result.length).toBeLessThan(150);
  });

  it('compresses a command_run observation', () => {
    const obs: Observation = {
      timestamp: '2026-07-16T05:39:17.640Z',
      type: 'command_run',
      title: 'Bash',
      narrative: JSON.stringify({
        command: 'python3 -m unittest __tests__.car_comps_smoke 2>&1',
        stdout: 'FAIL: test_rejects_plural_competing_model',
        stderr: '',
      }),
    };
    const result = compressObservation(obs);
    expect(result).toContain('Bash:');
    expect(result).toContain('python3 -m unittest');
    expect(result).toContain('FAIL');
    expect(result.length).toBeLessThan(250);
  });

  it('compresses a file_read observation', () => {
    const obs: Observation = {
      timestamp: '2026-07-16T01:59:25.240Z',
      type: 'file_read',
      title: 'Read',
      files: ['/Users/bencharney/ben-workspace/docs/adr/0002.md'],
    };
    const result = compressObservation(obs);
    expect(result).toContain('Read:');
    expect(result).toContain('0002.md');
  });

  it('compresses a file_edit observation', () => {
    const obs: Observation = {
      timestamp: '2026-07-16T05:39:49.516Z',
      type: 'file_edit',
      title: 'Edit',
      files: ['/Users/bencharney/life-os-knowledge-graph/CONTEXT.md'],
      narrative: JSON.stringify({
        file_path: '/Users/bencharney/life-os-knowledge-graph/CONTEXT.md',
        new_string:
          '## Checkpoint (2026-07-16) — Car comps: per-listing year/model/mileage validation',
      }),
    };
    const result = compressObservation(obs);
    expect(result).toContain('Edit:');
    expect(result).toContain('CONTEXT.md');
    expect(result.length).toBeLessThan(250);
  });

  it('compresses a web_fetch observation', () => {
    const obs: Observation = {
      timestamp: '2026-07-16T05:42:46.286Z',
      type: 'web_fetch',
      title: 'WebFetch',
      narrative: JSON.stringify({
        url: 'https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sessions.md',
        code: 200,
      }),
    };
    const result = compressObservation(obs);
    expect(result).toContain('Fetch:');
    expect(result).toContain('github.com');
    expect(result).toContain('200');
  });

  it('compresses a subagent start observation', () => {
    const obs: Observation = {
      timestamp: '2026-07-16T05:13:20.262Z',
      type: 'subagent',
      title: 'subagent_start',
    };
    const result = compressObservation(obs);
    expect(result).toContain('Launched subagent');
  });

  it('handles missing narrative gracefully', () => {
    const obs: Observation = {
      timestamp: '2026-07-16T00:00:00.000Z',
      type: 'error',
      title: 'Error',
    };
    const result = compressObservation(obs);
    expect(result).toContain('⚠️ Error');
  });
});

// ---------------------------------------------------------------------------
// buildSummarizationPrompt
// ---------------------------------------------------------------------------

describe('buildSummarizationPrompt', () => {
  it('builds a prompt with session info and observations', () => {
    const observations: Observation[] = [
      {
        timestamp: '2026-07-16T05:20:29.767Z',
        type: 'conversation',
        title: 'prompt_submit',
        narrative: 'can you continue where this agent cut off?',
      },
      {
        timestamp: '2026-07-16T05:40:02.057Z',
        type: 'other',
        title: 'ScheduleWakeup',
      },
      {
        timestamp: '2026-07-16T05:56:48.554Z',
        type: 'other',
        title: 'ScheduleWakeup',
      },
    ];
    const { system, user } = buildSummarizationPrompt({
      sessionId: 'e9af1e86',
      project: 'fast-cheetah',
      observations,
    });

    expect(system).toContain('session summarizer');
    expect(system).toContain('decisions');
    expect(system).toContain('checkpoint');
    expect(user).toContain('e9af1e86');
    expect(user).toContain('fast-cheetah');
    expect(user).toContain('can you continue');
  });

  it('enforces token budget by truncating oldest observations', () => {
    // Generate many observations to trigger truncation
    const observations: Observation[] = Array.from({ length: 500 }, (_, i) => ({
      timestamp: '2026-07-16T00:00:00.000Z',
      type: 'command_run' as const,
      title: 'Bash',
      narrative: JSON.stringify({
        command: `echo "observation ${i}"`,
        stdout: `output ${i}`.repeat(10),
      }),
    }));

    const { user } = buildSummarizationPrompt({
      sessionId: 'test',
      observations,
    });
    expect(user).toContain('omitted');
    expect(user).toContain('oldest');
  });
});

// ---------------------------------------------------------------------------
// parseSummarizationOutput
// ---------------------------------------------------------------------------

describe('parseSummarizationOutput', () => {
  it('parses valid JSON output', () => {
    const json = JSON.stringify({
      summary: 'The session involved evaluating a Mira dashboard.',
      decisions: [
        {
          decision: 'Use per-listing validation for car comps',
          rationale: 'Ben requested year/model/mileage checks',
          madeBy: 'Ben',
          reversible: false,
        },
      ],
      openItems: [
        {
          item: 'Dashboard refresh mechanism',
          status: 'in-progress',
          nextAction: 'Update ui/scripts/export_ui_data.py',
        },
      ],
      checkpoint: 'Continue dashboard refresh by running snapshot_car_comps.py',
      filesTouched: [
        { path: 'life-os-knowledge-graph/CONTEXT.md', action: 'modified' },
        { path: 'life-os-knowledge-graph/runtime/hpi/car_comps.py', action: 'modified' },
      ],
      estimatedCompleteness: 0.85,
    });

    const result = parseSummarizationOutput(json, 'test-session');
    expect(result.summary).toContain('Mira dashboard');
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.madeBy).toBe('Ben');
    expect(result.openItems).toHaveLength(1);
    expect(result.openItems[0]!.status).toBe('in-progress');
    expect(result.checkpoint).toContain('snapshot_car_comps.py');
    expect(result.filesTouched).toHaveLength(2);
    expect(result.estimatedCompleteness).toBe(0.85);
    expect(result.sourceSessionId).toBe('test-session');
  });

  it('handles JSON with markdown fences', () => {
    const raw = '```json\n' + JSON.stringify({
      summary: 'Test.',
      decisions: [],
      openItems: [],
      checkpoint: 'Proceed.',
      filesTouched: [],
      estimatedCompleteness: 1.0,
    }) + '\n```';

    const result = parseSummarizationOutput(raw, 'test');
    expect(result.summary).toBe('Test.');
    expect(result.checkpoint).toBe('Proceed.');
  });

  it('handles non-JSON response gracefully', () => {
    const raw = 'I apologize, but I cannot determine the session state.';
    const result = parseSummarizationOutput(raw, 'test');
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
    expect(result.warnings![0]).toContain('not valid JSON');
    expect(result.summary).toContain('I apologize');
    expect(result.estimatedCompleteness).toBe(0.3);
  });

  it('validates and clamps estimatedCompleteness', () => {
    const json = JSON.stringify({
      summary: 'Test.',
      decisions: [],
      openItems: [],
      checkpoint: 'Proceed.',
      filesTouched: [],
      estimatedCompleteness: 1.5,
    });
    const result = parseSummarizationOutput(json, 'test');
    expect(result.estimatedCompleteness).toBe(1.0);
  });

  it('adds warning when checkpoint is missing', () => {
    const json = JSON.stringify({
      summary: 'Test.',
      decisions: [],
      openItems: [],
      checkpoint: '',
      filesTouched: [],
      estimatedCompleteness: 0.5,
    });
    const result = parseSummarizationOutput(json, 'test');
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes('No checkpoint'))).toBe(true);
  });

  it('filters empty decisions and open items', () => {
    const json = JSON.stringify({
      summary: 'Test.',
      decisions: [
        { decision: '', rationale: '', madeBy: 'Agent', reversible: true },
        { decision: 'Real decision', rationale: 'Because', madeBy: 'Agent', reversible: false },
      ],
      openItems: [
        { item: '', status: 'in-progress', nextAction: '' },
      ],
      checkpoint: 'Proceed.',
      filesTouched: [],
      estimatedCompleteness: 0.5,
    });
    const result = parseSummarizationOutput(json, 'test');
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.decision).toBe('Real decision');
    expect(result.openItems).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// summarizationMetric
// ---------------------------------------------------------------------------

describe('summarizationMetric', () => {
  it('returns high score for a good summary', () => {
    const output = {
      summary: 'Ben asked to continue the session where the agent was working on dashboard.',
      decisions: [
        {
          decision: 'Use per-listing validation for car comps',
          rationale: 'Ben requested year/model/mileage checks',
          madeBy: 'Ben' as const,
          reversible: false,
        },
      ],
      openItems: [
        {
          item: 'Dashboard refresh mechanism',
          status: 'in-progress' as const,
          nextAction: 'Update export script',
        },
      ],
      checkpoint: 'Continue dashboard refresh by running snapshot_car_comps.py',
      filesTouched: [
        { path: 'CONTEXT.md', action: 'modified' as const },
      ],
      estimatedCompleteness: 0.9,
      sourceSessionId: 'test',
    };

    const groundTruth = {
      expectedDecisions: ['Use per-listing validation for car comps'],
      expectedOpenItems: ['Dashboard refresh mechanism'],
      expectedCheckpoint: 'Continue dashboard refresh',
    };

    const { score, details } = summarizationMetric({ output, groundTruth });
    expect(score).toBeGreaterThan(0.6);
    expect(details.decisionsRecall).toBeCloseTo(1.0);
    expect(details.openItemsRecall).toBeCloseTo(1.0);
  });

  it('returns low score when decisions are missed', () => {
    const output = {
      summary: 'Session continued.',
      decisions: [],
      openItems: [],
      checkpoint: 'Continue.',
      filesTouched: [],
      estimatedCompleteness: 0.5,
      sourceSessionId: 'test',
    };

    const groundTruth = {
      expectedDecisions: ['Use per-listing validation', 'Commit the changes'],
      expectedOpenItems: ['Fix failing test'],
      expectedCheckpoint: 'Continue dashboard refresh',
    };

    const { score, details } = summarizationMetric({ output, groundTruth });
    expect(score).toBeLessThan(0.5);
    expect(details.decisionsRecall).toBe(0);
    expect(details.openItemsRecall).toBe(0);
  });

  it('handles empty ground truth gracefully', () => {
    const output = {
      summary: 'No decisions were made.',
      decisions: [],
      openItems: [],
      checkpoint: 'Session ended.',
      filesTouched: [],
      estimatedCompleteness: 0.5,
      sourceSessionId: 'test',
    };

    const groundTruth = {
      expectedDecisions: [],
      expectedOpenItems: [],
      expectedCheckpoint: '',
    };

    const { score } = summarizationMetric({ output, groundTruth });
    expect(score).toBeGreaterThan(0);
  });
});
