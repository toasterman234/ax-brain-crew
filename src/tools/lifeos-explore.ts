import { getLogger } from '../observability/logger.js';

// life.query — read-only HTTP tool over the Life OS semantic-search API.
// Pattern copied from github-explore.ts. Read-only by construction: the only
// call is a search. This reaches real financial/health data, so it is gated to
// the Seeker agent ONLY in crew/registry.yaml.
//
// REST surface (confirmed live this session at http://127.0.0.1:8447):
//   POST /search { query, top_k } -> { results: [{ rank, score, record_id,
//                                                   source, chunk, ... }] }
// No auth observed on the loopback endpoint. Degrades to "not configured" when
// the base URL is unset/unreachable.

let _baseUrl: string | null = null;

export function setLifeosBaseUrl(baseUrl: string): void {
  _baseUrl = baseUrl && baseUrl.length > 0 ? baseUrl.replace(/\/$/, '') : null;
}

export function isLifeosConfigured(): boolean {
  return _baseUrl !== null && _baseUrl.length > 0;
}

export interface LifeResult {
  rank?: number;
  score?: number;
  source?: string;
  recordId?: string;
  text?: string;
}

export async function lifeQuery(question: string, topK = 5): Promise<LifeResult[]> {
  const logger = getLogger();

  if (!isLifeosConfigured()) {
    logger.warn('Life OS not configured for life.query operation');
    throw new Error('Life OS not configured. Set LIFEOS_BASE_URL in .env');
  }

  const response = await fetch(`${_baseUrl}/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'ax-brain-crew-lifeos',
    },
    body: JSON.stringify({ query: question, top_k: Math.min(topK, 20) }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Life OS API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const data: any = await response.json();
  const raw = Array.isArray(data?.results) ? data.results : [];
  const results: LifeResult[] = raw.map((r: any) => ({
    rank: r.rank,
    score: r.score,
    source: r.source ?? undefined,
    recordId: r.record_id ?? undefined,
    text: (r.chunk ?? r.text ?? r.content ?? '').slice(0, 400),
  }));

  logger.info({ question, count: results.length }, 'lifeQuery completed');
  return results;
}
