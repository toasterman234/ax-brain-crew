import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../config.js';
import { getDb, insertFailedRun } from '../persistence/database.js';
import { getLogger } from '../observability/logger.js';
import { initializeRuntime } from '../runtime/init.js';
import { dispatch, type TraceEvent } from '../runtime/dispatcher.js';
import { buildTurnRequest, type ChatTurn } from './chat.js';
import type { ValidatedAgent } from '../registry/loader.js';
import { TOOL_REGISTRY } from '../tools/index.js';
import { getAllSkills } from '../skills/executor.js';
import { getAllFlows, getFlow } from '../flows/registry.js';
import type { OrchestratorConfig } from '../composition/orchestrator-config.js';

// Side-effect imports: each flow file calls registerFlow() at module level
import '../flows/braindump-triage.js';
import '../flows/deep-clean.js';
import '../flows/defrag.js';
import '../flows/prior-art.js';
import '../flows/project-scaffold.js';
import '../flows/tag-garden.js';
import '../flows/triage-route.js';
import '../flows/vault-assess.js';
import '../flows/vault-audit.js';
import { getMemorySessions, searchMemory } from '../memory/client.js';

// The model id an OpenAI client sends selects the agent: "crew" (or "crew-auto")
// lets the classifier route; an agent id (e.g. "seeker") forces that specialist.
const AUTO_MODEL = 'crew';

// --- Bench (shared shelf) persistence ------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BENCH_PATH = resolve(__dirname, '..', '..', 'data', 'bench.json');

interface BenchArtifact {
  id: string;
  name: string;
  kind: string;
  spec: { inputs: Array<Record<string, unknown>>; outputs: Array<Record<string, unknown>> };
  axString: string;
  createdAt: number;
  updatedAt: number;
}

let _benchCache: BenchArtifact[] | null = null;

function loadBench(): BenchArtifact[] {
  if (_benchCache !== null) return _benchCache;
  try {
    if (!existsSync(BENCH_PATH)) {
      mkdirSync(dirname(BENCH_PATH), { recursive: true });
      writeFileSync(BENCH_PATH, '[]', 'utf-8');
      _benchCache = [];
      return [];
    }
    const raw = readFileSync(BENCH_PATH, 'utf-8');
    _benchCache = JSON.parse(raw) as BenchArtifact[];
    return _benchCache!;
  } catch {
    _benchCache = [];
    return [];
  }
}

function saveBench(artifacts: BenchArtifact[]): void {
  mkdirSync(dirname(BENCH_PATH), { recursive: true });
  writeFileSync(BENCH_PATH, JSON.stringify(artifacts, null, 2), 'utf-8');
  _benchCache = artifacts;
}

// --- Orchestrator config persistence (Slice O4) ----------------------

const ORCHESTRATORS_PATH = resolve(__dirname, '..', '..', 'data', 'orchestrators.json');

let _orchCache: OrchestratorConfig[] | null = null;

function loadOrchestrators(): OrchestratorConfig[] {
  if (_orchCache !== null) return _orchCache;
  try {
    if (!existsSync(ORCHESTRATORS_PATH)) {
      mkdirSync(dirname(ORCHESTRATORS_PATH), { recursive: true });
      writeFileSync(ORCHESTRATORS_PATH, '[]', 'utf-8');
      _orchCache = [];
      return [];
    }
    const raw = readFileSync(ORCHESTRATORS_PATH, 'utf-8');
    _orchCache = JSON.parse(raw) as OrchestratorConfig[];
    return _orchCache!;
  } catch {
    _orchCache = [];
    return [];
  }
}

function saveOrchestrators(configs: OrchestratorConfig[]): void {
  mkdirSync(dirname(ORCHESTRATORS_PATH), { recursive: true });
  writeFileSync(ORCHESTRATORS_PATH, JSON.stringify(configs, null, 2), 'utf-8');
  _orchCache = configs;
}

// Active orchestrator config id — null means use the linear handoff chain (E3 default).
// Persisted to disk (not just server lifetime) so the E4 orchestrator survives a
// serve restart / deploy — otherwise a reload silently drops back to E3 one-shot
// routing (the exact "crew fix didn't take" / deploy-reload gap). Default seed is
// `orchestrator-v1` so a fresh install runs the conductor, not bare routing.
const ACTIVE_ORCH_PATH = resolve(__dirname, '..', '..', 'data', 'active-orchestrator.json');
const DEFAULT_ACTIVE_ORCHESTRATOR_ID = 'orchestrator-v1';

function loadActiveOrchestratorId(): string | null {
  try {
    if (!existsSync(ACTIVE_ORCH_PATH)) return DEFAULT_ACTIVE_ORCHESTRATOR_ID;
    const raw = readFileSync(ACTIVE_ORCH_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { activeId?: string | null };
    // `activeId: null` on disk is an explicit "E3 off" choice — respect it.
    return parsed.activeId ?? null;
  } catch {
    return DEFAULT_ACTIVE_ORCHESTRATOR_ID;
  }
}

function saveActiveOrchestratorId(id: string | null): void {
  try {
    mkdirSync(dirname(ACTIVE_ORCH_PATH), { recursive: true });
    writeFileSync(ACTIVE_ORCH_PATH, JSON.stringify({ activeId: id }, null, 2), 'utf-8');
  } catch {
    // Non-fatal — persistence is best-effort; in-memory value still applies.
  }
}

let _activeOrchestratorId: string | null = loadActiveOrchestratorId();

function getActiveOrchestratorConfig(): OrchestratorConfig | null {
  if (!_activeOrchestratorId) return null;
  const configs = loadOrchestrators();
  return configs.find((c) => c.id === _activeOrchestratorId) ?? null;
}

interface SignatureEvalCase {
  input: Record<string, unknown>;
  expected?: Record<string, unknown>;
}

interface SignatureEvalResult {
  input: Record<string, unknown>;
  output?: unknown;
  expected?: Record<string, unknown>;
  pass?: boolean;
  score?: number;
  error?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function scoreExpectedKeys(actual: unknown, expected: unknown): { matched: number; total: number } {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return { matched: 0, total: expected.length || 1 };
    }
    return expected.reduce(
      (acc, item, index) => {
        const next = scoreExpectedKeys(actual[index], item);
        return { matched: acc.matched + next.matched, total: acc.total + next.total };
      },
      { matched: 0, total: expected.length || 1 },
    );
  }

  if (isPlainObject(expected)) {
    const entries = Object.entries(expected);
    if (entries.length === 0) return { matched: 1, total: 1 };
    if (!isPlainObject(actual)) return { matched: 0, total: entries.length };
    return entries.reduce(
      (acc, [key, value]) => {
        const next = scoreExpectedKeys(actual[key], value);
        return { matched: acc.matched + next.matched, total: acc.total + next.total };
      },
      { matched: 0, total: 0 },
    );
  }

  return { matched: Object.is(actual, expected) ? 1 : 0, total: 1 };
}

function scoreExpectedRatio(actual: unknown, expected: Record<string, unknown>): number {
  const score = scoreExpectedKeys(actual, expected);
  return score.total === 0 ? 0 : score.matched / score.total;
}

/**
 * Compile a user-supplied metric string into a scoring function.
 * The string must be the body of a function taking (output, expected) and
 * returning a number (usually 0–1). Returns undefined if metric is empty/null.
 */
function compileScoringFn(
  metric: string | undefined | null,
): ((output: unknown, expected: Record<string, unknown>) => number) | undefined {
  if (!metric?.trim()) return undefined;
  try {
    return new Function('output', 'expected', metric) as (
      output: unknown,
      expected: Record<string, unknown>,
    ) => number;
  } catch {
    // Invalid function body — fall back to scoreExpectedRatio.
    return undefined;
  }
}

// Connectivity checks (Copilot's "Verify" button, health probes) that must
// answer instantly — a full crew turn takes ~15s and would trip their timeout.
const PROBE_MESSAGES = new Set([
  'hi',
  'hey',
  'hello',
  'hello world',
  'test',
  'testing',
  'test message',
  'ping',
  'are you there',
  'say hi',
  'say this is a test',
  'this is a test',
  '1',
]);

function isProbe(plan: DispatchPlan): boolean {
  if (plan.hasHistory) return false;
  const normalized = plan.message.trim().toLowerCase().replace(/[.!?]+$/, '');
  return normalized.length <= 2 || PROBE_MESSAGES.has(normalized);
}

const PROBE_REPLY =
  '✅ Ax Brain Crew connected. Send a real request to reach the agents (routing takes a few seconds).';

// GUI clients (Copilot) fire a hidden "name this conversation" request; answer
// it instantly from the first user line instead of running the whole crew.
function isTitleRequest(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('generate a concise title') ||
    m.includes('title for this conversation') ||
    m.includes('short title') && m.includes('conversation')
  );
}

function quickTitle(message: string): string {
  const firstUser = message.match(/user:\s*(.+)/i)?.[1]?.trim();
  const basis = (firstUser || message).replace(/[\n\r"]+/g, ' ').trim();
  const words = basis.split(/\s+/).slice(0, 5).join(' ');
  return words || 'Crew chat';
}

interface OpenAiMessage {
  role: string;
  content: unknown;
}

// OpenAI content may be a plain string or an array of parts
// ([{type:'text', text:'...'}]) — Copilot sends the latter. Flatten to text so
// the crew sees the real message instead of "[object Object]".
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

interface OpenAiChatBody {
  model?: string;
  messages?: OpenAiMessage[];
  stream?: boolean;
}

export interface DispatchPlan {
  model: string;
  routingAgent: string | null;
  request: string;
  message: string;
  hasHistory: boolean;
  stream: boolean;
}

/**
 * Translate an OpenAI Chat Completions body into a single crew request. The last
 * user message is the current turn; earlier messages become conversation history
 * (system messages are dropped — agents carry their own instructions). The model
 * id, when it names a registered agent, forces routing to that agent.
 */
export function planFromOpenAi(
  body: OpenAiChatBody,
  agentIds: Set<string>,
): DispatchPlan {
  const model = body.model?.trim() || AUTO_MODEL;
  const messages = Array.isArray(body.messages) ? body.messages : [];

  const conversational = messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant',
  );
  let lastUserIdx = -1;
  for (let i = conversational.length - 1; i >= 0; i--) {
    if (conversational[i]!.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  const message =
    lastUserIdx >= 0 ? contentToText(conversational[lastUserIdx]!.content) : '';
  const priorMessages =
    lastUserIdx >= 0 ? conversational.slice(0, lastUserIdx) : conversational;

  const transcript: ChatTurn[] = priorMessages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    text: contentToText(m.content),
  }));

  const routingAgent = agentIds.has(model) ? model : null;
  const request = buildTurnRequest(transcript, routingAgent, message);

  return {
    model,
    routingAgent,
    request,
    message,
    hasHistory: transcript.length > 0,
    stream: body.stream === true,
  };
}

// Memoized cell state — variables persist between cells
const cellState: Record<string, unknown> = {};

// Stores the last GEPA optimize result for the save endpoint
let _lastOptimizeResult: unknown = null;

// Evolve concurrency guard — only one evolve per agent at a time
const _evolving = new Set<string>();

// Stores loaded flow datasets in memory


interface NotebookResult {
  result: unknown;
  richOutput?: { mermaid?: string; html?: string };
}

// Lazily-imported ax modules for the notebook runtime
let _axModule: typeof import('@ax-llm/ax') | null = null;
let _llmInstance: any = null;

async function getAxForNotebook(): Promise<{
  ax: typeof import('@ax-llm/ax').ax;
  ai: typeof import('@ax-llm/ax').ai;
  agent: typeof import('@ax-llm/ax').agent;
  llm: any;
}> {
  if (!_axModule) {
    _axModule = await import('@ax-llm/ax');
  }
  if (!_llmInstance) {
    const config = getConfig();
    _llmInstance = _axModule.ai({
      name: 'openai' as const,
      apiKey: config.proxyApiKey,
      apiURL: config.proxyBaseUrl,
      config: { model: config.modelTiers.smart as any },
    }) as any;
  }
  return {
    ax: _axModule.ax,
    ai: _axModule.ai,
    agent: _axModule.agent,
    llm: _llmInstance,
  };
}

function createEvalLlm(modAx: typeof import('@ax-llm/ax')): any {
  const config = getConfig();
  const useReflection = Boolean(config.reflectionApiKey);
  return modAx.ai({
    name: 'openai' as const,
    apiKey: useReflection ? config.reflectionApiKey : config.proxyApiKey,
    apiURL: useReflection ? config.reflectionBaseUrl : config.proxyBaseUrl,
    config: {
      model: (useReflection ? config.reflectionModel : config.modelTiers.fast) as any,
    },
  }) as any;
}

async function runNotebookCell(code: string): Promise<NotebookResult> {
  const trimmed = code.trim();

  // Determine if this is a simple expression or block of statements
  const isSimpleExpr = !/^(const |let |var |if |for |while |function |import |export |class |switch |try |throw |return |await |\{|\/\/)/.test(trimmed)
    && !trimmed.includes(';')
    && !trimmed.includes('\n');

  let body: string;
  if (isSimpleExpr) {
    body = `return (${trimmed})`;
  } else {
    const lines = trimmed.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line || line.startsWith('//')) continue;
      if (!/^(const |let |var |if |for |while |function |import |export |class |switch |try |throw |return |await |\}|\{|\/\/)/.test(line)) {
        lines[i] = `return (${line})`;
        break;
      }
    }
    body = lines.join('\n');
  }

  try {
    const { ax, ai, agent, llm } = await getAxForNotebook();

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const rawResult = await new Function(
      '$$', 'ax', 'ai', 'agent', 'llm',
      `return (async () => {
${body}
})()`,
    )(cellState, ax, ai, agent, llm);

    if (rawResult !== undefined) {
      cellState._last = rawResult;
    }

    // Check for Jupyter-style display convention
    if (rawResult && typeof rawResult === 'object' &&
        Symbol.for('Jupyter.display') in (rawResult as Record<symbol, unknown>)) {
      const displayFn = (rawResult as Record<symbol, () => Record<string, string>>)[
        Symbol.for('Jupyter.display')
      ];
      if (typeof displayFn === 'function') {
        const display = displayFn();
        const mermaidRaw = display['text/markdown'];
        return {
          result: rawResult,
          richOutput: {
            mermaid: (typeof mermaidRaw === 'string' && mermaidRaw.startsWith('```mermaid'))
              ? mermaidRaw.replace(/```mermaid\n?/g, '').replace(/```/g, '').trim()
              : undefined,
            html: display['text/html'],
          },
        };
      }
    }

    return { result: rawResult };
  } catch (err) {
    return { result: null, richOutput: { html: `<pre style="color:#e17055">${String(err)}</pre>` } };
  }
}

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function upsertDatasetCases(
  datasetId: string,
  incomingCases: Array<Record<string, unknown>>,
  meta?: { name?: string; description?: string; flowId?: string },
): Promise<{ path: string; caseCount: number; dataset: Record<string, unknown> }> {
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const filePath = resolve(process.cwd(), 'tests', 'fixtures', `${datasetId}.json`);

  let existing: Record<string, unknown> = {
    flowId: meta?.flowId ?? datasetId.replace('-cases', ''),
    cases: [],
  };

  if (existsSync(filePath)) {
    existing = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  }

  const existingCases = Array.isArray(existing.cases) ? existing.cases as Array<Record<string, unknown>> : [];
  const existingMap = new Map(existingCases.map((c) => [String(c.id), c]));
  for (const c of incomingCases) {
    existingMap.set(String(c.id), c);
  }

  existing.cases = Array.from(existingMap.values());

  if (meta?.name) existing.name = meta.name;
  if (meta?.description) existing.description = meta.description;
  if (meta?.flowId) existing.flowId = meta.flowId;

  writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf8');
  return { path: filePath, caseCount: existingMap.size, dataset: existing };
}

function buildDatasetCaseFromRun(
  run: {
    id: string;
    original_request: string;
    selected_route_type: string | null;
    selected_route_id: string | null;
    final_response: string | null;
    error?: string | null;
    status?: string;
  },
  kind: 'baseline' | 'regression' = 'baseline',
): { datasetId: string; datasetType: 'router' | 'flow'; caseData: Record<string, unknown> } {
  if (!run.selected_route_id) {
    throw new Error('Run has no selected route id');
  }

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const prefix = kind === 'regression' ? 'regression' : 'capture';
  const failureNote = run.error ?? run.final_response ?? '';

  if (run.selected_route_type === 'flow') {
    const datasetId = `${run.selected_route_id}-cases`;
    const responseSnippet = (run.final_response ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const expected =
      kind === 'regression'
        ? { shouldSucceed: true }
        : responseSnippet
          ? { finalResponseIncludes: responseSnippet }
          : {};
    const metric =
      kind === 'regression'
        ? "function score(output, expected) {\n  const text = String(output?.finalResponse ?? '');\n  return text.trim().length > 0 ? 1 : 0;\n}"
        : "function score(output, expected) {\n  const text = String(output?.finalResponse ?? '');\n  const snippet = String(expected?.finalResponseIncludes ?? '').trim();\n  if (!text) return 0;\n  if (!snippet) return 0.5;\n  return text.includes(snippet) ? 1 : 0;\n}";

    return {
      datasetId,
      datasetType: 'flow',
      caseData: {
        id: `${run.selected_route_id}-${prefix}-${stamp}`,
        sourceRunId: run.id,
        sourceStatus: run.status ?? null,
        regression: kind === 'regression',
        note: kind === 'regression' ? failureNote : undefined,
        input: run.original_request,
        expected,
        metric,
      },
    };
  }

  return {
    datasetId: 'routing-cases',
    datasetType: 'router',
    caseData: {
      id: `${run.selected_route_id}-${prefix}-${stamp}`,
      sourceRunId: run.id,
      sourceStatus: run.status ?? null,
      regression: kind === 'regression',
      note: kind === 'regression' ? failureNote : undefined,
      request: run.original_request,
      expectedAgent: run.selected_route_id,
    },
  };
}

function modelsPayload(agents: ValidatedAgent[]): unknown {
  const ids = [AUTO_MODEL, ...agents.map((a) => a.id)];
  return {
    object: 'list',
    data: ids.map((id) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'ax-brain-crew',
    })),
  };
}

function completionPayload(model: string, content: string): unknown {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// --- Server-Sent Events (streaming) primitives -----------------------------

function sseOpen(res: ServerResponse): { id: string; created: number } {
  cors(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  return { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000) };
}

function sseDelta(
  res: ServerResponse,
  ctx: { id: string; created: number },
  model: string,
  delta: Record<string, unknown>,
): void {
  res.write(
    `data: ${JSON.stringify({
      id: ctx.id,
      object: 'chat.completion.chunk',
      created: ctx.created,
      model,
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`,
  );
}

function sseFinish(
  res: ServerResponse,
  ctx: { id: string; created: number },
  model: string,
): void {
  res.write(
    `data: ${JSON.stringify({
      id: ctx.id,
      object: 'chat.completion.chunk',
      created: ctx.created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

// One-shot streamed reply (probe/title fast-paths) — no live trace needed.
function streamCompletion(res: ServerResponse, model: string, content: string): void {
  const ctx = sseOpen(res);
  sseDelta(res, ctx, model, { role: 'assistant', content });
  sseFinish(res, ctx, model);
}

// Whether to prepend a "what the agent did" trace to answers. On by default;
// set CREW_TRACE=0 to hide it.
const TRACE_ENABLED = process.env.CREW_TRACE !== '0';

function compactArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  try {
    const s = JSON.stringify(args);
    return s.length > 80 ? `${s.slice(0, 79)}…` : s;
  } catch {
    return '';
  }
}

// Render a trace event as one human line, or null to skip it.
function formatEvent(e: TraceEvent): string | null {
  if (e.kind === 'route') {
    return `🧭 routed to **${e.agent}**${e.detail ? ` — ${e.detail}` : ''}`;
  }
  if (e.kind === 'tool') {
    return `🔧 ${e.tool} ${compactArgs(e.args)}`.trimEnd();
  }
  return null; // 'agent' events are implied by the route line
}

function bumpSession(sessionId: string): void {
  getDb()
    .prepare(
      `UPDATE sessions SET turn_count = turn_count + 1, ended_at = ? WHERE id = ?`,
    )
    .run(new Date().toISOString(), sessionId);
}

function logRun(
  sessionId: string,
  request: string,
  output: Awaited<ReturnType<typeof dispatch>>,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO runs (id, session_id, started_at, completed_at, status,
       original_request, selected_route_type, selected_route_id,
       route_confidence, route_reason, final_response, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
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
    // Persist the failure reason (previously always NULL) — see
    // root-cause-analysis-2026-07-19.
    output.error,
  );
}

export async function runServe(agents: ValidatedAgent[], opts?: { demoMode?: boolean }): Promise<void> {
  const config = getConfig();
  const logger = getLogger();
  const port = Number(process.env.CREW_SERVE_PORT ?? 8788);
  const demoMode = opts?.demoMode ?? config.demoMode;
  const agentIds = new Set(agents.map((a) => a.id));

  if (demoMode) {
    logger.info('🧪 Demo mode enabled — using demo registry, vault is optional');
    // Auto-configure demo vault if no vault path is set
    if (!config.obsidianVaultPath) {
      const demoVaultPath = resolve(process.cwd(), 'demo-vault');
      if (!existsSync(demoVaultPath)) {
        mkdirSync(demoVaultPath, { recursive: true });
        logger.info({ path: demoVaultPath }, 'Created demo vault directory');
      }
      // Mutate config so vault tools work — this is a demo convenience override
      (config as any).obsidianVaultPath = demoVaultPath;
      logger.info({ path: demoVaultPath }, 'Demo vault configured (set OBSIDIAN_VAULT_PATH to override)');
    }
  }

  initializeRuntime();

  // Lazy session: created on first chat request, not at startup.
  // This avoids accumulating empty sessions from cold starts.
  let sessionId: string | null = null;
  function ensureSession(): string {
    if (!sessionId) {
      sessionId = randomUUID();
      getDb()
        .prepare(`INSERT INTO sessions (id, started_at, turn_count) VALUES (?, ?, 0)`)
        .run(sessionId, new Date().toISOString());
    }
    return sessionId;
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '';

    if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
      sendJson(res, 200, modelsPayload(agents));
      return;
    }

    if (req.method === 'GET' && (url === '/' || url === '/health')) {
      sendJson(res, 200, { status: 'ok', service: 'ax-brain-crew', port });
      return;
    }

    if (
      req.method === 'POST' &&
      (url === '/v1/chat/completions' || url === '/chat/completions')
    ) {
      let body: OpenAiChatBody;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        sendJson(res, 400, {
          error: { message: 'Invalid JSON body', type: 'invalid_request_error' },
        });
        return;
      }

      const currentSessionId = ensureSession();
      const plan = planFromOpenAi(body, agentIds);
      if (!plan.request.trim()) {
        sendJson(res, 400, {
          error: {
            message: 'No user message found in request',
            type: 'invalid_request_error',
          },
        });
        return;
      }

      logger.info(
        {
          model: plan.model,
          routingAgent: plan.routingAgent,
          hasHistory: plan.hasHistory,
          probe: isProbe(plan),
          stream: plan.stream,
          userMsg: plan.message.slice(0, 120),
        },
        'serve.request',
      );

      // Answer connectivity probes instantly so client-side verify/timeouts pass.
      if (isProbe(plan)) {
        if (plan.stream) streamCompletion(res, plan.model, PROBE_REPLY);
        else sendJson(res, 200, completionPayload(plan.model, PROBE_REPLY));
        return;
      }

      // Instant reply to the GUI's hidden "name this chat" request.
      if (!plan.hasHistory && isTitleRequest(plan.message)) {
        const title = quickTitle(plan.message);
        if (plan.stream) streamCompletion(res, plan.model, title);
        else sendJson(res, 200, completionPayload(plan.model, title));
        return;
      }

      // Collect the trace during dispatch. For streaming clients (visual lab),
      // emit each event IMMEDIATELY so the trace panel updates live. For
      // non-streaming clients (Copilot in CORS mode), buffer everything and
      // deliver as a single final block.
      const traceLines: string[] = [];
      const traceEvents: TraceEvent[] = [];

      // For streaming clients, open the stream now and heartbeat while the crew
      // works so the connection isn't aborted during the long (~15-40s) turn.
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let sseCtx: { id: string; created: number } | null = null;
      if (plan.stream) {
        sseCtx = sseOpen(res);
        sseDelta(res, sseCtx, plan.model, { role: 'assistant', content: '' });
        heartbeat = setInterval(() => {
          try {
            res.write(': keep-alive\n\n');
          } catch {
            /* client gone */
          }
        }, 5000);
      }

      const onEvent = TRACE_ENABLED
        ? (e: TraceEvent) => {
            traceEvents.push(e);
            const line = formatEvent(e);
            if (line) traceLines.push(line);
            // Emit LIVE to the SSE stream so the visual lab trace panel
            // updates while the agent thinks — no more post-hoc dump.
            if (sseCtx) {
              const eventName =
                e.kind === 'route' ? 'route_decision' :
                e.kind === 'langfuse' ? 'langfuse' :
                'tool_call';
              res.write(`event: ${eventName}\ndata: ${JSON.stringify(e)}\n\n`);
            }
          }
        : undefined;

      try {
        const output = await dispatch({
          request: plan.request,
          agents,
          // Approval gate checks the raw latest user message only, never the
          // assembled request (which prepends the transcript and would poison
          // the proceed check).
          confirmationText: plan.message,
          onEvent,
          traceMeta: { sessionId: currentSessionId, source: 'copilot' },
          activeOrchestratorConfig: getActiveOrchestratorConfig(),
        });
        if (heartbeat) clearInterval(heartbeat);
        logRun(currentSessionId, plan.request, output);
        bumpSession(currentSessionId);

        const label = output.route.routeId ?? plan.model;
        const trace =
          traceLines.length > 0
            ? traceLines.map((l) => `> ${l}`).join('\n') + '\n\n'
            : '';
        const content = `${trace}**[${label}]** ${output.finalResponse}`;

        if (sseCtx) {
          sseDelta(res, sseCtx, plan.model, { content });
          sseFinish(res, sseCtx, plan.model);
        } else {
          sendJson(res, 200, completionPayload(plan.model, content));
        }
      } catch (err) {
        if (heartbeat) clearInterval(heartbeat);
        // dispatch() catches internally, but if it ever throws, never let the
        // turn vanish from the run log — persist a finalized failed row,
        // mirroring `ask` (B1a). The normal path logs via logRun after dispatch
        // returns; this covers only the thrown case.
        insertFailedRun({
          runId: randomUUID(),
          sessionId: currentSessionId,
          request: plan.request,
          error: String(err),
        });
        logger.error({ err: String(err) }, 'serve.error');
        if (sseCtx) {
          sseDelta(res, sseCtx, plan.model, {
            content: `⚠️ ${String(err)}`,
          });
          sseFinish(res, sseCtx, plan.model);
        } else {
          sendJson(res, 500, {
            error: { message: String(err), type: 'server_error' },
          });
        }
      }
      return;
    }

    // Notebook eval endpoint — executes TypeScript cells with @ax-llm/ax pre-imported
    // Supports ?stream=1 for SSE mode (live trace in the visual lab)
    if (req.method === 'POST' && url.startsWith('/api/notebook/eval')) {
      const isStream = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`).searchParams.get('stream') === '1';
      try {
        const raw = await readBody(req);
        const { code } = JSON.parse(raw || '{}') as { code?: string };
        if (!code?.trim()) {
          if (isStream) {
            cors(res);
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.write('event: error\ndata: {"error":"code is required"}\n\n');
            res.end();
          } else {
            sendJson(res, 400, { error: 'code is required' });
          }
          return;
        }

        if (!isStream) {
          const result = await runNotebookCell(code);
          logger.info({ code: code.slice(0, 80), hasResult: result.result !== undefined }, 'notebook.eval');
          sendJson(res, 200, result);
          return;
        }

        // SSE streaming mode — for visual lab trace panel
        cors(res);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const emitTrace = (type: string, data: unknown) => {
          res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        emitTrace('route_decision', { kind: 'route', agent: 'notebook', detail: 'Executing notebook cell' });

        const result = await runNotebookCell(code);

        emitTrace('result', { result: result.result, richOutput: result.richOutput });
        res.end();
      } catch (err) {
        logger.error({ err: String(err) }, 'notebook.eval.error');
        if (isStream) {
          cors(res);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write(`event: error\ndata: {"error":"${String(err).replace(/"/g, '\\"')}"}\n\n`);
          res.end();
        } else {
          sendJson(res, 500, { error: String(err), result: null, richOutput: null });
        }
      }
      return;
    }

    // Eval suite — returns the labeled routing test cases
    if (req.method === 'GET' && url === '/api/eval/suite') {
      try {
        const { readFileSync } = await import('node:fs');
        const { resolve, dirname } = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const fixturePath = resolve(__dirname, '..', '..', 'tests', 'fixtures', 'routing-cases.json');
        const raw = readFileSync(fixturePath, 'utf-8');
        sendJson(res, 200, JSON.parse(raw));
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // Eval baseline — run routing cases through the live router
    if (req.method === 'POST' && url === '/api/eval/run') {
      try {
        const raw = await readBody(req);
        const { cases } = JSON.parse(raw || '{}') as {
          cases?: Array<{ id: string; expectedAgent: string; request: string }>;
        };
        if (!cases?.length) {
          sendJson(res, 400, { error: 'cases array is required' });
          return;
        }

        // Import routing inline to avoid circular deps
        const { scoreRouting } = await import('../evals/routing-metric.js');
        const { routeNatively } = await import('../composition/coordinator.js');

        const results: Array<{
          id: string;
          request: string;
          expectedAgent: string;
          selectedAgent: string;
          score: number;
        }> = [];

        for (const c of cases) {
          let selected = 'error';
          try {
            const route = await routeNatively(c.request, agents);
            selected = route.routedAgent;
          } catch {
            selected = 'error';
          }
          results.push({
            id: c.id,
            request: c.request,
            expectedAgent: c.expectedAgent,
            selectedAgent: selected,
            score: scoreRouting(selected, c.expectedAgent),
          });
        }

        const totalScore = results.reduce((s, r) => s + r.score, 0);
        const accuracy = results.length > 0 ? totalScore / results.length : 0;
        const byLabel: Record<string, { hit: number; n: number }> = {};
        for (const r of results) {
          const e = (byLabel[r.expectedAgent] ??= { hit: 0, n: 0 });
          e.n++;
          e.hit += r.score;
        }
        const misses = results.filter((r) => r.score === 0);

        sendJson(res, 200, {
          results,
          summary: {
            total: results.length,
            hits: totalScore,
            accuracy,
            byLabel,
            misses: misses.map((m) => ({
              id: m.id,
              expected: m.expectedAgent,
              got: m.selectedAgent,
              request: m.request,
            })),
          },
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // --- Flow Eval: run a flow against test cases (8A) ---
    if (req.method === 'POST' && url === '/api/eval/flow-run') {
      try {
        const raw = await readBody(req);
        const opts = JSON.parse(raw || '{}') as {
          flowId: string;
          cases: Array<{ id: string; input: any; expected?: any; metric?: string }>;
        };
        if (!opts.flowId || !opts.cases?.length) {
          sendJson(res, 400, { error: 'Missing flowId or cases' });
          return;
        }
        const flow = getFlow(opts.flowId);
        if (!flow) {
          sendJson(res, 404, { error: `Flow not found: ${opts.flowId}` });
          return;
        }

        // Stream SSE results
        cors(res);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const emit = (event: string, data: Record<string, unknown>) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        let hits = 0;
        const total = opts.cases.length;
        for (const c of opts.cases) {
          const t0 = Date.now();
          try {
            const runResult = await flow.run({
              request: typeof c.input === 'string' ? c.input : JSON.stringify(c.input),
              runId: `flow-eval-${opts.flowId}-${c.id}`,
              dryRun: true,
            });
            const durationMs = Date.now() - t0;

            let score = 1.0;
            if (c.metric && c.expected) {
              try {
                const metricFn = new Function('output', 'expected', `return (${c.metric})(output, expected);`);
                score = Number(metricFn(runResult, c.expected)) || 0;
              } catch {
                score = 0;
              }
            }
            if (score > 0.5) hits += 1;
            emit('result', { caseId: c.id, output: runResult.output, finalResponse: runResult.finalResponse, score, durationMs });
          } catch (err) {
            const durationMs = Date.now() - t0;
            emit('result', { caseId: c.id, error: String(err), score: 0, durationMs });
          }
        }
        emit('summary', { hits, total, accuracy: total > 0 ? hits / total : 0 });
        res.end();
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // --- Custom program eval (general-purpose) ---

    // POST /api/eval/program-run — run any ax() signature against cases (SSE stream)
    if (req.method === 'POST' && url === '/api/eval/program-run') {
      try {
        const raw = await readBody(req);
        const opts = JSON.parse(raw || '{}') as {
          axString?: string;
          cases?: Array<{ id: string; input: any; expected?: any }>;
          metric?: string;
        };
        if (!opts.axString?.trim()) {
          sendJson(res, 400, { error: 'axString is required' });
          return;
        }
        if (!opts.cases?.length) {
          sendJson(res, 400, { error: 'cases array is required' });
          return;
        }

        const modAx = await import('@ax-llm/ax');
        let program: any;
        try {
          program = modAx.ax(opts.axString);
        } catch (parseErr) {
          sendJson(res, 400, { error: `Invalid ax signature: ${String(parseErr)}` });
          return;
        }

        const scoringFn = compileScoringFn(opts.metric);
        const llm = createEvalLlm(modAx);

        cors(res);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const emit = (event: string, data: Record<string, unknown>) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        let hits = 0;
        let labeled = 0;
        const total = opts.cases.length;
        const collected: unknown[] = [];
        for (const testCase of opts.cases) {
          const t0 = Date.now();
          try {
            const output = await program.forward(llm, testCase.input ?? {});
            const durationMs = Date.now() - t0;
            const expected = isPlainObject(testCase.expected) ? testCase.expected : undefined;
            const score = expected && scoringFn ? scoringFn(output, expected) : undefined;
            if (expected) {
              labeled++;
              if (score !== undefined && score > 0.5) hits++;
            }
            const entry = {
              caseId: testCase.id,
              output: typeof output === 'object' ? output : { value: output },
              expected: expected ?? null,
              score: score ?? null,
              durationMs,
            };
            collected.push(entry);
            emit('result', entry as Record<string, unknown>);
          } catch (err) {
            const durationMs = Date.now() - t0;
            const entry = { caseId: testCase.id, error: String(err), score: 0, durationMs };
            collected.push(entry);
            emit('result', entry as Record<string, unknown>);
          }
        }

        // Auto-save experiment
        const accuracy = labeled > 0 ? hits / labeled : 0;
        try {
          const { upsertExperiment, saveEvalRun } = await import('../persistence/eval-experiments.js');
          const exp = upsertExperiment({
            axString: opts.axString,
            targetType: 'custom',
            metric: opts.metric ?? null,
          });
          saveEvalRun({
            experimentId: exp.id,
            mode: 'baseline',
            accuracy,
            hits,
            total: labeled,
            results: collected,
          });
        } catch { /* persistence is best-effort */ }

        emit('summary', { hits, labeled, total, accuracy });
        res.end();
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/eval/program-optimize — GEPA-optimize any ax() signature
    if (req.method === 'POST' && url === '/api/eval/program-optimize') {
      try {
        const raw = await readBody(req);
        const opts = JSON.parse(raw || '{}') as {
          axString?: string;
          cases?: Array<{ id: string; input: any; expected?: any }>;
          metric?: string;
          maxMetricCalls?: number;
        };
        if (!opts.axString?.trim()) {
          sendJson(res, 400, { error: 'axString is required' });
          return;
        }

        const labeledCases = (opts.cases ?? []).filter(
          (testCase) => isPlainObject(testCase.input) && isPlainObject(testCase.expected),
        ) as Array<{ id: string; input: Record<string, unknown>; expected: Record<string, unknown> }>;
        if (labeledCases.length < 2) {
          sendJson(res, 400, { error: 'At least two labeled cases are required to optimize' });
          return;
        }

        const scoringFn = compileScoringFn(opts.metric) ?? scoreExpectedRatio;
        const maxMetricCalls = opts.maxMetricCalls ?? 20;

        const validationCount = labeledCases.length >= 4 ? Math.max(1, Math.floor(labeledCases.length / 4)) : 1;
        const trainCases = labeledCases.slice(0, labeledCases.length - validationCount);
        const validationCases = labeledCases.slice(labeledCases.length - validationCount);

        const config = getConfig();
        const modAx = await import('@ax-llm/ax');
        const studentAI = createEvalLlm(modAx);
        const teacherAI = modAx.ai({
          name: 'openai' as const,
          apiKey: config.reflectionApiKey || config.proxyApiKey,
          apiURL: config.reflectionApiKey ? config.reflectionBaseUrl : config.proxyBaseUrl,
          config: {
            model: (config.reflectionApiKey ? config.reflectionModel : config.modelTiers.smart) as any,
          },
        }) as any;

        // Baseline
        const baselineProgram = modAx.ax(opts.axString);
        let beforeHits = 0;
        for (const testCase of validationCases) {
          try {
            const output = await baselineProgram.forward(studentAI, testCase.input);
            if (scoringFn(output, testCase.expected) === 1) beforeHits++;
          } catch { /* miss */ }
        }

        // GEPA
        const trainExamples = trainCases.map((testCase) => ({
          ...testCase.input,
          ...testCase.expected,
          __expected: testCase.expected,
        }));
        const validationExamples = validationCases.map((testCase) => ({
          ...testCase.input,
          ...testCase.expected,
          __expected: testCase.expected,
        }));

        const program = modAx.ax(opts.axString);
        const optimizeResult = await modAx.optimize(
          program,
          trainExamples,
          ({ prediction, example }: any) =>
            scoringFn(prediction, (example?.__expected ?? {}) as Record<string, unknown>),
          {
            studentAI,
            teacherAI,
            validationExamples,
            maxMetricCalls,
            numTrials: 8,
            minibatch: trainExamples.length > 4,
            minibatchSize: Math.min(4, trainExamples.length),
            earlyStoppingTrials: 3,
            sampleCount: 1,
            seed: 42,
          },
        );

        // Re-eval with optimized program
        const optimizedProgram = modAx.ax(opts.axString);
        if (optimizeResult.optimizedProgram) {
          optimizedProgram.applyOptimization(optimizeResult.optimizedProgram);
        }

        let afterHits = 0;
        for (const testCase of validationCases) {
          try {
            const output = await optimizedProgram.forward(studentAI, testCase.input);
            if (scoringFn(output, testCase.expected) === 1) afterHits++;
          } catch { /* miss */ }
        }

        // Auto-save experiment + result
        const afterAccuracy = validationCases.length > 0 ? afterHits / validationCases.length : 0;
        try {
          const { upsertExperiment, saveEvalRun } = await import('../persistence/eval-experiments.js');
          const exp = upsertExperiment({
            axString: opts.axString,
            targetType: 'custom',
            metric: opts.metric ?? null,
          });
          saveEvalRun({
            experimentId: exp.id,
            mode: 'optimize',
            accuracy: afterAccuracy,
            hits: afterHits,
            total: validationCases.length,
            results: [{ before: beforeHits, after: afterHits, total: validationCases.length }],
          });
        } catch { /* persistence is best-effort */ }

        sendJson(res, 200, {
          before: {
            hits: beforeHits,
            total: validationCases.length,
            pct: ((beforeHits / validationCases.length) * 100).toFixed(1),
          },
          after: {
            hits: afterHits,
            total: validationCases.length,
            pct: ((afterHits / validationCases.length) * 100).toFixed(1),
          },
          delta: afterHits - beforeHits,
          trainCases: trainCases.length,
          validationCases: validationCases.length,
          optimizedProgram: optimizeResult.optimizedProgram
            ? modAx.axSerializeOptimizedProgram(optimizeResult.optimizedProgram)
            : null,
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // --- Agent eval (visual-lab-flow-agent-eval §3) ---
    // POST /api/eval/agent-run — evaluate an agent by running prompts through dispatch
    if (req.method === 'POST' && url === '/api/eval/agent-run') {
      try {
        const raw = await readBody(req);
        const opts = JSON.parse(raw || '{}') as {
          agentId?: string;
          cases?: Array<{ id: string; prompt: string; expected?: string }>;
          metric?: string;
        };

        if (!opts.agentId) { sendJson(res, 400, { error: 'agentId is required' }); return; }
        if (!opts.cases?.length) { sendJson(res, 400, { error: 'cases array is required' }); return; }

        const agent = agents.find((a) => a.id === opts.agentId);
        if (!agent) { sendJson(res, 404, { error: `Agent '${opts.agentId}' not found` }); return; }

        const actualCases = opts.cases.slice(0, 10); // safety cap

        // Compile scoring function
        let scoringFn: (output: string, expected: string) => number;
        try {
          scoringFn = new Function('output', 'expected', `
            ${opts.metric || 'return output.includes(expected) ? 1 : 0'}
          `) as (output: string, expected: string) => number;
        } catch {
          scoringFn = (output: string, expected: string) => output.includes(expected) ? 1 : 0;
        }

        cors(res);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });

        let hits = 0;
        let labeled = 0;

        for (const testCase of actualCases) {
          const start = Date.now();
          let response = '';
          let error: string | null = null;

          try {
            const output = await dispatch({
              request: testCase.prompt,
              agents,
              confirmationText: testCase.prompt,
            });
            response = output.finalResponse;
          } catch (err) {
            error = String(err);
          }

          let score: number | null = null;
          if (testCase.expected && !error) {
            labeled++;
            score = scoringFn(response, testCase.expected);
            if (score === 1) hits++;
          }

          const durationMs = Date.now() - start;
          res.write(
            `event: result\ndata: ${JSON.stringify({
              caseId: testCase.id,
              output: error ? null : response,
              error,
              score,
              durationMs,
            })}\n\n`,
          );
        }

        const accuracy = labeled > 0 ? hits / labeled : 0;

        // Auto-save experiment
        try {
          const { upsertExperiment, saveEvalRun } = await import('../persistence/eval-experiments.js');
          const exp = upsertExperiment({
            axString: `agent:${opts.agentId}`,
            targetType: 'agent',
            targetId: opts.agentId,
            metric: opts.metric ?? null,
          });
          saveEvalRun({
            experimentId: exp.id,
            mode: 'baseline',
            accuracy,
            hits,
            total: labeled,
            results: actualCases.map((c) => ({ caseId: c.id })),
          });
        } catch { /* best-effort */ }

        res.write(
          `event: summary\ndata: ${JSON.stringify({
            hits,
            total: actualCases.length,
            labeled,
            accuracy,
          })}\n\n`,
        );
        res.end();
        return;
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // --- Experiment persistence (visual-lab-general-eval §3) ---

    // GET /api/eval/experiments — list experiments, optionally filtered by targetId/type
    if (req.method === 'GET' && url.split('?')[0] === '/api/eval/experiments') {
      try {
        const { listExperiments } = await import('../persistence/eval-experiments.js');
        const params = new URL(url, `http://localhost:${port}`).searchParams;
        const targetId = params.get('targetId');
        const targetType = params.get('targetType');
        const filters = targetId && targetType ? { targetId, targetType } : targetType ? { targetType } : undefined;
        sendJson(res, 200, { experiments: listExperiments(filters) });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/eval/experiments/:id — single experiment with all runs
    if (req.method === 'GET' && url.startsWith('/api/eval/experiments/')) {
      const expId = url.split('/api/eval/experiments/')[1]?.split('?')[0];
      if (!expId) { sendJson(res, 400, { error: 'Missing experiment id' }); return; }
      try {
        const { getExperiment } = await import('../persistence/eval-experiments.js');
        const result = getExperiment(expId);
        if (!result) {
          sendJson(res, 404, { error: 'Experiment not found' });
          return;
        }
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // --- Eval Proposer: analyze recent runs and return candidate proposals ---
    if (req.method === 'POST' && url === '/api/eval-proposer/run') {
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw || '{}') as {
          target?: string;
          datasetId?: string;
          datasetType?: string;
          lookback?: number;
          maxCandidates?: number;
        };
        const target = body.target ?? 'incident-agent';
        const lookback = Math.min(body.lookback ?? 25, 100);
        const maxCandidates = Math.min(body.maxCandidates ?? 10, 50);
        const datasetId = body.datasetId ?? `${target}-cases`;
        const datasetType = body.datasetType ?? 'flow';

        // 1. Load existing dataset cases for deduplication
        let existingInputs: string[] = [];
        try {
          const { readFileSync: rfs, existsSync: exs } = await import('node:fs');
          const filePath = resolve(process.cwd(), 'tests', 'fixtures', `${datasetId}.json`);
          if (exs(filePath)) {
            const data = JSON.parse(rfs(filePath, 'utf8'));
            const cases = Array.isArray(data.cases) ? data.cases as Array<Record<string, unknown>> : [];
            existingInputs = cases.map((c) => {
              const inp = typeof c.input === 'string' ? c.input : (c.request as string);
              return (inp ?? '').trim();
            }).filter(Boolean);
          }
        } catch { /* dataset doesn't exist yet */ }

        // 2. Query recent runs for the target agent directly from SQLite
        const db = getDb();
        const runs = db.prepare(
          `SELECT id, original_request, final_response, error, status, started_at, completed_at
           FROM runs
           WHERE selected_route_id = ?
           ORDER BY started_at DESC
           LIMIT ?`,
        ).all(target, lookback) as Array<{
          id: string; original_request: string; final_response: string | null;
          error: string | null; status: string; started_at: string; completed_at: string | null;
        }>;

        if (runs.length === 0) {
          sendJson(res, 200, { candidates: [], warning: `No runs found for agent "${target}"` });
          return;
        }

        // 3. Build a compact text summary of runs for the agent
        const runsText = runs.map((r, i) => {
          const status = r.status === 'failed' ? 'FAILED' : 'OK';
          const excerpt = (r.final_response ?? r.error ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
          return `Run ${i + 1} [${status}] id=${r.id}\n  Request: ${r.original_request.slice(0, 200)}\n  Response: ${excerpt || '(empty)'}`;
        }).join('\n\n');

        const dedupeList = existingInputs.length > 0
          ? `\n## Already covered (do NOT propose these inputs)\n${existingInputs.map((s, i) => `${i + 1}. "${s.slice(0, 120)}"`).join('\n')}\n`
          : '\n## Already covered\n(No existing cases — this is a new dataset.)\n';

        const prompt = [
          '## Eval Proposal Task',
          '',
          `Analyze the ${lookback} most recent runs for agent "${target}", shown below.`,
          `Propose at most ${maxCandidates} new eval cases the current dataset does NOT cover.`,
          'Focus on failures, gaps, edge cases, and ambiguous routing.',
          '',
          'For each proposal:',
          '- For **input**, copy the request text VERBATIM from the run. No paraphrasing.',
          '- Write a 1-sentence rationale',
          '- Classify as: gap | regression | edge-case',
          '- Give a confidence score 0.0–1.0',
          '- Cite the sourceRunId from the run',
          '',
          dedupeList,
          '## Recent runs',
          runsText,
          '',
          'Return ONLY: {"proposals":[{"sourceRunId","input","expected":{},"rationale","kind","confidence"}]}',
          'Empty result: {"proposals":[]}',
        ].join('\n');

        // 4. Stream SSE: open the connection and emit live trace events
        cors(res);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const emit = (event: string, data: Record<string, unknown>) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        // Heartbeat so the connection doesn't timeout during the LLM turn
        const heartbeat = setInterval(() => {
          try { res.write(': keep-alive\n\n'); } catch { /* client gone */ }
        }, 5000);

        const onEvent = (e: TraceEvent) => {
          const eventName =
            e.kind === 'route' ? 'route_decision' :
            e.kind === 'langfuse' ? 'langfuse' :
            'tool_call';
          emit(eventName, e as unknown as Record<string, unknown>);
        };

        emit('route_decision', { kind: 'route', agent: 'eval-proposer', detail: 'Analyzing runs for proposals' });

        // Dispatch to the eval-proposer agent — runs are already in the prompt
        const output = await dispatch({
          request: `/eval-proposer\n\n${prompt}`,
          agents,
          onEvent,
          traceMeta: { sessionId: 'eval-proposer', source: 'eval-proposer-api' },
        });

        clearInterval(heartbeat);

        // 5. Parse the JSON response
        let proposals: Array<{
          sourceRunId: string;
          input: string;
          expected: Record<string, unknown>;
          rationale: string;
          kind: string;
          confidence: number;
        }> = [];

        try {
          let text = output.finalResponse;
          // Strip any markdown fence
          const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
          if (fenceMatch) text = fenceMatch[1]!;
          // Find a JSON object with proposals key
          const jsonMatch = text.match(/\{[\s\S]*"proposals"[\s\S]*\}/);
          if (jsonMatch) text = jsonMatch[0]!;
          const parsed = JSON.parse(text.trim());
          if (parsed && Array.isArray(parsed.proposals)) {
            proposals = parsed.proposals;
          }
        } catch {
          emit('error', { error: 'Could not parse agent response as JSON', rawResponse: output.finalResponse.slice(0, 2000) });
          res.end();
          return;
        }

        // 6. Server-side dedup: skip proposals whose input or sourceRunId already exists
        const dedupeInputSet = new Set(existingInputs.map((s) => s.replace(/\s+/g, ' ').toLowerCase()));
        const runInputs = new Map(runs.map((r) => [r.id, (r.original_request ?? '').trim().replace(/\s+/g, ' ').toLowerCase()]));
        const usedRunIds = new Set<string>();
        const filtered = proposals.filter((p) => {
          const norm = (p.input ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
          // Skip if input doesn't match any actual run's request text (model fabricated it)
          const actualRunText = runInputs.get(p.sourceRunId);
          if (actualRunText && !norm.includes(actualRunText) && !actualRunText.includes(norm)) {
            return false;
          }
          // Check if input text matches an existing case (normalized)
          for (const existing of dedupeInputSet) {
            if (norm === existing || norm.includes(existing) || existing.includes(norm)) {
              return false;
            }
          }
          // Check if we've already proposed this run ID in this batch
          if (usedRunIds.has(p.sourceRunId)) return false;
          usedRunIds.add(p.sourceRunId);
          return true;
        });

        // 7. Override input with actual DB text (model may paraphrase), then map to candidates
        const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        const candidates = filtered.map((p, i) => {
          // Use the real request text from the DB, not whatever the model wrote
          const realInput = runInputs.get(p.sourceRunId);
          const input = realInput ?? p.input;
          return {
            candidateId: `proposed-${stamp}-${i}`,
            datasetId,
            datasetType: datasetType as 'router' | 'flow',
            source: 'proposed' as const,
            sourceRef: p.sourceRunId,
            status: 'pending' as const,
            case: {
              id: `proposed-${stamp}-${i}`,
              input,
              expected: p.expected,
              regression: p.kind === 'regression',
              note: p.rationale,
              sourceRunId: p.sourceRunId,
              proposedKind: p.kind,
              proposedConfidence: p.confidence,
            },
          };
        });

        emit('result', { candidates });
        res.end();
      } catch (err) {
        try { res.write(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`); res.end(); } catch { /* client gone */ }
      }
      return;
    }

    // --- Eval pairs: list un-curated Slack candidates ---
    if (req.method === 'GET' && url.startsWith('/api/eval-pairs')) {
      try {
        const urlObj = new URL(url, `http://localhost:${port}`);
        const reviewed = urlObj.searchParams.get('reviewed') ?? '0';
        const limit = Math.min(Number(urlObj.searchParams.get('limit') ?? 100), 500);
        const db = getDb();
        const pairs = db.prepare(
          `SELECT id, kind, channel_id, thread_ts, prior_run_ts, input, output, signal, route_agent, trace_id, reviewed, created_at
           FROM eval_pairs WHERE reviewed = ? ORDER BY created_at DESC LIMIT ?`,
        ).all(Number(reviewed), limit) as Array<{
          id: string; kind: string; channel_id: string; thread_ts: string;
          prior_run_ts: string | null; input: string; output: string | null;
          signal: string; route_agent: string | null; trace_id: string | null;
          reviewed: number; created_at: string;
        }>;
        sendJson(res, 200, { pairs });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // Mark eval_pair as reviewed
    if (req.method === 'POST' && url.startsWith('/api/eval-pairs/') && url.endsWith('/reviewed')) {
      const pairId = url.replace('/api/eval-pairs/', '').replace('/reviewed', '');
      try {
        const db = getDb();
        const result = db.prepare('UPDATE eval_pairs SET reviewed = 1 WHERE id = ?').run(pairId);
        sendJson(res, 200, { ok: true, changes: result.changes });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // --- Generate n rephrasings of a seed text (Phase 2: variations) ---
    if (req.method === 'POST' && url === '/api/datasets/variations') {
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw || '{}') as {
          seed?: string; n?: number; datasetType?: string;
        };
        if (!body.seed?.trim()) {
          sendJson(res, 400, { error: 'seed text is required' });
          return;
        }
        const n = Math.min(body.n ?? 5, 10);
        const seed = body.seed.trim();

        // Use Ax to generate rephrasings
        const modAx = await import('@ax-llm/ax');
        const llm = createEvalLlm(modAx);
        const program = modAx.ax('original:string, n:number -> variations:string[]');
        const result = await program.forward(llm, {
          original: seed,
          n,
        });
        const variations: string[] = Array.isArray(result.variations) ? result.variations : [];
        sendJson(res, 200, { variations: variations.slice(0, n), seed });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // --- Datasets: list and load (8C) ---
    if (req.method === 'GET' && url === '/api/datasets') {
      try {
        const { readdirSync } = await import('node:fs');
        const fixturesDir = resolve(process.cwd(), 'tests', 'fixtures');
        const files = readdirSync(fixturesDir).filter(f => f.endsWith('-cases.json') || f === 'routing-cases.json');
        const { readFileSync } = await import('node:fs');
        const datasets = files.map(f => {
          const isFlow = f !== 'routing-cases.json';
          const id = f.replace('.json', '');
          let caseCount = 0;
          let regressionCount = 0;
          try {
            const raw = readFileSync(resolve(fixturesDir, f), 'utf8');
            const data = JSON.parse(raw);
            if (Array.isArray(data.cases)) {
              caseCount = data.cases.length;
              regressionCount = data.cases.filter((c: Record<string, unknown>) => c.regression === true).length;
            }
          } catch { /* stale/broken file — counts stay 0 */ }
          return { id, type: isFlow ? 'flow' : 'router', file: `tests/fixtures/${f}`, caseCount, regressionCount };
        });
        sendJson(res, 200, { datasets });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // Load a specific dataset
    // Export a dataset as downloadable JSON
    if (req.method === 'GET' && url.startsWith('/api/datasets/') && url.endsWith('/export')) {
      const datasetId = url.replace('/api/datasets/', '').replace('/export', '');
      try {
        const { readFileSync } = await import('node:fs');
        const filePath = resolve(process.cwd(), 'tests', 'fixtures', `${datasetId}.json`);
        const raw = readFileSync(filePath, 'utf8');
        cors(res);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${datasetId}.json"`,
        });
        res.end(raw);
      } catch (err) {
        sendJson(res, 404, { error: String(err) });
      }
      return;
    }


    if (req.method === 'GET' && url.startsWith('/api/datasets/') && url.endsWith('/coverage')) {
      const datasetId = url.replace('/api/datasets/', '').replace('/coverage', '');
      try {
        const { readFileSync, existsSync } = await import('node:fs');
        const filePath = resolve(process.cwd(), 'tests', 'fixtures', `${datasetId}.json`);
        if (!existsSync(filePath)) { sendJson(res, 404, { error: 'Dataset not found' }); return; }
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        const cases: Array<Record<string, unknown>> = Array.isArray(data.cases) ? data.cases : [];
        const byRoute: Record<string, number> = {};
        let regressionCount = 0;
        for (const c of cases) {
          if (c.regression === true) regressionCount++;
          const agent = (c.expectedAgent as string) ?? '(none)';
          byRoute[agent] = (byRoute[agent] ?? 0) + 1;
        }
        // The full set of routes/agents we know about from the registry
        const knownAgents = agents.map((a) => a.id);
        const total = cases.length;
        const thin: string[] = [];
        for (const agent of knownAgents) {
          if ((byRoute[agent] ?? 0) <= 2) thin.push(agent);
        }
        sendJson(res, 200, { total, regressionCount, byRoute, thin });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    if (req.method === 'GET' && url.startsWith('/api/datasets/')) {
      const datasetId = url.replace('/api/datasets/', '');
      try {
        const { readFileSync } = await import('node:fs');
        const isRouter = datasetId === 'routing-cases';
        const filePath = resolve(process.cwd(), 'tests', 'fixtures', `${datasetId}.json`);
        const raw = readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        sendJson(res, 200, { ...data, type: isRouter ? 'router' : 'flow' });
      } catch (err) {
        sendJson(res, 404, { error: String(err) });
      }
      return;
    }

    // Import a dataset from JSON body
    if (req.method === 'POST' && url === '/api/datasets/import') {
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw || '{}') as {
          id?: string;
          type?: string;
          flowId?: string;
          description?: string;
          cases?: unknown[];
        };
        if (!body.id || !body.cases || !Array.isArray(body.cases) || body.cases.length === 0) {
          sendJson(res, 400, { error: 'id and non-empty cases array are required' });
          return;
        }
        const datasetType = body.type === 'router' ? 'router' : 'flow';
        // Validate shape
        if (datasetType === 'router') {
          for (const c of body.cases) {
            const caseObj = c as Record<string, unknown>;
            if (!caseObj.id || !caseObj.request || !caseObj.expectedAgent) {
              sendJson(res, 400, { error: `Router cases must have id, request, and expectedAgent. Invalid: ${JSON.stringify(c)}` });
              return;
            }
          }
        } else {
          for (const c of body.cases) {
            const caseObj = c as Record<string, unknown>;
            if (!caseObj.id || caseObj.input === undefined) {
              sendJson(res, 400, { error: `Flow/custom cases must have id and input. Invalid: ${JSON.stringify(c)}` });
              return;
            }
          }
        }
        const result = await upsertDatasetCases(body.id, body.cases as Array<Record<string, unknown>>, {
          description: body.description,
          flowId: body.flowId,
        });
        sendJson(res, 200, { imported: true, id: body.id, type: datasetType, path: result.path, caseCount: result.caseCount });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // Save/create a dataset (8C)
    if (req.method === 'POST' && url.startsWith('/api/datasets/') && url.endsWith('/save')) {
      const datasetId = url.replace('/api/datasets/', '').replace('/save', '');
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw || '{}');
        const result = await upsertDatasetCases(datasetId, body.cases ?? [], {
          name: body.name,
          description: body.description,
          flowId: body.flowId,
        });
        sendJson(res, 200, { saved: true, path: result.path, caseCount: result.caseCount });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // Batch accept: save multiple cases to a dataset at once (from the Candidate Tray)
    if (req.method === 'POST' && url.startsWith('/api/datasets/') && url.endsWith('/cases/batch')) {
      const datasetId = url.replace('/api/datasets/', '').replace('/cases/batch', '');
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw || '{}') as {
          cases?: Array<Record<string, unknown>>;
          flowId?: string;
          name?: string;
          description?: string;
        };
        if (!body.cases || !Array.isArray(body.cases) || body.cases.length === 0) {
          sendJson(res, 400, { error: 'non-empty cases array is required' });
          return;
        }
        const result = await upsertDatasetCases(datasetId, body.cases, {
          flowId: body.flowId,
          name: body.name,
          description: body.description,
        });
        sendJson(res, 200, { saved: true, datasetId, caseCount: result.caseCount });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // Batch save multiple runs as dataset cases (Phase 2)
    if (req.method === 'POST' && url === '/api/runs/save-as-dataset') {
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw || '{}') as {
          runIds?: string[];
          kind?: 'baseline' | 'regression';
        };
        if (!body.runIds || !Array.isArray(body.runIds) || body.runIds.length === 0) {
          sendJson(res, 400, { error: 'non-empty runIds array is required' });
          return;
        }
        const kind = body.kind === 'regression' ? 'regression' : 'baseline';
        const db = getDb();
        const groups = new Map<string, { datasetType: 'router' | 'flow'; cases: Record<string, unknown>[]; flowId?: string }>();
        const skipped: Array<{ runId: string; reason: string }> = [];

        for (const runId of body.runIds) {
          const run = db.prepare(
            `SELECT id, original_request, selected_route_type, selected_route_id, final_response, error, status
             FROM runs WHERE id = ?`,
          ).get(runId) as {
            id: string;
            original_request: string;
            selected_route_type: string | null;
            selected_route_id: string | null;
            final_response: string | null;
            error: string | null;
            status: string;
          } | undefined;
          if (!run) { skipped.push({ runId, reason: 'not found' }); continue; }
          try {
            const { datasetId, datasetType, caseData } = buildDatasetCaseFromRun(run, kind);
            const existing = groups.get(datasetId);
            if (existing) {
              existing.cases.push(caseData);
            } else {
              groups.set(datasetId, {
                datasetType,
                cases: [caseData],
                flowId: datasetType === 'flow' ? run.selected_route_id ?? undefined : undefined,
              });
            }
          } catch (err) {
            skipped.push({ runId, reason: String(err) });
          }
        }

        const saved: Array<{ datasetId: string; datasetType: string; caseCount: number }> = [];
        for (const [datasetId, group] of groups) {
          const result = await upsertDatasetCases(datasetId, group.cases, { flowId: group.flowId });
          saved.push({ datasetId, datasetType: group.datasetType, caseCount: result.caseCount });
        }

        sendJson(res, 200, { saved: saved.length > 0, groups: saved, skipped });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // Save a past live run as a dataset case
    if (req.method === 'POST' && url.startsWith('/api/runs/') && url.endsWith('/save-as-dataset')) {
      const runId = url.replace('/api/runs/', '').replace('/save-as-dataset', '');
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw || '{}') as { kind?: 'baseline' | 'regression' };
        const kind = body.kind === 'regression' ? 'regression' : 'baseline';

        const db = getDb();
        const run = db.prepare(
          `SELECT id, original_request, selected_route_type, selected_route_id, final_response, error, status
           FROM runs WHERE id = ?`,
        ).get(runId) as {
          id: string;
          original_request: string;
          selected_route_type: string | null;
          selected_route_id: string | null;
          final_response: string | null;
          error: string | null;
          status: string;
        } | undefined;

        if (!run) {
          sendJson(res, 404, { error: 'Run not found' });
          return;
        }

        const { datasetId, datasetType, caseData } = buildDatasetCaseFromRun(run, kind);
        const result = await upsertDatasetCases(datasetId, [caseData], {
          flowId: datasetType === 'flow' ? run.selected_route_id ?? undefined : undefined,
        });

        sendJson(res, 200, {
          saved: true,
          runId,
          kind,
          datasetId,
          datasetType,
          caseCount: result.caseCount,
          caseData,
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // Delete a single case from a dataset
    if (req.method === 'DELETE' && url.startsWith('/api/datasets/') && url.includes('/cases/')) {
      const parts = url.replace('/api/datasets/', '').split('/cases/');
      const datasetId = parts[0];
      const caseId = parts[1];
      try {
        const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
        const filePath = resolve(process.cwd(), 'tests', 'fixtures', `${datasetId}.json`);
        if (!existsSync(filePath)) { sendJson(res, 404, { error: 'Dataset not found' }); return; }
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        data.cases = (data.cases ?? []).filter((c: any) => c.id !== caseId);
        writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        sendJson(res, 200, { deleted: true, caseId, caseCount: data.cases.length });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // --- Metric templates for flow eval (9A) ---
    if (req.method === 'GET' && url === '/api/metrics/templates') {
      const { METRIC_TEMPLATES } = await import('../evals/flow-metrics.js');
      sendJson(res, 200, { templates: METRIC_TEMPLATES });
      return;
    }

    // --- Promote a regression case to baseline (9B) ---
    if (req.method === 'POST' && url.startsWith('/api/datasets/') && url.endsWith('/promote')) {
      const datasetId = url.replace('/api/datasets/', '').replace('/promote', '');
      try {
        const raw = await readBody(req);
        const { caseId } = JSON.parse(raw || '{}') as { caseId: string };
        if (!caseId) { sendJson(res, 400, { error: 'Missing caseId' }); return; }
        const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
        const filePath = resolve(process.cwd(), 'tests', 'fixtures', `${datasetId}.json`);
        if (!existsSync(filePath)) { sendJson(res, 404, { error: 'Dataset not found' }); return; }
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        const targetCase = (data.cases ?? []).find((c: any) => c.id === caseId);
        if (!targetCase) { sendJson(res, 404, { error: 'Case not found' }); return; }
        // Remove regression markers, keep the case as a baseline
        delete targetCase.regression;
        delete targetCase.sourceStatus;
        delete targetCase.note;
        targetCase.promotedAt = new Date().toISOString();
        // The sourceRunId stays for traceability
        writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        sendJson(res, 200, { promoted: true, caseId, datasetId, caseCount: data.cases.length });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GEPA optimize — runs agent.optimize() against the routing coordinator
    if (req.method === 'POST' && url.startsWith('/api/eval/optimize')) {
      const isSave = url === '/api/eval/optimize/save';
      const isRestore = url === '/api/eval/optimize/restore';

      // Restore from saved artifact (revert to last saved, or drop to baseline)
      if (isRestore) {
        try {
          const { unlinkSync, existsSync } = await import('node:fs');
          const savedPath = resolve('data', 'optimized', 'coordinator.json');
          if (existsSync(savedPath)) {
            unlinkSync(savedPath);
            sendJson(res, 200, { restored: true, message: 'Reverted to baseline coordinator. Restart crew to apply.' });
          } else {
            sendJson(res, 200, { restored: false, message: 'No saved artifact to revert.' });
          }
        } catch (err) {
          sendJson(res, 500, { error: String(err) });
        }
        return;
      }

      // Save after optimize — the last result was stored in a module-level variable
      if (isSave) {
        try {
          if (!_lastOptimizeResult) {
            sendJson(res, 400, { error: 'No optimize result to save. Run optimize first.' });
            return;
          }
          const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
          const outDir = resolve('data', 'optimized');
          if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
          const outPath = resolve(outDir, 'coordinator.json');
          writeFileSync(outPath, JSON.stringify(_lastOptimizeResult, null, 2));
          sendJson(res, 200, { saved: true, path: outPath, message: 'Saved optimized coordinator. Restart crew to apply.' });
        } catch (err) {
          sendJson(res, 500, { error: String(err) });
        }
        return;
      }
      try {
        const raw = await readBody(req);
        const opts = JSON.parse(raw || '{}') as {
          maxMetricCalls?: number;
        };
        const maxMetricCalls = opts.maxMetricCalls ?? 20;

        // Stream SSE progress
        cors(res);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const emit = (type: string, data: unknown) => {
          res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        try {
          // Import optimize internals
          const { readFileSync } = await import('node:fs');
          const { resolve, dirname } = await import('node:path');
          const { fileURLToPath } = await import('node:url');
          const modAx = await import('@ax-llm/ax');
          const { scoreRouting, selectedFromPrediction } = await import('../evals/routing-metric.js');
          const { buildRoutingCoordinator, routeNatively } = await import('../composition/coordinator.js');

          const __dirname = dirname(fileURLToPath(import.meta.url));
          const fixturePath = resolve(__dirname, '..', '..', 'tests', 'fixtures', 'routing-cases.json');
          const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));
          const allCases: Array<{ id: string; expectedAgent: string; request: string }> = fixture.cases;

          // Split: every 4th case → holdout
          const train: typeof allCases = [];
          const holdout: typeof allCases = [];
          allCases.forEach((c, i) => (i % 4 === 3 ? holdout : train).push(c));
          emit('progress', { stage: 'setup', train: train.length, holdout: holdout.length });

          // Student model
          const studentAI = modAx.ai({
            name: 'openai' as const,
            apiKey: config.proxyApiKey,
            apiURL: config.proxyBaseUrl,
            config: { model: config.modelTiers.router as any },
          }) as any;

          // Build coordinator
          const { coordinator, getSelected, reset } = buildRoutingCoordinator(agents);
          const labelByRequest = new Map(allCases.map((c) => [c.request, c.expectedAgent]));

          // Eval holdout before
          let beforeHits = 0;
          for (const c of holdout) {
            reset?.();
            let selected = 'error';
            try {
              const route = await routeNatively(c.request, agents);
              selected = route.routedAgent;
            } catch { selected = 'error'; }
            beforeHits += scoreRouting(selected, c.expectedAgent);
          }
          emit('progress', { stage: 'baseline', beforeHits, holdoutTotal: holdout.length, beforePct: (beforeHits / holdout.length * 100).toFixed(1) });

          // Build GEPA tasks
          const tasks = train.map((c) => ({
            input: { userRequest: c.request },
            criteria:
              c.expectedAgent === 'clarify'
                ? 'The request is genuinely ambiguous — ask clarifying questions rather than routing.'
                : `Route to the ${c.expectedAgent} specialist. Do not over-ask for details.`,
          }));

          // Run optimize
          emit('progress', { stage: 'optimizing', maxMetricCalls });
          await (coordinator as any).optimize(tasks, {
            studentAI,
            metric: ({ prediction, example }: any) => {
              const req = example?.userRequest ?? example?.input?.userRequest ?? '';
              const expected = labelByRequest.get(String(req)) ?? '';
              return scoreRouting(selectedFromPrediction(prediction), expected);
            },
            maxMetricCalls,
            seed: 42,
          });

          // Serialize and store for save endpoint
          try {
            _lastOptimizeResult = (modAx as any).axSerializeOptimizedProgram?.((coordinator as any)._optimizedProgram);
          } catch { /* serialization is best-effort */ }

          // Eval after
          let afterHits = 0;
          for (const c of holdout) {
            reset?.();
            let selected = 'error';
            try {
              await coordinator.forward(studentAI, { userRequest: c.request });
              selected = getSelected?.() ?? 'none';
            } catch { selected = 'error'; }
            afterHits += scoreRouting(selected, c.expectedAgent);
          }
          emit('result', {
            before: { hits: beforeHits, total: holdout.length, pct: (beforeHits / holdout.length * 100).toFixed(1) },
            after: { hits: afterHits, total: holdout.length, pct: (afterHits / holdout.length * 100).toFixed(1) },
            delta: afterHits - beforeHits,
          });

          res.end();
        } catch (err) {
          emit('error', { error: String(err) });
          res.end();
        }
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // Component browser — returns registry data for agents, tools, flows, and skills
    if (req.method === 'GET' && url === '/api/components') {
      const registry = {
        agents: agents.map((a) => ({
            id: a.id,
            name: a.name,
            description: a.description,
            modelTier: a.modelTier,
            tools: a.allowedTools.map((t) => t.name),
            triggers: a.triggers,
            handoffs: a.handoffs,
          })),
        tools: TOOL_REGISTRY.map((t) => ({
          name: t.name,
          description: t.description,
          approvalLevel: t.approvalLevel,
          source: t.source,
        })),
        flows: getAllFlows().map((f) => ({
          id: f.id,
          name: f.name,
          description: f.description,
          triggers: f.triggers,
          approvalRequired: f.approvalRequired,
          sourceFile: f.sourceFile,
          isAxFlow: true,
        })),
        skills: getAllSkills()
          .filter((s) => !getAllFlows().find((f) => f.id === s.id))
          .map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            triggers: s.triggers,
            approvalRequired: s.approvalRequired,
            isAxFlow: false,
          })),
      };
      sendJson(res, 200, registry);
      return;
    }

    // 7B: Agentmemory proxy — list sessions
    if (req.method === 'GET' && url === '/api/agentmemory/sessions') {
      try {
        const sessions = await getMemorySessions();
        sendJson(res, 200, { sessions: sessions.slice(0, 200) });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // 7B: Agentmemory proxy — search by query
    if (req.method === 'GET' && url.startsWith('/api/agentmemory/search')) {
      const q = new URL(url, `http://localhost:${port}`).searchParams.get('q');
      if (!q) { sendJson(res, 400, { error: 'Missing ?q=' }); return; }
      try {
        const results = await searchMemory(q, 20);
        sendJson(res, 200, { results });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // 7C: Read a source file (for clickable source links → Monaco)
    if (req.method === 'GET' && url.startsWith('/api/files')) {
      const fileParam = new URL(url, `http://localhost:${port}`).searchParams.get('path');
      if (!fileParam) { sendJson(res, 400, { error: 'Missing ?path=' }); return; }
      try {
        const { readFileSync } = await import('node:fs');
        const fullPath = resolve(process.cwd(), fileParam);
        const content = readFileSync(fullPath, 'utf8');
        sendJson(res, 200, { content, path: fileParam });
      } catch (err) {
        sendJson(res, 404, { error: `Cannot read file: ${String(err)}` });
      }
      return;
    }

    // 7D: View agent instruction file (.md prompt)
    if (req.method === 'GET' && url.startsWith('/api/agents/') && url.endsWith('/instructions')) {
      const agentId = url.split('/api/agents/')[1]?.split('/')[0];
      if (!agentId) { sendJson(res, 400, { error: 'Missing agent id' }); return; }
      try {
        const { readFileSync } = await import('node:fs');
        const mdPath = resolve(process.cwd(), 'crew', 'agents', `${agentId}.md`);
        const content = readFileSync(mdPath, 'utf8');
        sendJson(res, 200, { agentId, content });
      } catch (err) {
        sendJson(res, 404, { error: `No instruction file for agent: ${String(err)}` });
      }
      return;
    }

    // Langfuse trace proxy — fetches trace data from the self-hosted Langfuse
    // so the visual lab can render spans/generations inline without a link.
    if (req.method === 'GET' && url.startsWith('/api/langfuse/trace/')) {
      const traceId = url.split('/api/langfuse/trace/')[1]?.split('?')[0];
      if (!traceId) { sendJson(res, 400, { error: 'Missing trace id' }); return; }
      try {
        const baseUrl = (process.env.LANGFUSE_BASEURL ?? process.env.LANGFUSE_BASE_URL ?? process.env.QODER_LANGFUSE_BASE_URL ?? '').replace(/\/$/, '');
        const publicKey = process.env.LANGFUSE_PUBLIC_KEY ?? process.env.QODER_LANGFUSE_PUBLIC_KEY ?? '';
        const secretKey = process.env.LANGFUSE_SECRET_KEY ?? process.env.QODER_LANGFUSE_SECRET_KEY ?? '';
        if (!baseUrl || !publicKey || !secretKey) {
          sendJson(res, 503, { error: 'Langfuse not configured' });
          return;
        }
        const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
        const lfRes = await fetch(`${baseUrl}/api/public/traces/${encodeURIComponent(traceId)}`, {
          headers: { Authorization: `Basic ${auth}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!lfRes.ok) {
          sendJson(res, lfRes.status, { error: `Langfuse returned ${lfRes.status}` });
          return;
        }
        const data = await lfRes.json() as Record<string, any>;
        // Map observations into a flat timeline the lab can render
        const observations = (data.observations ?? []).map((o: any) => ({
          id: o.id,
          name: o.name ?? o.type,
          type: o.type,
          startTime: o.startTime,
          endTime: o.endTime,
          model: o.model,
          input: typeof o.input === 'string' ? o.input.slice(0, 500) : undefined,
          output: typeof o.output === 'string' ? o.output.slice(0, 500) : undefined,
          usage: o.usage,
          level: o.level,
          statusMessage: o.statusMessage,
        }));
        sendJson(res, 200, {
          id: data.id,
          name: data.name,
          userId: data.userId,
          sessionId: data.sessionId,
          tags: data.tags,
          observations,
          langfuseUrl: `${baseUrl}/trace/${traceId}`,
        });
      } catch (err) {
        sendJson(res, 502, { error: `Langfuse proxy error: ${String(err)}` });
      }
      return;
    }

    // --- Bench (shared shelf) endpoints ---

    // GET /api/bench — return all artifacts
    if (req.method === 'GET' && url === '/api/bench') {
      sendJson(res, 200, { artifacts: loadBench() });
      return;
    }

    // PUT /api/bench/:id — upsert one artifact
    if (req.method === 'PUT' && url.startsWith('/api/bench/')) {
      const benchId = url.split('/api/bench/')[1]?.split('?')[0];
      if (!benchId) { sendJson(res, 400, { error: 'Missing artifact id' }); return; }
      try {
        const raw = await readBody(req);
        const artifact = JSON.parse(raw) as BenchArtifact;
        artifact.id = benchId;
        artifact.updatedAt = Date.now();
        if (!artifact.createdAt) artifact.createdAt = artifact.updatedAt;

        const bench = loadBench();
        const idx = bench.findIndex((a) => a.id === benchId);
        if (idx >= 0) {
          bench[idx] = artifact;
        } else {
          bench.push(artifact);
        }
        saveBench(bench);
        sendJson(res, 200, artifact);
      } catch (err) {
        sendJson(res, 400, { error: `Invalid body: ${String(err)}` });
      }
      return;
    }

    // DELETE /api/bench/:id — remove one artifact
    if (req.method === 'DELETE' && url.startsWith('/api/bench/')) {
      const benchId = url.split('/api/bench/')[1]?.split('?')[0];
      if (!benchId) { sendJson(res, 400, { error: 'Missing artifact id' }); return; }
      const bench = loadBench();
      const filtered = bench.filter((a) => a.id !== benchId);
      if (filtered.length === bench.length) {
        sendJson(res, 404, { error: `Artifact not found: ${benchId}` });
        return;
      }
      saveBench(filtered);
      sendJson(res, 200, { ok: true });
      return;
    }

    // POST /api/bench/validate-signature — validate ax string via real ax parser
    if (req.method === 'POST' && url === '/api/bench/validate-signature') {
      try {
        const raw = await readBody(req);
        const { axString } = JSON.parse(raw || '{}') as { axString?: string };
        if (!axString?.trim()) {
          sendJson(res, 400, { ok: false, error: 'axString is required' });
          return;
        }
        const { ax } = await import('@ax-llm/ax');
        try {
          ax(axString);
          sendJson(res, 200, { ok: true });
        } catch (parseErr) {
          sendJson(res, 200, { ok: false, error: String(parseErr) });
        }
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    // POST /api/bench/eval/run — run a signature against ad hoc cases
    if (req.method === 'POST' && url === '/api/bench/eval/run') {
      try {
        const raw = await readBody(req);
        const { axString, cases, metric } = JSON.parse(raw || '{}') as {
          axString?: string;
          cases?: SignatureEvalCase[];
          metric?: string;
        };
        if (!axString?.trim()) {
          sendJson(res, 400, { error: 'axString is required' });
          return;
        }
        if (!cases?.length) {
          sendJson(res, 400, { error: 'cases array is required' });
          return;
        }

        const scoringFn = compileScoringFn(metric) ?? scoreExpectedRatio;

        const modAx = await import('@ax-llm/ax');
        const program = modAx.ax(axString);
        const llm = createEvalLlm(modAx);
        const results: SignatureEvalResult[] = [];
        let labeled = 0;
        let hits = 0;

        for (const testCase of cases) {
          try {
            const output = await program.forward(llm, testCase.input ?? {});
            const expected = isPlainObject(testCase.expected) ? testCase.expected : undefined;
            const score = expected ? scoringFn(output, expected) : undefined;
            const pass = expected ? score === 1 : undefined;
            if (expected) {
              labeled++;
              if (pass) hits++;
            }
            results.push({
              input: testCase.input ?? {},
              output,
              expected,
              pass,
              score,
            });
          } catch (err) {
            const expected = isPlainObject(testCase.expected) ? testCase.expected : undefined;
            if (expected) labeled++;
            results.push({
              input: testCase.input ?? {},
              expected,
              pass: false,
              score: 0,
              error: String(err),
            });
          }
        }

        sendJson(res, 200, {
          results,
          summary: {
            total: results.length,
            labeled,
            hits,
            accuracy: labeled > 0 ? hits / labeled : 0,
          },
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/bench/eval/optimize — GEPA-tune a signature on labeled cases
    if (req.method === 'POST' && url === '/api/bench/eval/optimize') {
      try {
        const raw = await readBody(req);
        const { axString, cases, maxMetricCalls, metric } = JSON.parse(raw || '{}') as {
          axString?: string;
          cases?: SignatureEvalCase[];
          maxMetricCalls?: number;
          metric?: string;
        };
        if (!axString?.trim()) {
          sendJson(res, 400, { error: 'axString is required' });
          return;
        }
        const labeledCases = (cases ?? []).filter(
          (testCase) => isPlainObject(testCase.input) && isPlainObject(testCase.expected),
        ) as Array<Required<SignatureEvalCase>>;
        if (labeledCases.length < 2) {
          sendJson(res, 400, { error: 'At least two labeled cases are required to optimize' });
          return;
        }

        const validationCount = labeledCases.length >= 4 ? Math.max(1, Math.floor(labeledCases.length / 4)) : 1;
        const trainCases = labeledCases.slice(0, labeledCases.length - validationCount);
        const validationCases = labeledCases.slice(labeledCases.length - validationCount);
        if (trainCases.length === 0 || validationCases.length === 0) {
          sendJson(res, 400, { error: 'Need both train and validation signature cases' });
          return;
        }

        const config = getConfig();
        const modAx = await import('@ax-llm/ax');
        const studentAI = createEvalLlm(modAx);
        const teacherAI = modAx.ai({
          name: 'openai' as const,
          apiKey: config.reflectionApiKey || config.proxyApiKey,
          apiURL: config.reflectionApiKey ? config.reflectionBaseUrl : config.proxyBaseUrl,
          config: {
            model: (config.reflectionApiKey ? config.reflectionModel : config.modelTiers.smart) as any,
          },
        }) as any;

        const scoringFn = compileScoringFn(metric) ?? scoreExpectedRatio;

        const baselineProgram = modAx.ax(axString);
        let beforeHits = 0;
        for (const testCase of validationCases) {
          try {
            const output = await baselineProgram.forward(studentAI, testCase.input);
            if (scoringFn(output, testCase.expected) === 1) beforeHits++;
          } catch {
            // Count as miss.
          }
        }

        const trainExamples = trainCases.map((testCase) => ({
          ...testCase.input,
          ...testCase.expected,
          __expected: testCase.expected,
        }));
        const validationExamples = validationCases.map((testCase) => ({
          ...testCase.input,
          ...testCase.expected,
          __expected: testCase.expected,
        }));

        const program = modAx.ax(axString);
        const optimizeResult = await modAx.optimize(
          program,
          trainExamples,
          ({ prediction, example }: any) =>
            scoringFn(prediction, (example?.__expected ?? {}) as Record<string, unknown>),
          {
            studentAI,
            teacherAI,
            validationExamples,
            maxMetricCalls: maxMetricCalls ?? 20,
            numTrials: 8,
            minibatch: trainExamples.length > 4,
            minibatchSize: Math.min(4, trainExamples.length),
            earlyStoppingTrials: 3,
            sampleCount: 1,
            seed: 42,
          },
        );

        const optimizedProgram = modAx.ax(axString);
        if (optimizeResult.optimizedProgram) {
          optimizedProgram.applyOptimization(optimizeResult.optimizedProgram);
        }

        let afterHits = 0;
        for (const testCase of validationCases) {
          try {
            const output = await optimizedProgram.forward(studentAI, testCase.input);
            if (scoringFn(output, testCase.expected) === 1) afterHits++;
          } catch {
            // Count as miss.
          }
        }

        sendJson(res, 200, {
          before: {
            hits: beforeHits,
            total: validationCases.length,
            pct: ((beforeHits / validationCases.length) * 100).toFixed(1),
          },
          after: {
            hits: afterHits,
            total: validationCases.length,
            pct: ((afterHits / validationCases.length) * 100).toFixed(1),
          },
          delta: afterHits - beforeHits,
          trainCases: trainCases.length,
          validationCases: validationCases.length,
          optimizedProgram: optimizeResult.optimizedProgram
            ? modAx.axSerializeOptimizedProgram(optimizeResult.optimizedProgram)
            : null,
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Orchestrator variants (Slice O4) ────────────────────────────

    // GET /api/orchestrators — list all saved orchestrator configs
    if (req.method === 'GET' && url === '/api/orchestrators') {
      try {
        sendJson(res, 200, { configs: loadOrchestrators() });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/orchestrators — upsert an orchestrator config
    if (req.method === 'POST' && url === '/api/orchestrators') {
      try {
        const raw = await readBody(req);
        const config = JSON.parse(raw || '{}') as OrchestratorConfig;
        if (!config.id || !config.name) {
          sendJson(res, 400, { error: 'id and name are required' });
          return;
        }
        config.updatedAt = Date.now();
        if (!config.createdAt) config.createdAt = config.updatedAt;
        const all = loadOrchestrators();
        const idx = all.findIndex((c) => c.id === config.id);
        if (idx >= 0) all[idx] = config;
        else all.push(config);
        saveOrchestrators(all);
        sendJson(res, 200, { ok: true, config });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // PUT /api/orchestrators/:id — update one config
    if (req.method === 'PUT' && url.startsWith('/api/orchestrators/')) {
      const configId = url.split('/api/orchestrators/')[1]?.split('?')[0];
      if (!configId) { sendJson(res, 400, { error: 'Missing config id' }); return; }
      try {
        const raw = await readBody(req);
        const updates = JSON.parse(raw || '{}') as Partial<OrchestratorConfig>;
        const all = loadOrchestrators();
        const existing = all.find((c) => c.id === configId);
        if (!existing) { sendJson(res, 404, { error: `Config not found: ${configId}` }); return; }
        Object.assign(existing, updates, { id: configId, updatedAt: Date.now() });
        saveOrchestrators(all);
        sendJson(res, 200, { ok: true, config: existing });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // DELETE /api/orchestrators/:id — remove a config
    if (req.method === 'DELETE' && url.startsWith('/api/orchestrators/')) {
      const configId = url.split('/api/orchestrators/')[1]?.split('?')[0];
      if (!configId) { sendJson(res, 400, { error: 'Missing config id' }); return; }
      try {
        const all = loadOrchestrators();
        const filtered = all.filter((c) => c.id !== configId);
        if (filtered.length === all.length) {
          sendJson(res, 404, { error: `Config not found: ${configId}` });
          return;
        }
        saveOrchestrators(filtered);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/orchestrators/run — run a request through an orchestrator variant (SSE stream)
    if (req.method === 'POST' && url === '/api/orchestrators/run') {
      try {
        const raw = await readBody(req);
        const { configId, request } = JSON.parse(raw || '{}') as {
          configId?: string;
          request?: string;
        };
        if (!configId || !request?.trim()) {
          sendJson(res, 400, { error: 'configId and request are required' });
          return;
        }
        const all = loadOrchestrators();
        const config = all.find((c) => c.id === configId);
        if (!config) { sendJson(res, 404, { error: `Config not found: ${configId}` }); return; }

        const { buildRoutingCoordinator } = await import('../composition/coordinator.js');
        const { createRouterClient } = await import('../ai/clients.js');
        const llm = createRouterClient();
        const { coordinator, getSelected, getTrace, reset } = buildRoutingCoordinator(agents, config);
        reset();

        cors(res);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        const emit = (event: string, data: unknown) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        const t0 = Date.now();
        try {
          const output = await coordinator.forward(llm, { userRequest: request });
          const trace = getTrace();
          emit('done', {
            routedAgent: getSelected(),
            output: typeof output === 'string' ? output : JSON.stringify(output),
            trace: trace ?? null,
            durationMs: Date.now() - t0,
          });
        } catch (err) {
          emit('error', { error: String(err), durationMs: Date.now() - t0 });
        }
        res.end();
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Active orchestrator (Slice P) ───────────────────────────────

    // GET /api/orchestrators/active — get active config
    if (req.method === 'GET' && url === '/api/orchestrators/active') {
      try {
        const active = getActiveOrchestratorConfig();
        sendJson(res, 200, { activeId: _activeOrchestratorId, config: active });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/orchestrators/active — set the active config
    if (req.method === 'POST' && url === '/api/orchestrators/active') {
      try {
        const raw = await readBody(req);
        const { id } = JSON.parse(raw || '{}') as { id?: string | null };
        if (id !== null && id !== undefined) {
          const configs = loadOrchestrators();
          const found = configs.find((c) => c.id === id);
          if (!found) {
            sendJson(res, 404, { error: `Config not found: ${id}` });
            return;
          }
        }
        _activeOrchestratorId = id ?? null;
        saveActiveOrchestratorId(_activeOrchestratorId);
        logger.info({ activeOrchestratorId: _activeOrchestratorId }, 'orchestrator.active.set');
        sendJson(res, 200, { activeId: _activeOrchestratorId });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Named playbook snapshots (Slice O2) ─────────────────────────

    // GET /api/playbooks/:agentId/snapshots — list named snapshots for an agent
    if (req.method === 'GET' && url.startsWith('/api/playbooks/') && (url.split('?')[0] ?? '').endsWith('/snapshots')) {
      const pathPart = url.split('?')[0] ?? '';
      const agentId = pathPart.split('/api/playbooks/')[1]?.replace('/snapshots', '');
      if (!agentId) { sendJson(res, 400, { error: 'Missing agent id' }); return; }
      try {
        const { listNamedSnapshots } = await import('../playbooks/persist.js');
        sendJson(res, 200, { agentId, snapshots: listNamedSnapshots(agentId) });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/playbooks/:agentId/snapshots — freeze current playbook as a named snapshot
    if (req.method === 'POST' && url.startsWith('/api/playbooks/') && (url.split('?')[0] ?? '').endsWith('/snapshots')) {
      const pathPart = url.split('?')[0] ?? '';
      const agentId = pathPart.split('/api/playbooks/')[1]?.replace('/snapshots', '');
      if (!agentId) { sendJson(res, 400, { error: 'Missing agent id' }); return; }
      try {
        const raw = await readBody(req);
        const { label } = JSON.parse(raw || '{}') as { label?: string };
        if (!label?.trim()) {
          sendJson(res, 400, { error: 'label is required' });
          return;
        }
        const { loadPlaybookSnapshot, saveNamedSnapshot } = await import('../playbooks/persist.js');
        const snap = loadPlaybookSnapshot(agentId);
        if (!snap) { sendJson(res, 404, { error: `No playbook for ${agentId}` }); return; }
        const id = saveNamedSnapshot(agentId, label.trim(), snap);
        if (!id) { sendJson(res, 500, { error: 'Failed to save snapshot' }); return; }
        sendJson(res, 200, { ok: true, id, agentId, label: label.trim() });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/playbooks/:agentId/snapshots/:snapshotId — load a specific named snapshot
    if (req.method === 'GET' && url.startsWith('/api/playbooks/') && url.includes('/snapshots/')) {
      const pathPart = url.split('?')[0] ?? '';
      const parts = pathPart.split('/').slice(3); // ['playbooks','agentId','snapshots','snapshotId']
      const agentId = parts[0];
      const snapshotId = parts[2];
      if (!agentId || !snapshotId) {
        sendJson(res, 400, { error: 'Missing agent id or snapshot id' });
        return;
      }
      try {
        const { loadNamedSnapshot } = await import('../playbooks/persist.js');
        const named = loadNamedSnapshot(agentId, snapshotId);
        if (!named) { sendJson(res, 404, { error: `Snapshot not found: ${snapshotId}` }); return; }
        sendJson(res, 200, named);
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // --- Sessions: list past conversations (skip empty ones from cold starts) ---
    if (req.method === 'GET' && url === '/api/sessions') {
      try {
        const db = getDb();
        const rows = db
          .prepare(
            `SELECT id, title, turn_count, started_at, ended_at
             FROM sessions
             WHERE turn_count > 0
             ORDER BY started_at DESC
             LIMIT 100`,
          )
          .all() as Array<{
            id: string;
            title: string | null;
            turn_count: number;
            started_at: string;
            ended_at: string | null;
          }>;
        // Derive title from first user request if no title set
        const sessions = rows.map((r) => {
          let title = r.title;
          if (!title && r.turn_count > 0) {
            const firstRun = db
              .prepare(
                `SELECT original_request FROM runs WHERE session_id = ? ORDER BY started_at ASC LIMIT 1`,
              )
              .get(r.id) as { original_request: string } | undefined;
            title = firstRun?.original_request?.slice(0, 80) ?? null;
          }
          return { ...r, title };
        });
        sendJson(res, 200, { sessions });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // --- Sessions: get full transcript for one session ---
    if (req.method === 'GET' && url.startsWith('/api/sessions/')) {
      const sessionId = url.replace('/api/sessions/', '').split('?')[0];
      if (!sessionId) {
        sendJson(res, 400, { error: 'Missing session id' });
        return;
      }
      try {
        const db = getDb();
        const session = db
          .prepare(`SELECT id, title, turn_count, started_at, ended_at FROM sessions WHERE id = ?`)
          .get(sessionId) as {
            id: string;
            title: string | null;
            turn_count: number;
            started_at: string;
            ended_at: string | null;
          } | undefined;

        if (!session) {
          sendJson(res, 404, { error: 'Session not found' });
          return;
        }

        const runs = db
          .prepare(
            `SELECT id, started_at, completed_at, status,
                    original_request, selected_route_id, route_confidence,
                    route_reason, final_response, error
             FROM runs
             WHERE session_id = ?
             ORDER BY started_at ASC`,
          )
          .all(sessionId) as Array<{
            id: string;
            started_at: string;
            completed_at: string | null;
            status: string;
            original_request: string;
            selected_route_id: string | null;
            route_confidence: number | null;
            route_reason: string | null;
            final_response: string | null;
            error: string | null;
          }>;

        sendJson(res, 200, { session, runs });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // --- Runs: list past runs (optionally filtered by session, search, filters) ---
    // Only match exact /api/runs or /api/runs?query — NOT /api/runs/<id>
    if (req.method === 'GET' && (url === '/api/runs' || url.startsWith('/api/runs?'))) {
      try {
        const urlObj = new URL(url, `http://localhost:${port}`);
        const sessionFilter = urlObj.searchParams.get('session_id');
        const searchQ = urlObj.searchParams.get('q');
        const routeFilter = urlObj.searchParams.get('route');
        const statusFilter = urlObj.searchParams.get('status');
        const dateFrom = urlObj.searchParams.get('date_from');
        const dateTo = urlObj.searchParams.get('date_to');
        const sort = urlObj.searchParams.get('sort');
        const limit = Math.min(Number(urlObj.searchParams.get('limit') ?? 50), 200);

        const db = getDb();

        // Build WHERE and ORDER BY dynamically from filters
        const conditions: string[] = [];
        const params: Array<string | number> = [];

        if (sessionFilter) { conditions.push('session_id = ?'); params.push(sessionFilter); }
        if (searchQ) { conditions.push("original_request LIKE '%' || ? || '%'"); params.push(searchQ); }
        if (routeFilter) { conditions.push('selected_route_id = ?'); params.push(routeFilter); }
        if (statusFilter) { conditions.push('status = ?'); params.push(statusFilter); }
        if (dateFrom) { conditions.push('started_at >= ?'); params.push(dateFrom); }
        if (dateTo) { conditions.push('started_at <= ?'); params.push(dateTo); }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const orderClause = sort === 'confidence_asc'
          ? 'ORDER BY route_confidence ASC NULLS LAST'
          : 'ORDER BY started_at DESC';

        const query = `SELECT id, session_id, started_at, completed_at, status,
                    original_request, selected_route_id, route_confidence,
                    route_reason, final_response, error
             FROM runs
             ${whereClause}
             ${orderClause}
             LIMIT ?`;

        params.push(limit);
        const rows = db.prepare(query).all(...params) as Array<{
          id: string;
          session_id: string;
          started_at: string;
          completed_at: string | null;
          status: string;
          original_request: string;
          selected_route_id: string | null;
          route_confidence: number | null;
          route_reason: string | null;
          final_response: string | null;
          error: string | null;
        }>;

        // Summarize: request preview, derive duration
        const runs = rows.map((r) => {
          let durationMs: number | null = null;
          if (r.started_at && r.completed_at) {
            durationMs =
              new Date(r.completed_at).getTime() -
              new Date(r.started_at).getTime();
          }
          return {
            ...r,
            request_preview: r.original_request.slice(0, 120),
            response_preview: r.final_response?.slice(0, 200) ?? null,
            durationMs,
          };
        });

        sendJson(res, 200, { runs });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // --- Runs: get full detail for a single run ---
    if (req.method === 'GET' && url.startsWith('/api/runs/')) {
      const runId = url.replace('/api/runs/', '').split('?')[0];
      if (!runId) {
        sendJson(res, 400, { error: 'Missing run id' });
        return;
      }
      try {
        const db = getDb();
        const run = db
          .prepare(
            `SELECT id, session_id, started_at, completed_at, status,
                    original_request, selected_route_type, selected_route_id,
                    route_confidence, route_reason, final_response, error
             FROM runs WHERE id = ?`,
          )
          .get(runId) as {
            id: string;
            session_id: string | null;
            started_at: string;
            completed_at: string | null;
            status: string;
            original_request: string;
            selected_route_type: string | null;
            selected_route_id: string | null;
            route_confidence: number | null;
            route_reason: string | null;
            final_response: string | null;
            error: string | null;
          } | undefined;

        if (!run) {
          sendJson(res, 404, { error: 'Run not found' });
          return;
        }

        const durationMs =
          run.started_at && run.completed_at
            ? new Date(run.completed_at).getTime() -
              new Date(run.started_at).getTime()
            : null;

        sendJson(res, 200, { ...run, durationMs });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Playbooks (E4) ─────────────────────────────────────────────

    // GET /api/playbooks — list all agents with playbook stats
    if (req.method === 'GET' && url === '/api/playbooks') {
      try {
        const { loadPlaybookSnapshot } = await import('../playbooks/persist.js');
        const list = agents.map((a) => {
          const snap = loadPlaybookSnapshot(a.id);
          const bullets = snap?.playbook?.stats?.bulletCount ?? 0;
          const sections = snap?.playbook?.sections
            ? Object.keys(snap.playbook.sections)
            : [];
          const updatedAt = snap?.playbook?.updatedAt ?? null;
          return { id: a.id, name: a.name, bulletCount: bullets, sections, updatedAt };
        });
        sendJson(res, 200, { agents: list });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/playbooks/:agentId/events — learning timeline (newest first)
    if (req.method === 'GET' && url.startsWith('/api/playbooks/') && (url.split('?')[0] ?? '').endsWith('/events')) {
      const pathPart = url.split('?')[0] ?? '';
      const agentId = pathPart.split('/api/playbooks/')[1]?.replace('/events', '');
      if (!agentId) { sendJson(res, 400, { error: 'Missing agent id' }); return; }
      const limit = parseInt(new URL(url, `http://localhost:${port}`).searchParams.get('limit') ?? '50', 10);
      try {
        const { readPlaybookEvents } = await import('../playbooks/persist.js');
        const events = readPlaybookEvents(agentId, limit);
        sendJson(res, 200, { agentId, events });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/playbooks/:agentId — full playbook detail
    if (req.method === 'GET' && url.startsWith('/api/playbooks/')) {
      const agentId = url.split('/api/playbooks/')[1]?.split('?')[0];
      if (!agentId) { sendJson(res, 400, { error: 'Missing agent id' }); return; }
      try {
        const { loadPlaybookSnapshot } = await import('../playbooks/persist.js');
        const snap = loadPlaybookSnapshot(agentId);
        if (!snap) { sendJson(res, 404, { error: `No playbook for ${agentId}` }); return; }

        // Build a condensed bullet list for the UI
        const allBullets: Array<{
          id: string; section: string; content: string;
          helpfulCount: number; harmfulCount: number;
          updatedAt: string; tags: string[];
        }> = [];
        for (const [section, bullets] of Object.entries(snap.playbook.sections)) {
          for (const b of bullets) {
            allBullets.push({
              id: b.id,
              section,
              content: b.content,
              helpfulCount: b.helpfulCount,
              harmfulCount: b.harmfulCount,
              updatedAt: b.updatedAt,
              tags: b.tags ?? [],
            });
          }
        }

        sendJson(res, 200, {
          agentId,
          playbook: {
            description: snap.playbook.description,
            stats: snap.playbook.stats,
            sections: Object.keys(snap.playbook.sections),
            updatedAt: snap.playbook.updatedAt,
          },
          bullets: allBullets,
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/playbooks/:agentId/reset — reset to seed
    if (req.method === 'POST' && url.startsWith('/api/playbooks/') && url.endsWith('/reset')) {
      const agentId = url.split('/api/playbooks/')[1]?.split('/')[0];
      if (!agentId) { sendJson(res, 400, { error: 'Missing agent id' }); return; }
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) { sendJson(res, 404, { error: `Agent ${agentId} not found` }); return; }
      try {
        const { seedPlaybook } = await import('../playbooks/seed.js');
        const { savePlaybookSnapshot } = await import('../playbooks/persist.js');
        const playbook = seedPlaybook(agentId);
        const snapshot = { playbook, artifact: { playbook, feedback: [], history: [] } };
        savePlaybookSnapshot(agentId, snapshot);
        sendJson(res, 200, { ok: true, bulletCount: playbook.stats.bulletCount });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Bullet CRUD (Slice A) ─────────────────────────────────────

    // POST /api/playbooks/:agentId/bullets — add a bullet
    if (req.method === 'POST' && url.startsWith('/api/playbooks/') && url.endsWith('/bullets')) {
      const agentId = url.split('/api/playbooks/')[1]?.replace('/bullets', '');
      if (!agentId) { sendJson(res, 400, { error: 'Missing agent id' }); return; }
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) { sendJson(res, 404, { error: `Agent ${agentId} not found` }); return; }
      try {
        const raw = await readBody(req);
        const { section, content } = JSON.parse(raw || '{}') as {
          section?: string;
          content?: string;
        };
        if (!section || !content?.trim()) {
          sendJson(res, 400, { error: 'section and content are required' });
          return;
        }
        const { addBullet } = await import('../playbooks/edit.js');
        const bullet = addBullet(agentId, section, content.trim());
        sendJson(res, 200, { ok: true, bullet });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/playbooks/:agentId/bullets/:bulletId — edit/delete/pin (op discriminator)
    if (req.method === 'POST' && url.startsWith('/api/playbooks/') && url.includes('/bullets/')) {
      const parts = url.split('/').slice(3); // ['playbooks','id','bullets','bulletId']
      const agentId = parts[0];
      const bulletId = parts[2];
      if (!agentId || !bulletId) {
        sendJson(res, 400, { error: 'Missing agent id or bullet id' });
        return;
      }
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) { sendJson(res, 404, { error: `Agent ${agentId} not found` }); return; }
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw || '{}') as {
          op?: 'edit' | 'delete' | 'pin';
          content?: string;
          pinned?: boolean;
        };
        const { editBullet, deleteBullet, pinBullet } = await import('../playbooks/edit.js');
        switch (body.op) {
          case 'edit': {
            if (!body.content?.trim()) {
              sendJson(res, 400, { error: 'content is required for edit' });
              return;
            }
            editBullet(agentId, bulletId, body.content.trim());
            sendJson(res, 200, { ok: true });
            return;
          }
          case 'delete': {
            deleteBullet(agentId, bulletId);
            sendJson(res, 200, { ok: true });
            return;
          }
          case 'pin': {
            if (typeof body.pinned !== 'boolean') {
              sendJson(res, 400, { error: 'pinned (boolean) is required for pin' });
              return;
            }
            const pinned = pinBullet(agentId, bulletId, body.pinned);
            sendJson(res, 200, { ok: true, pinned });
            return;
          }
          default:
            sendJson(res, 400, { error: 'op must be edit, delete, or pin' });
        }
      } catch (err) {
        const msg = String(err);
        if (msg.includes('not found')) {
          sendJson(res, 404, { error: msg });
        } else {
          sendJson(res, 500, { error: msg });
        }
      }
      return;
    }

    // POST /api/playbooks/:agentId/update — supervised update (Slice B2)
    if (req.method === 'POST' && url.startsWith('/api/playbooks/') && url.endsWith('/update')) {
      const pathPart = (url.split('?')[0] ?? '');
      const agentId = pathPart.split('/api/playbooks/')[1]?.replace('/update', '');
      if (!agentId) { sendJson(res, 400, { error: 'Missing agent id' }); return; }
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) { sendJson(res, 404, { error: `Agent ${agentId} not found` }); return; }
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw || '{}') as {
          example?: unknown;
          prediction?: unknown;
          feedback?: string;
        };
        if (!body.feedback?.trim()) {
          sendJson(res, 400, { error: 'feedback is required' });
          return;
        }
        const { buildAgentInstance } = await import('../runtime/executor.js');
        const { loadPlaybookSnapshot, savePlaybookSnapshot, appendPlaybookEvent } = await import('../playbooks/persist.js');
        const { createModelClient } = await import('../ai/clients.js');
        const studentAI = createModelClient(agent.modelTier, agent.model);
        const instance = buildAgentInstance(agent, { studentAI });
        const snap = loadPlaybookSnapshot(agentId);
        const pb = instance.getPlaybook();
        if (!pb) { sendJson(res, 500, { error: 'Playbook handle not available' }); return; }
        if (snap) pb.load(snap);
        await pb.update({
          example: body.example ?? {},
          prediction: body.prediction ?? {},
          feedback: body.feedback.trim(),
        });
        const newSnapshot = pb.getState();
        savePlaybookSnapshot(agentId, newSnapshot);
        appendPlaybookEvent(agentId, {
          ts: new Date().toISOString(),
          status: 'manual-update',
          feedback: body.feedback.trim(),
        });
        sendJson(res, 200, {
          ok: true,
          bulletCount: newSnapshot.playbook.stats.bulletCount,
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/playbooks/:agentId/evolve — batch verified evolve (Slice B3)
    if (req.method === 'POST' && url.startsWith('/api/playbooks/') && url.endsWith('/evolve')) {
      const pathPart = (url.split('?')[0] ?? '');
      const agentId = pathPart.split('/api/playbooks/')[1]?.replace('/evolve', '');
      if (!agentId) { sendJson(res, 400, { error: 'Missing agent id' }); return; }
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) { sendJson(res, 404, { error: `Agent ${agentId} not found` }); return; }
      if (_evolving.has(agentId)) {
        sendJson(res, 409, { error: `Evolve already running for ${agentId}` });
        return;
      }

      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw || '{}') as {
          datasetId?: string;
          maxProposals?: number;
          runsPerTask?: number;
        };
        if (!body.datasetId) {
          sendJson(res, 400, { error: 'datasetId is required' });
          return;
        }

        // Load dataset from tests/fixtures
        const { readFileSync, existsSync } = await import('node:fs');
        const filePath = resolve(process.cwd(), 'tests', 'fixtures', `${body.datasetId}.json`);
        if (!existsSync(filePath)) {
          sendJson(res, 404, { error: `Dataset ${body.datasetId} not found` });
          return;
        }
        const rawData = JSON.parse(readFileSync(filePath, 'utf8'));
        const rawCases: Array<{ id?: string; input: unknown; expected?: unknown }> =
          Array.isArray(rawData.cases) ? rawData.cases : [];
        if (rawCases.length === 0) {
          sendJson(res, 400, { error: 'Dataset is empty' });
          return;
        }

        // Map to AxAgentEvalTask
        type EvalTask = { input: unknown; criteria: string; id?: string; expectedOutput?: unknown };
        const tasks: EvalTask[] = rawCases.map((c) => ({
          id: c.id,
          input: c.input,
          criteria: 'Matches expected output criteria',
          expectedOutput: c.expected,
        }));

        // Split train/validation: 70/30, at least 1 validation
        const splitIdx = Math.max(1, Math.floor(tasks.length * 0.7));
        const dataset = {
          train: tasks.slice(0, splitIdx),
          validation: tasks.slice(splitIdx),
        };

        // SSE stream
        cors(res);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const emit = (event: string, data: unknown) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        _evolving.add(agentId);
        try {
          const { buildAgentInstance } = await import('../runtime/executor.js');
          const { loadPlaybookSnapshot, savePlaybookSnapshot, appendPlaybookEvent } = await import('../playbooks/persist.js');
          const { createModelClient } = await import('../ai/clients.js');
          const studentAI = createModelClient(agent.modelTier, agent.model);
          const teacherAI = createModelClient(agent.modelTier, agent.model);
          const instance = buildAgentInstance(agent, { studentAI, teacherAI });
          const snap = loadPlaybookSnapshot(agentId);
          const pb = instance.getPlaybook();
          if (!pb) {
            emit('error', { error: 'Playbook handle not available' });
            res.end();
            return;
          }
          if (snap) pb.load(snap);

          const result = await pb.evolve(dataset as any, {
            verify: true,
            studentAI,
            teacherAI,
            maxProposals: body.maxProposals ?? 3,
            runsPerTask: body.runsPerTask ?? 2,
            onProgress: (event) => {
              emit('progress', {
                agentId,
                phase: event.phase,
                message: event.message,
                metricCallsUsed: event.metricCallsUsed,
              });
            },
          });

          // Persist snapshot if we got one
          const newSnapshot = result.playbookSnapshot ?? pb.getState();
          savePlaybookSnapshot(agentId, newSnapshot);
          appendPlaybookEvent(agentId, {
            ts: new Date().toISOString(),
            status: 'evolve',
            feedback: `Evolve: ${result.outcomes.filter((o) => o.accepted).length} accepted of ${result.outcomes.length} proposals`,
          });

          emit('done', {
            agentId,
            baseline: result.baseline,
            final: result.final,
            outcomes: result.outcomes.map((o) => ({
              accepted: o.accepted,
              reason: o.reason,
              heldIn: o.heldIn,
            })),
            bulletCount: newSnapshot.playbook.stats.bulletCount,
            metricCallsUsed: result.metricCallsUsed,
          });
        } finally {
          _evolving.delete(agentId);
        }
        res.end();
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    sendJson(res, 404, {
      error: { message: `Not found: ${req.method} ${url}`, type: 'not_found' },
    });
  }

  await new Promise<void>((resolveListen) => {
    server.listen(port, () => resolveListen());
  });

  console.log(`Ax Brain Crew — OpenAI-compatible server on http://127.0.0.1:${port}`);
  console.log(`  Chat endpoint: POST http://127.0.0.1:${port}/v1/chat/completions`);
  console.log(`  Models:        GET  http://127.0.0.1:${port}/v1/models`);
  console.log(
    `  Point an OpenAI-compatible client here. Model "crew" auto-routes; ` +
      `or pick an agent: ${agents.map((a) => a.id).join(', ')}.`,
  );
  if (config.dryRun) console.log('  (DRY_RUN is on — writes are previewed, not saved.)');
}
