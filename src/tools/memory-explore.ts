import { getLogger } from '../observability/logger.js';

// memory.recall / memory.save — plain HTTP tools over the agentmemory REST API.
// Pattern copied from github-explore.ts: module-level config + isXConfigured()
// guard + graceful "not configured" fallback.
//
// NOTE: the agentmemory store is VOLATILE — it was wiped in mid-July 2026 and
// has no TTL/durability guarantee. recall() therefore may legitimately return
// zero results even when the server is healthy; callers must handle empty.
//
// REST surface (probed live 2026-07-19 at http://127.0.0.1:3111/agentmemory):
//   POST /search   { query, limit }  -> { results: [{ observation: {...} }] }
//                                        (may be empty; /recall is 404/unmounted)
//   POST /remember { content }        -> { memory: { id, ... }, success: true }
// Each search `observation` carries: id, title, subtitle, narrative (content),
// timestamp (created-at). We map narrative -> content, timestamp -> createdAt.
// Auth: Authorization: Bearer <AGENTMEMORY_SECRET>. Without a secret the server
// returns empty rather than erroring, so recall degrades to "no results".

let _baseUrl: string | null = null;
let _secret: string | null = null;

export function setMemoryCredentials(baseUrl: string, secret: string): void {
  _baseUrl = baseUrl && baseUrl.length > 0 ? baseUrl.replace(/\/$/, '') : null;
  _secret = secret && secret.length > 0 ? secret : null;
}

export function isMemoryConfigured(): boolean {
  return _baseUrl !== null && _baseUrl.length > 0;
}

function memHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'ax-brain-crew-memory',
  };
  if (_secret) headers.Authorization = `Bearer ${_secret}`;
  return headers;
}

async function memFetch(path: string, body: unknown): Promise<any> {
  /* returns parsed JSON as any */
  if (!_baseUrl) {
    throw new Error(
      'Memory not configured. Set AGENTMEMORY_BASE_URL (and AGENTMEMORY_SECRET) in .env',
    );
  }

  const response = await fetch(`${_baseUrl}${path}`, {
    method: 'POST',
    headers: memHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`agentmemory API error ${response.status}: ${text.slice(0, 200)}`);
  }

  return response.json();
}

async function memGet(path: string, query?: Record<string, string | number | undefined>): Promise<any> {
  /* returns parsed JSON as any (GET counterpart of memFetch) */
  if (!_baseUrl) {
    throw new Error(
      'Memory not configured. Set AGENTMEMORY_BASE_URL (and AGENTMEMORY_SECRET) in .env',
    );
  }

  const qs = query
    ? Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  const url = `${_baseUrl}${path}${qs ? `?${qs}` : ''}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: memHeaders(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`agentmemory API error ${response.status}: ${text.slice(0, 200)}`);
  }

  return response.json();
}

export interface RecalledMemory {
  id: string;
  title: string;
  content: string;
  createdAt?: string;
}

export async function memoryRecall(query: string, limit = 5): Promise<RecalledMemory[]> {
  const logger = getLogger();

  if (!isMemoryConfigured()) {
    logger.warn('Memory not configured for memory.recall operation');
    throw new Error('Memory not configured.');
  }

  const data = await memFetch('/search', { query, limit: Math.min(limit, 25) });
  // The store is volatile — an empty list is a normal, expected outcome.
  const raw = Array.isArray(data?.results) ? data.results : [];
  const memories: RecalledMemory[] = raw.map((r: any) => {
    const o = r?.observation ?? r ?? {};
    return {
      id: o.id ?? '',
      title: o.title ?? o.subtitle ?? '',
      content: String(o.narrative ?? o.content ?? '').slice(0, 500),
      createdAt: o.timestamp ?? o.createdAt,
    };
  });

  logger.info({ query, count: memories.length }, 'memoryRecall completed');
  return memories;
}

export interface SaveResult {
  operation: 'saved' | 'dry-run';
  content: string;
  id?: string;
}

export async function memorySave(
  content: string,
  dryRun: boolean,
): Promise<SaveResult> {
  const logger = getLogger();

  if (!isMemoryConfigured()) {
    logger.warn('Memory not configured for memory.save operation');
    throw new Error('Memory not configured.');
  }

  // Honor crew DRY_RUN semantics: preview, do not write.
  if (dryRun) {
    logger.info({ content: content.slice(0, 80) }, 'memorySave dry-run (not written)');
    return { operation: 'dry-run', content };
  }

  const data = await memFetch('/remember', { content });
  const savedId = data?.memory?.id ?? data?.id;
  logger.info({ id: savedId }, 'memorySave completed');
  return { operation: 'saved', content, id: savedId };
}

// ---------------------------------------------------------------------------
// Full-fidelity session tools — dedicated agentmemory session/timeline routes.
// Same VOLATILE-store contract as recall: an empty result is a normal, expected
// outcome, never an error. Routes confirmed against the agentmemory 0.9.27 REST
// reference (117 registered endpoints):
//   GET  /sessions           -> { sessions: [{ id, project, cwd, startedAt,
//                                 status, observationCount, title, ... }] }
//   POST /timeline { anchor } -> { observations: [{ id, title, narrative,
//                                 timestamp, ... }] }
// There is NO /recap route — agentmemory's "recap" is an action skill built on
// /sessions (list recent, group by date). So memory.recap is implemented here
// as a recent-sessions rollup over the same /sessions data, not a new endpoint.
// ---------------------------------------------------------------------------

export interface SessionSummary {
  id: string;
  project?: string;
  cwd?: string;
  startedAt?: string;
  status?: string;
  observationCount?: number;
  title?: string;
}

function mapSession(s: any): SessionSummary {
  return {
    id: s?.id ?? s?.sessionId ?? '',
    project: s?.project,
    cwd: s?.cwd,
    startedAt: s?.startedAt ?? s?.started_at ?? s?.timestamp,
    status: s?.status,
    observationCount: s?.observationCount ?? s?.observation_count ?? s?.obs,
    title: s?.title ?? s?.summary ?? s?.firstPrompt,
  };
}

export async function memorySessions(limit = 20): Promise<SessionSummary[]> {
  const logger = getLogger();

  if (!isMemoryConfigured()) {
    logger.warn('Memory not configured for memory.sessions operation');
    throw new Error('Memory not configured.');
  }

  const data = await memGet('/sessions', { limit: Math.min(limit, 100) });
  // Volatile store — an empty list is a normal, expected outcome.
  const raw = Array.isArray(data?.sessions)
    ? data.sessions
    : Array.isArray(data?.results)
      ? data.results
      : Array.isArray(data)
        ? data
        : [];
  const sessions: SessionSummary[] = raw.map(mapSession);

  logger.info({ count: sessions.length }, 'memorySessions completed');
  return sessions;
}

export interface Recap {
  sessionCount: number;
  sessions: SessionSummary[];
}

export async function memoryRecap(limit = 10): Promise<Recap> {
  const logger = getLogger();

  if (!isMemoryConfigured()) {
    logger.warn('Memory not configured for memory.recap operation');
    throw new Error('Memory not configured.');
  }

  // Recap = recent-sessions rollup, newest-first. Built on /sessions since
  // agentmemory exposes no dedicated /recap route (it is an action skill).
  const sessions = (await memorySessions(limit)).sort((a, b) => {
    const ta = a.startedAt ? Date.parse(a.startedAt) : 0;
    const tb = b.startedAt ? Date.parse(b.startedAt) : 0;
    return tb - ta;
  });

  logger.info({ count: sessions.length }, 'memoryRecap completed');
  return { sessionCount: sessions.length, sessions };
}

export async function memoryTimeline(
  anchor: string,
  before = 5,
  after = 5,
): Promise<RecalledMemory[]> {
  const logger = getLogger();

  if (!isMemoryConfigured()) {
    logger.warn('Memory not configured for memory.timeline operation');
    throw new Error('Memory not configured.');
  }

  const data = await memFetch('/timeline', { anchor, before, after });
  // Volatile store — an empty list is a normal, expected outcome.
  const raw = Array.isArray(data?.observations)
    ? data.observations
    : Array.isArray(data?.results)
      ? data.results
      : [];
  const timeline: RecalledMemory[] = raw.map((r: any) => {
    const o = r?.observation ?? r ?? {};
    return {
      id: o.id ?? '',
      title: o.title ?? o.subtitle ?? '',
      content: String(o.narrative ?? o.content ?? '').slice(0, 500),
      createdAt: o.timestamp ?? o.createdAt,
    };
  });

  logger.info({ anchor, count: timeline.length }, 'memoryTimeline completed');
  return timeline;
}
