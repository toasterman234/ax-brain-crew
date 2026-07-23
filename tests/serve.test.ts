import { describe, it, expect } from 'vitest';
import { planFromOpenAi } from '../src/cli/serve.js';

const AGENTS = new Set(['scribe', 'seeker', 'sorter']);

describe('planFromOpenAi', () => {
  it('uses the last user message as the current turn', () => {
    const plan = planFromOpenAi(
      { model: 'crew', messages: [{ role: 'user', content: 'hello there' }] },
      AGENTS,
    );
    expect(plan.request).toBe('hello there');
    expect(plan.routingAgent).toBeNull();
    expect(plan.stream).toBe(false);
  });

  it('forces the agent when the model id names one', () => {
    const plan = planFromOpenAi(
      { model: 'seeker', messages: [{ role: 'user', content: 'what do I know' }] },
      AGENTS,
    );
    expect(plan.routingAgent).toBe('seeker');
    expect(plan.request.startsWith('/seeker ')).toBe(true);
    expect(/^\/(\w+)/.exec(plan.request)?.[1]).toBe('seeker');
  });

  it('threads prior messages as conversation history', () => {
    const plan = planFromOpenAi(
      {
        model: 'crew',
        messages: [
          { role: 'system', content: 'you are helpful' },
          { role: 'user', content: 'remember Orion' },
          { role: 'assistant', content: 'noted Orion' },
          { role: 'user', content: 'what did I say?' },
        ],
      },
      AGENTS,
    );
    expect(plan.request).toContain('## Conversation so far');
    expect(plan.request).toContain('You: remember Orion');
    expect(plan.request).toContain('Assistant (crew): noted Orion');
    expect(plan.request).toContain('## Current message\nwhat did I say?');
    // System messages are dropped.
    expect(plan.request).not.toContain('you are helpful');
  });

  it('honors the stream flag', () => {
    const plan = planFromOpenAi(
      { model: 'crew', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      AGENTS,
    );
    expect(plan.stream).toBe(true);
  });

  it('defaults to the auto model and empty request when no user message', () => {
    const plan = planFromOpenAi({ messages: [] }, AGENTS);
    expect(plan.model).toBe('crew');
    expect(plan.request).toBe('');
  });
});
