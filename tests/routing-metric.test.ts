import { describe, it, expect } from 'vitest';
import {
  scoreRouting,
  selectedFromPrediction,
  routingMetric,
  ESCALATE,
} from '../src/evals/routing-metric.js';

describe('scoreRouting', () => {
  it('scores 1 on an exact specialist match', () => {
    expect(scoreRouting('librarian', 'librarian')).toBe(1);
  });

  it('scores 0 when it routes to the wrong specialist', () => {
    expect(scoreRouting('seeker', 'scribe')).toBe(0);
  });

  it('scores 1 for a clarify-labeled case when the router escalated', () => {
    expect(scoreRouting('clarify', 'clarify')).toBe(1);
    expect(scoreRouting('conductor', 'clarify')).toBe(1);
    expect(scoreRouting('none', 'clarify')).toBe(1);
  });

  it('scores 0 for a clarify-labeled case that confidently mis-routed', () => {
    expect(scoreRouting('scribe', 'clarify')).toBe(0);
  });
});

describe('selectedFromPrediction', () => {
  it('reads the specialist from a team.* function call', () => {
    expect(
      selectedFromPrediction({
        completionType: 'final',
        functionCalls: [{ qualifiedName: 'team.librarian' }],
      }),
    ).toBe('librarian');
  });

  it('maps an askClarification completion to clarify', () => {
    expect(
      selectedFromPrediction({ completionType: 'askClarification' }),
    ).toBe('clarify');
  });

  it('returns none when nothing was selected', () => {
    expect(selectedFromPrediction({ completionType: 'final', functionCalls: [] })).toBe(
      'none',
    );
  });

  it('ignores non-team function calls', () => {
    expect(
      selectedFromPrediction({
        functionCalls: [{ qualifiedName: 'utils.helper' }],
      }),
    ).toBe('none');
  });
});

describe('routingMetric (AxMetricFn)', () => {
  it('scores a full prediction against the example label', () => {
    const score = routingMetric({
      prediction: {
        completionType: 'final',
        functionCalls: [{ qualifiedName: 'team.scribe' }],
      },
      example: { expectedAgent: 'scribe' } as any,
    });
    expect(score).toBe(1);
  });

  it('penalizes a wrong route', () => {
    const score = routingMetric({
      prediction: {
        completionType: 'final',
        functionCalls: [{ qualifiedName: 'team.seeker' }],
      },
      example: { expectedAgent: 'scribe' } as any,
    });
    expect(score).toBe(0);
  });
});

describe('ESCALATE bucket', () => {
  it('treats conductor/clarify/none as escalation', () => {
    for (const r of ['conductor', 'clarify', 'none']) {
      expect(ESCALATE.has(r)).toBe(true);
    }
    expect(ESCALATE.has('librarian')).toBe(false);
  });
});
