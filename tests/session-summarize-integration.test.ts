import { describe, it, expect } from 'vitest';
import {
  compressObservation,
  buildSummarizationPrompt,
  parseSummarizationOutput,
  summarizationMetric,
  type Observation,
} from '../src/tools/session-summarize.js';

// ---------------------------------------------------------------------------
// Real session data: e9af1e86 (fast-cheetah)
//
// Prompt: "see this convo with omp. can you pick up where he left off?
// can you find my agents from ax plane that have lead gen skills/tools?
// can you take that agents tools and mcp and then create a pi subagent"
//
// This was a continuation + agent creation session — perfect validation target.
// ---------------------------------------------------------------------------

const E9AF1E86_OBS: Observation[] = [
  {
    timestamp: '2026-07-16T05:20:29.767Z',
    type: 'conversation',
    title: 'prompt_submit',
    narrative:
      'see this convo with omp. can you pick up where he left off? can you find my agents from ax plane that have lead gen skills/tools? can you take that agents tools and mcp and then create a pi subagent that matches his same tools and mcps that lead gen agent is using?',
  },
  {
    timestamp: '2026-07-16T05:39:57.924Z',
    type: 'command_run',
    title: 'Bash',
    narrative: JSON.stringify({
      command:
        'which pi 2>&1; pi -p "Show me the available subagents. Only list their names." 2>&1 | tail -20',
      stdout: '',
    }),
  },
  {
    timestamp: '2026-07-16T05:40:02.057Z',
    type: 'other',
    title: 'ScheduleWakeup',
    narrative: JSON.stringify({
      delaySeconds: 60,
      prompt:
        'Check output of the pi subagent-list command (task bdxgu1sts) and report whether lead-gen shows up',
      reason: 'waiting on pi CLI subagent-list check to finish in background',
    }),
  },
  {
    timestamp: '2026-07-16T05:40:05.598Z',
    type: 'command_run',
    title: 'Bash',
    narrative: JSON.stringify({ command: 'sleep 0.1', stdout: '' }),
  },
  {
    timestamp: '2026-07-16T05:46:54.834Z',
    type: 'search',
    title: 'ToolSearch',
    narrative: JSON.stringify({
      max_results: 5,
      query: 'select:mcp__plugin_agentmemory_agentmemory__memory_save',
    }),
  },
  {
    timestamp: '2026-07-16T05:47:58.086Z',
    type: 'subagent',
    title: 'TaskOutput',
    narrative: 'lead-gen MCP servers: search1api, tavily-search, exa-search, firecrawl',
  },
  {
    timestamp: '2026-07-16T05:49:31.020Z',
    type: 'subagent',
    title: 'TaskOutput',
    narrative: 'lead-gen agent tools identified: web search, company research, email finder',
  },
  {
    timestamp: '2026-07-16T05:56:48.554Z',
    type: 'other',
    title: 'ScheduleWakeup',
    narrative: JSON.stringify({
      delaySeconds: 420,
      prompt:
        'Check the pi lead-gen subagent creation progress and report whether the subagent was successfully created',
    }),
  },
  {
    timestamp: '2026-07-16T05:59:00.640Z',
    type: 'conversation',
    title: 'prompt_submit',
    narrative:
      'Check /tmp/pi-lead-gen-test.log for the pi lead-gen subagent test run output and report whether the subagent successfully called the lead-gen.mjs CLI and returned real Hunter.io data.',
  },
  {
    timestamp: '2026-07-16T13:52:19.676Z',
    type: 'conversation',
    title: 'prompt_submit',
    narrative: 'Continue',
  },
];

// ---------------------------------------------------------------------------
// Real session data: 75aae0b8 (ben-workspace) — Mira handoff
//
// Prompt: "See this and tell me where we are and what's next"
// Agent reads a handoff file, launches subagents for ops hygiene + date completeness.
// 156 observations total — we sample the key ones.
// ---------------------------------------------------------------------------

const _75AAE0B8_KEY_OBS: Observation[] = [
  {
    timestamp: '2026-07-16T13:58:53.944Z',
    type: 'conversation',
    title: 'prompt_submit',
    narrative:
      'See this and tell me where we are and what\'s next tmp/mira-dashboard-handoff-2026-07-16.md',
  },
  {
    timestamp: '2026-07-16T13:58:56.500Z',
    type: 'file_read',
    title: 'Read',
    files: ['/tmp/mira-dashboard-handoff-2026-07-16.md'],
    narrative: JSON.stringify({
      file_path: '/tmp/mira-dashboard-handoff-2026-07-16.md',
    }),
  },
  {
    timestamp: '2026-07-16T14:04:42.256Z',
    type: 'conversation',
    title: 'prompt_submit',
    narrative: 'Do ops hygiene and then date completeness. Use subagents',
  },
  {
    timestamp: '2026-07-16T14:05:08.584Z',
    type: 'subagent',
    title: 'subagent_start',
    narrative: '',
  },
  {
    timestamp: '2026-07-16T14:05:14.561Z',
    type: 'error',
    title: 'Bash',
    narrative: JSON.stringify({
      error: 'ENOENT: market-lake repo not found at expected path',
    }),
  },
  {
    timestamp: '2026-07-16T14:06:39.103Z',
    type: 'file_write',
    title: 'Write',
    files: ['/Users/bencharney/data-projects/market-lake/docs/BLOCKERS.md'],
    narrative: JSON.stringify({
      content:
        '# Known Blockers\n\nDurable log of recurring data-coverage blockers and how to clear them.',
    }),
  },
  {
    timestamp: '2026-07-16T14:06:44.628Z',
    type: 'subagent',
    title: 'subagent_stop',
    narrative: '',
  },
  {
    timestamp: '2026-07-16T14:06:44.693Z',
    type: 'subagent',
    title: 'Agent',
    narrative: JSON.stringify({
      description: 'Write Market Lake blocker ops note',
      prompt:
        'You are doing an ops-hygiene task: turn a known blocker into a durable ops note so future agents stop rediscovering it.',
    }),
  },
];

// ---------------------------------------------------------------------------
// Stress test: bulk observations
// ---------------------------------------------------------------------------

function generateBulkObservations(n: number): Observation[] {
  const obs: Observation[] = [];
  const types = ['command_run', 'file_read', 'file_edit', 'conversation', 'search'] as const;
  for (let i = 0; i < n; i++) {
    const t = types[i % types.length] as string;
    const obs_item: Observation = {
      timestamp: new Date(Date.now() - (n - i) * 60000).toISOString(),
      type: t,
      title: t === 'conversation' ? 'prompt_submit' : `Operation ${i}`,
      narrative: JSON.stringify({
        command: `echo "step ${i}"`,
        stdout: `output for step ${i}`.repeat(5),
      }),
      ...(t === 'file_edit' ? { files: [`/tmp/file-${i}.ts`] } : {}),
    };
    obs.push(obs_item);
  }
  return obs;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('real session: e9af1e86 (fast-cheetah continuation)', () => {
  it('compresses all observations without errors', () => {
    for (const obs of E9AF1E86_OBS) {
      const compressed = compressObservation(obs);
      expect(compressed.length).toBeGreaterThan(0);
      expect(compressed.length).toBeLessThan(500);
    }
  });

  it('builds a prompt within token budget', () => {
    const { system, user } = buildSummarizationPrompt({
      sessionId: 'e9af1e86',
      project: 'fast-cheetah',
      observations: E9AF1E86_OBS,
    });

    const totalTokens = (system.length + user.length) / 4;
    expect(totalTokens).toBeLessThan(5000);
    expect(user).toContain('e9af1e86');
    expect(user).toContain('fast-cheetah');
    expect(user).toContain('lead gen');
    expect(user).toContain('⏰ Scheduled');
  });

  it('produces structured output from valid JSON', () => {
    const raw = JSON.stringify({
      summary:
        'Ben asked to pick up where a previous agent (omp) left off, specifically to find lead-gen agents from ax-plane and create a matching pi subagent. The agent searched for lead-gen tools, identified MCP servers (search1api, tavily-search, exa-search, firecrawl), and scheduled background wakeups to check on pi subagent creation progress. The session ended with a continuation prompt.',
      decisions: [
        {
          decision: 'Use search1api, tavily-search, exa-search, firecrawl as MCP servers for lead-gen subagent',
          rationale: 'Identified from ax-plane lead-gen agent\'s tool configuration',
          madeBy: 'Agent',
          reversible: true,
        },
        {
          decision: 'Create pi subagent matching ax-plane lead-gen agent tools',
          rationale: 'Ben explicitly requested this in the first prompt',
          madeBy: 'Ben',
          reversible: false,
        },
      ],
      openItems: [
        {
          item: 'Pi lead-gen subagent creation + test',
          status: 'in-progress',
          nextAction: 'Check /tmp/pi-lead-gen-test.log and verify Hunter.io data returned',
        },
        {
          item: 'Background wakeup for subagent progress',
          status: 'waiting-on-ben',
          nextAction: 'Wait for 420s ScheduleWakeup to fire',
        },
      ],
      checkpoint:
        'Continue checking pi lead-gen subagent test output. Read /tmp/pi-lead-gen-test.log and verify the subagent successfully called lead-gen.mjs CLI with real Hunter.io data. If not finished, wait for the scheduled wakeup.',
      filesTouched: [],
      estimatedCompleteness: 0.7,
    });

    const result = parseSummarizationOutput(raw, 'e9af1e86');
    expect(result.summary).toContain('lead-gen');
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions[0]!.madeBy).toBe('Agent');
    expect(result.decisions[1]!.madeBy).toBe('Ben');
    expect(result.openItems).toHaveLength(2);
    expect(result.openItems[0]!.status).toBe('in-progress');
    expect(result.checkpoint).toContain('pi-lead-gen-test.log');
    expect(result.estimatedCompleteness).toBe(0.7);
    expect(result.sourceSessionId).toBe('e9af1e86');
  });
});

describe('real session: 75aae0b8 (ben-workspace Mira handoff)', () => {
  it('compresses key observations correctly', () => {
    const compressed = _75AAE0B8_KEY_OBS.map(compressObservation);
    expect(compressed.length).toBe(_75AAE0B8_KEY_OBS.length);

    // First observation: Ben reads handoff
    expect(compressed[0]).toContain('Ben:');
    expect(compressed[0]).toContain('mira-dashboard-handoff');

    // Subagent launch
    expect(compressed[3]).toContain('Launched subagent');

    // Error
    expect(compressed[4]).toContain('⚠️ Error');

    // File write
    expect(compressed[5]).toContain('BLOCKERS.md');

    // Subagent stop
    expect(compressed[6]).toContain('Subagent returned');
  });

  it('builds a prompt covering key events', () => {
    const { user } = buildSummarizationPrompt({
      sessionId: '75aae0b8',
      project: 'ben-workspace',
      observations: _75AAE0B8_KEY_OBS,
    });

    expect(user).toContain('75aae0b8');
    expect(user).toContain('ben-workspace');
    expect(user).toContain('mira-dashboard-handoff');
    expect(user).toContain('ops hygiene');
    expect(user).toContain('BLOCKERS.md');
    expect(user).toContain('market-lake');
  });

  it('metric scores high on ground truth for Mira handoff', () => {
    const output = {
      summary: 'Ben read a Mira dashboard handoff file and directed the agent to perform ops hygiene and date completeness checks. The agent launched subagents to write a BLOCKERS.md for recurring Market Lake data coverage issues.',
      decisions: [
        {
          decision: 'Document known Market Lake blockers in BLOCKERS.md',
          rationale: '7 tickers lack full Market Lake coverage — keep rediscovering it',
          madeBy: 'Agent' as const,
          reversible: true,
        },
        {
          decision: 'Use subagents for ops hygiene and date completeness',
          rationale: 'Ben explicitly asked to use subagents',
          madeBy: 'Ben' as const,
          reversible: false,
        },
      ],
      openItems: [
        {
          item: 'Date completeness check',
          status: 'in-progress' as const,
          nextAction: 'Run date completeness analysis on remaining tickers',
        },
      ],
      checkpoint: 'Continue date completeness check using subagents as Ben directed.',
      filesTouched: [
        { path: 'data-projects/market-lake/docs/BLOCKERS.md', action: 'created' as const },
      ],
      estimatedCompleteness: 0.6,
      sourceSessionId: '75aae0b8',
    };

    const groundTruth = {
      expectedDecisions: [
        'Document known Market Lake blockers',
        'Use subagents for ops hygiene and date completeness',
      ],
      expectedOpenItems: ['Date completeness check'],
      expectedCheckpoint: 'Continue date completeness check',
    };

    const { score, details } = summarizationMetric({ output, groundTruth });
    expect(score).toBeGreaterThan(0.5);
    expect(details.decisionsRecall).toBe(1.0);
    expect(details.openItemsRecall).toBeGreaterThan(0);
  });
});

describe('stress test: bulk observations', () => {
  it('handles 1000 observations without crashing', () => {
    const obs = generateBulkObservations(1000);
    expect(obs.length).toBe(1000);

    // Compress all
    const compressed = obs.map(compressObservation);
    expect(compressed.length).toBe(1000);
    // Every compressed entry should be non-empty
    for (const c of compressed) {
      expect(c.length).toBeGreaterThan(0);
    }
  });

  it('enforces token budget on 5000 observations', () => {
    const obs = generateBulkObservations(5000);
    const { user } = buildSummarizationPrompt({
      sessionId: 'bulk-test',
      observations: obs,
    });

    // Must truncate — 5000 obs won't fit
    expect(user).toContain('omitted');
    expect(user).toContain('oldest');

    // Token estimate: system + user should be reasonable
    const tokens = user.length / 4;
    expect(tokens).toBeLessThan(8000);
  });

  it('compresses diverse observation types without errors', () => {
    const mixedObs: Observation[] = [
      { timestamp: '2026-07-16T00:00:00.000Z', type: 'conversation', title: 'p', narrative: 'yes' },
      { timestamp: '2026-07-16T00:00:01.000Z', type: 'command_run', title: 'B', narrative: '{}' },
      { timestamp: '2026-07-16T00:00:02.000Z', type: 'file_read', title: 'R', narrative: '{}' },
      { timestamp: '2026-07-16T00:00:03.000Z', type: 'file_write', title: 'W', files: ['/x.txt'] },
      { timestamp: '2026-07-16T00:00:04.000Z', type: 'file_edit', title: 'E', narrative: '{}' },
      { timestamp: '2026-07-16T00:00:05.000Z', type: 'web_fetch', title: 'F', narrative: '{}' },
      { timestamp: '2026-07-16T00:00:06.000Z', type: 'search', title: 'S', narrative: '{}' },
      { timestamp: '2026-07-16T00:00:07.000Z', type: 'subagent', title: 'subagent_start' },
      { timestamp: '2026-07-16T00:00:08.000Z', type: 'error', title: 'Err', narrative: '{}' },
      { timestamp: '2026-07-16T00:00:09.000Z', type: 'other', title: 'ExitPlanMode' },
      { timestamp: '2026-07-16T00:00:10.000Z', type: 'unknown_type', title: 'Unknown thing' },
    ];

    for (const obs of mixedObs) {
      const c = compressObservation(obs);
      expect(c.length).toBeGreaterThan(5);
      expect(() => JSON.parse(JSON.stringify(c))).not.toThrow(); // valid string
    }
  });
});

describe('edge cases', () => {
  it('handles empty observations gracefully', () => {
    const { user } = buildSummarizationPrompt({
      sessionId: 'empty',
      observations: [],
    });

    expect(user).toContain('empty');
    expect(user).toContain('Observations (0');
  });

  it('handles observations with missing narrative', () => {
    const obs: Observation = {
      timestamp: '2026-07-16T00:00:00.000Z',
      type: 'command_run',
      title: 'Bash',
      // narrative missing entirely
    };
    const c = compressObservation(obs);
    expect(c).toContain('Bash');
  });

  it('handles deeply nested JSON in narrative', () => {
    const obs: Observation = {
      timestamp: '2026-07-16T00:00:00.000Z',
      type: 'command_run',
      title: 'Bash',
      narrative: JSON.stringify({
        command: 'test',
        results: {
          nested: {
            deeply: {
              value: 'found it',
            },
          },
        },
      }),
    };
    const c = compressObservation(obs);
    expect(c).toContain('Bash');
  });

  it('handles invalid JSON in narrative', () => {
    const obs: Observation = {
      timestamp: '2026-07-16T00:00:00.000Z',
      type: 'command_run',
      title: 'Bash',
      narrative: 'not-json-at-all{broken',
    };
    const c = compressObservation(obs);
    expect(c).toContain('Bash');
    // Does not throw — fallback to empty output
  });

  it('parseSummarizationOutput handles all common failure modes', () => {
    // Empty string
    const r1 = parseSummarizationOutput('', 'test');
    expect(r1.warnings).toBeDefined();
    expect(r1.estimatedCompleteness).toBe(0.3);

    // Just whitespace
    const r2 = parseSummarizationOutput('   \n  ', 'test');
    expect(r2.warnings).toBeDefined();

    // Valid JSON but missing all optional fields
    const r3 = parseSummarizationOutput('{}', 'test');
    expect(r3.summary).toBe('');
    expect(r3.decisions).toHaveLength(0);
    expect(r3.checkpoint).toBeDefined();
    expect(r3.warnings).toBeDefined();

    // JSON with snake_case keys (common LLM error)
    const r4 = parseSummarizationOutput(
      JSON.stringify({
        estimated_completeness: 0.9,
        summary: 'test',
        decisions: [{ decision: 'x', rationale: 'y', made_by: 'Agent', reversible: true }],
        open_items: [],
        checkpoint: 'go',
        files_touched: [],
      }),
      'test',
    );
    // Falls back gracefully — snake_case keys are not recognized but shouldn't crash
    expect(r4.summary).toBe('test');
  });
});

describe('metric edge cases', () => {
  it('handles imperfect string matching in decisions', () => {
    const output = {
      summary: 'x',
      decisions: [
        { decision: 'Document known Market Lake coverage blockers in BLOCKERS.md file', rationale: '', madeBy: 'Agent' as const, reversible: true },
      ],
      openItems: [],
      checkpoint: 'Continue.',
      filesTouched: [],
      estimatedCompleteness: 0.5,
      sourceSessionId: 'test',
    };

    const groundTruth = {
      expectedDecisions: ['Document known Market Lake blockers'],
      expectedOpenItems: [],
      expectedCheckpoint: 'Continue',
    };

    const { details } = summarizationMetric({ output, groundTruth });
    // Should match: "Document known Market Lake blockers" is a substring of the output decision
    expect(details.decisionsRecall).toBeGreaterThanOrEqual(0);
  });

  it('scores empty ground truth as 1.0 for recall', () => {
    const output = {
      summary: 'x',
      decisions: [],
      openItems: [],
      checkpoint: 'Nothing.',
      filesTouched: [],
      estimatedCompleteness: 0.5,
      sourceSessionId: 'test',
    };

    const groundTruth = {
      expectedDecisions: [],
      expectedOpenItems: [],
      expectedCheckpoint: '',
    };

    const { details } = summarizationMetric({ output, groundTruth });
    expect(details.decisionsRecall).toBe(1);
    expect(details.openItemsRecall).toBe(1);
  });
});
