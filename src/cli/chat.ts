import * as readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getConfig } from '../config.js';
import { getDb, insertFailedRun } from '../persistence/database.js';
import { initializeRuntime } from '../runtime/init.js';
import { dispatch } from '../runtime/dispatcher.js';
import type { ValidatedAgent } from '../registry/loader.js';

// Meta commands are handled locally by the REPL; everything else that starts
// with "/" is treated as an agent prefix and forwarded to the router.
const META_COMMANDS = new Set([
  'exit',
  'quit',
  'new',
  'reset',
  'help',
  'agents',
  'history',
]);

// How many prior turns to replay into each request. Caps token growth on long
// chats — the full transcript still lives in memory and in the run log.
const HISTORY_WINDOW = 16;

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  agentId?: string | null;
}

export type ParsedInput =
  | { kind: 'empty' }
  | { kind: 'meta'; command: string }
  | { kind: 'message'; explicitAgent: string | null; message: string };

/**
 * Classify a raw input line: a blank line, a REPL meta command, or a message
 * (optionally carrying an explicit `/agent` prefix). A leading slash that isn't
 * a meta command is forwarded as an agent token; `runChat` decides whether it
 * names a real agent (sticky switch) or an unknown one (router clarifies).
 */
export function parseChatInput(raw: string): ParsedInput {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'empty' };

  const prefix = trimmed.match(/^\/(\w+)\s*(.*)$/s);
  if (prefix) {
    const token = prefix[1]!.toLowerCase();
    const rest = prefix[2]!.trim();
    if (META_COMMANDS.has(token)) {
      return { kind: 'meta', command: token };
    }
    // Real agent → sticky switch. Unknown → forward so the router clarifies.
    return {
      kind: 'message',
      explicitAgent: token,
      message: rest,
    };
  }

  return { kind: 'message', explicitAgent: null, message: trimmed };
}

/**
 * Build the request string handed to `dispatch`. The routing agent (if any) must
 * stay at position 0 so the router's `/agent` prefix match still fires; the
 * conversation history and current message follow in a clearly delimited body.
 */
export function buildTurnRequest(
  transcript: ChatTurn[],
  routingAgent: string | null,
  message: string,
  window: number = HISTORY_WINDOW,
): string {
  const recent = transcript.slice(-window);
  let body: string;
  if (recent.length > 0) {
    const lines = recent.map((t) =>
      t.role === 'user'
        ? `You: ${t.text}`
        : `Assistant (${t.agentId ?? 'crew'}): ${t.text}`,
    );
    body = `## Conversation so far\n${lines.join('\n')}\n\n## Current message\n${message}`;
  } else {
    body = message;
  }
  return routingAgent ? `/${routingAgent} ${body}` : body;
}

const HELP = `
Commands:
  /<agent> <msg>   Talk to a specific agent (scribe, seeker, sorter, ...) and stick with them
  /new  /reset     Start a fresh conversation (clears memory)
  /agents          List available agents
  /history         Show this session's turns
  /help            Show this help
  /exit  /quit     Leave chat
Anything else is a message. The crew remembers the conversation and stays with
the last agent until you switch. Ctrl+C also exits.
`.trim();

/** Persist a single chat turn as a run row, mirroring the `ask` command's log. */
function logRun(
  db: Database.Database,
  sessionId: string,
  request: string,
  output: Awaited<ReturnType<typeof dispatch>>,
): void {
  const runId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO runs (id, session_id, started_at, completed_at, status,
       original_request, selected_route_type, selected_route_id,
       route_confidence, route_reason, final_response, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    sessionId,
    now,
    now,
    output.error || output.results.some((r) => r.status === 'failed')
      ? 'failed'
      : 'completed',
    request,
    output.route.routeType,
    output.route.routeId,
    output.route.confidence,
    output.route.reason,
    output.finalResponse.slice(0, 5000),
    // Persist the failure reason (previously always NULL). runs.error is the
    // durable record of why a turn failed — see root-cause-analysis-2026-07-19.
    output.error,
  );
}

export async function runChat(agents: ValidatedAgent[]): Promise<void> {
  const config = getConfig();
  const db = getDb();

  initializeRuntime();

  const agentIds = new Set(agents.map((a) => a.id));
  const sessionId = randomUUID();
  db.prepare(
    `INSERT INTO sessions (id, started_at, turn_count) VALUES (?, ?, 0)`,
  ).run(sessionId, new Date().toISOString());

  let transcript: ChatTurn[] = [];
  let stickyAgent: string | null = null;
  let turnCount = 0;

  console.log('Ax Brain Crew — chat. Type /help for commands, /exit to leave.');
  if (config.dryRun) {
    console.log('(DRY_RUN is on — writes are previewed, not saved.)');
  }
  console.log(`Session ${sessionId.slice(0, 8)}\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'you › ',
  });

  const finalize = () => {
    db.prepare(
      `UPDATE sessions SET ended_at = ?, turn_count = ? WHERE id = ?`,
    ).run(new Date().toISOString(), turnCount, sessionId);
  };

  rl.on('SIGINT', () => {
    rl.close();
  });

  // Handle one input line. Returns 'exit' to leave the loop; any other return
  // path falls through to a fresh prompt.
  const handleLine = async (parsed: ParsedInput): Promise<'exit' | void> => {
    if (parsed.kind === 'empty') return;

    if (parsed.kind === 'meta') {
      switch (parsed.command) {
        case 'exit':
        case 'quit':
          return 'exit';
        case 'new':
        case 'reset':
          transcript = [];
          stickyAgent = null;
          console.log('— fresh conversation —\n');
          return;
        case 'help':
          console.log(`${HELP}\n`);
          return;
        case 'agents':
          console.log(
            agents.map((a) => `  ${a.id} — ${a.description}`).join('\n') + '\n',
          );
          return;
        case 'history':
          if (transcript.length === 0) {
            console.log('No turns yet.\n');
          } else {
            for (const t of transcript) {
              const who = t.role === 'user' ? 'you' : t.agentId ?? 'crew';
              console.log(`  ${who}: ${t.text.slice(0, 100)}`);
            }
            console.log('');
          }
          return;
        default:
          return;
      }
    }

    // Explicit valid agent switches the sticky agent; an unknown slash is
    // forwarded verbatim so the router explains it (sticky unchanged).
    const explicitValid =
      parsed.explicitAgent && agentIds.has(parsed.explicitAgent)
        ? parsed.explicitAgent
        : null;
    const routingAgent = explicitValid ?? parsed.explicitAgent ?? stickyAgent;

    const request = buildTurnRequest(transcript, routingAgent, parsed.message);

    let output: Awaited<ReturnType<typeof dispatch>>;
    try {
      // confirmationText is the raw latest user message — the approval gate
      // checks THIS, never the assembled `request` (which carries the transcript
      // and would poison the proceed check).
      output = await dispatch({
        request,
        agents,
        confirmationText: parsed.message,
      });
    } catch (err) {
      // dispatch() catches internally, but if it ever throws, never let the turn
      // vanish from the run log — persist a finalized failed row, mirroring `ask`
      // (B1a). No 'started' row was pre-inserted here, so write a complete one.
      insertFailedRun({
        runId: randomUUID(),
        sessionId,
        request,
        error: String(err),
      });
      console.error(`\n⚠ ${String(err)}\n`);
      return;
    }

    logRun(db, sessionId, request, output);
    turnCount += 1;

    const chosen = output.route.routeId ?? null;
    if (chosen && agentIds.has(chosen)) {
      stickyAgent = chosen;
    } else if (explicitValid) {
      stickyAgent = explicitValid;
    }

    transcript.push({ role: 'user', text: parsed.message });
    transcript.push({
      role: 'assistant',
      text: output.finalResponse,
      agentId: chosen,
    });

    const label = chosen ?? 'crew';
    console.log(`\n${label} › ${output.finalResponse}`);

    const changed = output.results.flatMap((r) => r.changedFiles);
    for (const f of changed) {
      console.log(`  ${config.dryRun ? '🔍' : '✏️'} ${f.operation} ${f.path}`);
    }
    for (const w of output.warnings) console.log(`  ⚠ ${w}`);
    console.log('');
  };

  // Buffer every line the instant it arrives so none are lost while a turn's
  // async dispatch is in flight. (readline's async iterator drops lines that
  // arrive mid-await on non-TTY input — this queue avoids that.)
  const queue: string[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  rl.on('line', (l) => {
    queue.push(l);
    wake?.();
    wake = null;
  });
  rl.on('close', () => {
    closed = true;
    wake?.();
    wake = null;
  });

  // Only prompt while the stream is open — piped input closes readline as soon
  // as it hits EOF, and prompting a closed interface throws ERR_USE_AFTER_CLOSE.
  const prompt = () => {
    if (!closed) rl.prompt();
  };

  try {
    prompt();
    while (true) {
      if (queue.length === 0) {
        if (closed) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const line = queue.shift()!;
      if ((await handleLine(parseChatInput(line))) === 'exit') break;
      prompt();
    }
  } finally {
    rl.close();
    finalize();
  }

  console.log(
    `\nSession ${sessionId.slice(0, 8)} saved — ${turnCount} turn(s). ` +
      `Inspect with: npm run crew -- show-session ${sessionId.slice(0, 8)}`,
  );
}
