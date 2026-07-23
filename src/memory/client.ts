// Agentmemory HTTP backend client — talks directly to the REST API at
// AGENTMEMORY_URL (default http://localhost:3111) instead of spawning an MCP
// stdio process. The backend accepts POST /agentmemory/mcp/call with
// { name: "memory_sessions" | "memory_smart_search", arguments: {} }.

const BASE = process.env.AGENTMEMORY_URL ?? 'http://localhost:3111';
const SECRET = process.env.AGENTMEMORY_SECRET ?? 'b883e2a608b6864fc65d236a9af142ef681e6eeb1b5c7f0e6bd0936f8317fd11';

async function callBackend(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(`${BASE}/agentmemory/mcp/call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SECRET}`,
    },
    body: JSON.stringify({ name: tool, arguments: args }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`agentmemory backend ${res.status}: ${body}`);
  }

  const data = await res.json() as { error?: string; content?: Array<{ type: string; text?: string }> };
  if (data.error) throw new Error(data.error);

  // Parse text content
  if (data.content) {
    for (const item of data.content) {
      if (item.type === 'text' && item.text) {
        try {
          return JSON.parse(item.text);
        } catch {
          return item.text;
        }
      }
    }
  }
  return data;
}

export interface MemorySession {
  id: string;
  firstPrompt?: string;
  project: string;
  startedAt: string;
  endedAt?: string;
  observationCount: number;
  status: string;
}

export interface MemorySearchResult {
  obsId: string;
  sessionId: string;
  timestamp: string;
  title: string;
  type: string;
  score: number;
}

/** Get recent sessions with firstPrompt, project, timestamps */
export async function getMemorySessions(): Promise<MemorySession[]> {
  const result = await callBackend('memory_sessions', {}) as { sessions?: MemorySession[] };
  return result?.sessions ?? [];
}

/** Search memories by query */
export async function searchMemory(query: string, limit = 10): Promise<MemorySearchResult[]> {
  const result = await callBackend('memory_smart_search', { query, limit }) as {
    results?: MemorySearchResult[];
  };
  return result?.results ?? [];
}
