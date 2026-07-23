import { describe, it, expect } from 'vitest';
import {
  parseChatInput,
  buildTurnRequest,
  type ChatTurn,
} from '../src/cli/chat.js';

describe('parseChatInput', () => {
  it('treats blank lines as empty', () => {
    expect(parseChatInput('   ')).toEqual({ kind: 'empty' });
  });

  it('recognizes meta commands', () => {
    expect(parseChatInput('/exit')).toEqual({
      kind: 'meta',
      command: 'exit',
    });
    expect(parseChatInput('/NEW')).toEqual({
      kind: 'meta',
      command: 'new',
    });
  });

  it('extracts an explicit valid agent and message', () => {
    expect(parseChatInput('/seeker what do I know')).toEqual({
      kind: 'message',
      explicitAgent: 'seeker',
      message: 'what do I know',
    });
  });

  it('forwards an unknown slash as an agent token', () => {
    expect(parseChatInput('/wizard hello')).toEqual({
      kind: 'message',
      explicitAgent: 'wizard',
      message: 'hello',
    });
  });

  it('treats plain text as a message with no explicit agent', () => {
    expect(parseChatInput('save this thought')).toEqual({
      kind: 'message',
      explicitAgent: null,
      message: 'save this thought',
    });
  });
});

describe('buildTurnRequest', () => {
  it('returns the bare message on the first turn', () => {
    expect(buildTurnRequest([], null, 'hello')).toBe('hello');
  });

  it('keeps the routing prefix at position 0 so the router still matches', () => {
    const req = buildTurnRequest([], 'scribe', 'capture this');
    expect(req.startsWith('/scribe ')).toBe(true);
    expect(/^\/(\w+)/.exec(req)?.[1]).toBe('scribe');
  });

  it('includes prior turns and delimits the current message', () => {
    const transcript: ChatTurn[] = [
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: 'first answer', agentId: 'seeker' },
    ];
    const req = buildTurnRequest(transcript, 'seeker', 'follow up');
    expect(req).toContain('## Conversation so far');
    expect(req).toContain('You: first question');
    expect(req).toContain('Assistant (seeker): first answer');
    expect(req).toContain('## Current message\nfollow up');
    // Prefix must remain first even with history threaded in.
    expect(/^\/(\w+)/.exec(req)?.[1]).toBe('seeker');
  });

  it('caps history to the requested window', () => {
    const transcript: ChatTurn[] = Array.from({ length: 10 }, (_, i) => ({
      role: 'user' as const,
      text: `msg${i}`,
    }));
    const req = buildTurnRequest(transcript, null, 'now', 2);
    expect(req).toContain('msg8');
    expect(req).toContain('msg9');
    expect(req).not.toContain('msg7');
  });
});
