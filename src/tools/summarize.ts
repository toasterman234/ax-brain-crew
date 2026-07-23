import { ax } from '@ax-llm/ax';
import { createModelClient } from '../ai/clients.js';
import { getLogger } from '../observability/logger.js';

// summarize-then-store — condense a large tool result to 3–5 lines BEFORE it
// enters an agent's working context, keeping the live context small while the
// full text can be written to the vault separately.
//
// This is an INTERNAL helper, not a new agent. On this backend the summarizer is
// a real model round (deepseek-v4-pro via the proxy), so it costs ~one turn of
// latency — keep it cheap: short output, single forward, no tool loop.
//
// HOW A TOOL OPTS IN:
//   import { summarizeForContext } from './summarize.js';
//   const full = await someTool.fetch(...);        // the firehose (web page, Life OS dump, long recall)
//   const gist = await summarizeForContext(full);   // 3–5 lines back to the agent
//   // (optionally) write `full` to the vault via vault.write, return only `gist`.
// If summarization fails or the text is already short, the original text is
// returned unchanged so the tool never breaks.

const SHORT_ENOUGH_CHARS = 600;

export async function summarizeForContext(
  text: string,
  focus?: string,
): Promise<string> {
  const logger = getLogger();

  if (!text || text.trim().length === 0) return '';

  // Already small — no model round needed.
  if (text.length <= SHORT_ENOUGH_CHARS) return text;

  try {
    // Use the fast tier to keep it cheap; the model behind it is the proxy's
    // deepseek. Single forward, no tools, bounded output.
    const llm = createModelClient('fast');
    const summarizer = ax(
      `sourceText:string, focus:string -> summary:string "3 to 5 short lines capturing only the key facts, no preamble"`,
    );

    const result = await summarizer.forward(llm, {
      sourceText: text.slice(0, 8000),
      focus: focus ?? 'the most decision-relevant facts',
    });

    const summary = result?.summary?.trim();
    if (summary && summary.length > 0) {
      logger.info(
        { fromChars: text.length, toChars: summary.length },
        'summarizeForContext condensed a tool result',
      );
      return summary;
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'summarizeForContext failed; returning truncated original');
  }

  // Fallback: never break the calling tool — hand back a hard-truncated slice.
  return text.slice(0, SHORT_ENOUGH_CHARS) + '\n…[truncated]';
}
