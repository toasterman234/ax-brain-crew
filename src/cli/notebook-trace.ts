// Notebook runtime with SSE trace streaming for the visual lab.
// Provides a traced llm that emits SSE events when cells call ax()/agent().
// Imported by serve.ts.

import type { TraceEvent } from '../runtime/dispatcher.js';

export interface NotebookResult {
  result: unknown;
  richOutput?: { mermaid?: string; html?: string };
}

export type TraceEmitter = (type: string, data: unknown) => void;

/**
 * Wrap the real AxAI llm instance in a Proxy so any forward()/generate()/chat()
 * calls emit SSE trace events that the visual lab's trace panel can render.
 */
export function createTracedLlm(
  realLlm: unknown,
  emit: TraceEmitter,
): unknown {
  if (!realLlm || typeof realLlm !== 'object') return realLlm;

  return new Proxy(realLlm as object, {
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver);

      // Intercept ax().forward() / agent().forward() calls
      if (typeof val === 'function' && (
        prop === 'forward' || prop === 'generate' || prop === 'chat' || prop === 'stream'
      )) {
        return function tracedFn(this: unknown, ...args: unknown[]) {
          emit('tool_call', {
            kind: 'tool',
            tool: `ax.${String(prop)}`,
            args: getCallSummary(args),
          } satisfies TraceEvent);
          return (val as Function).apply(this, args);
        };
      }

      if (typeof val === 'function') {
        return (val as Function).bind(target);
      }
      return val;
    },
  });
}

function getCallSummary(args: unknown[]): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  if (args.length > 0) {
    const first = args[0];
    if (typeof first === 'string') {
      summary['input'] = first.length > 100 ? first.slice(0, 97) + '...' : first;
    } else if (first && typeof first === 'object') {
      const obj = first as Record<string, unknown>;
      const keys = Object.keys(obj).slice(0, 3);
      for (const k of keys) {
        const v = obj[k];
        const s = typeof v === 'string' ? v.slice(0, 50) : JSON.stringify(v).slice(0, 50);
        summary[k] = s;
      }
      if (Object.keys(obj).length > 3) summary['...'] = `+${Object.keys(obj).length - 3} more fields`;
    }
  }
  return summary;
}
