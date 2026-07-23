import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getLogger } from '../observability/logger.js';

// web.search / web.fetch — the crew's reach onto the open web.
//
// TWO SEPARATE TOOLS, TWO SEPARATE CONCERNS (per crew-web-tool-design.md §1):
//   - web.search : HTTP to the Serper (Google Search) API. Needs a Serper key,
//                  read from SERPER_API_KEY or ~/.life/secrets/serper.env (the
//                  same key Life OS uses). Copies the github-explore.ts pattern —
//                  module-level key + isWebConfigured() + a graceful "not
//                  configured" STRING (never a throw into the agent loop) when
//                  the key is unset.
//   - web.fetch  : a plain, KEYLESS fetch(url) -> text (HTML stripped to body
//                  text). Distinct so the provider can be swapped without
//                  touching fetch, and so an agent can fetch a pasted URL with no
//                  search at all. Carries its own SSRF/size/timeout guards (§5).
//
// Everything here must typecheck and degrade gracefully — never crash — when no
// Serper key is available from either source.

// ─────────────────────────────── web.search ───────────────────────────────

let _serperKey: string | null = null;

export function setWebCredentials(serperKey: string): void {
  _serperKey = serperKey && serperKey.length > 0 ? serperKey : null;
}

export function isWebConfigured(): boolean {
  return _serperKey !== null && _serperKey.length > 0;
}

export const WEB_NOT_CONFIGURED =
  'Web search not configured. Set SERPER_API_KEY in .env or ~/.life/secrets/serper.env';

export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
}

const SERPER_ENDPOINT = 'https://google.serper.dev/search';

/**
 * Query the Serper (Google Search) API. Throws only on a genuine API/network
 * error AFTER the key is present; the not-configured case is handled by the
 * caller returning WEB_NOT_CONFIGURED (github pattern). Retries once on HTTP 429
 * with a backoff (design §5).
 */
export async function webSearch(
  query: string,
  limit = 8,
): Promise<WebSearchResult[]> {
  const logger = getLogger();

  if (!isWebConfigured()) {
    logger.warn('Web search not configured for web.search operation');
    throw new Error(WEB_NOT_CONFIGURED);
  }

  const count = Math.min(Math.max(limit, 1), 20);

  const doFetch = async (): Promise<Response> =>
    fetch(SERPER_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-API-KEY': _serperKey as string,
        'Content-Type': 'application/json',
        'User-Agent': 'ax-brain-crew-seeker',
      },
      body: JSON.stringify({ q: query, num: count }),
    });

  let response = await doFetch();

  // One backoff-and-retry on rate limit (design §5).
  if (response.status === 429) {
    logger.warn('Serper Search 429 — backing off 1500ms then retrying once');
    await new Promise((r) => setTimeout(r, 1500));
    response = await doFetch();
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Serper Search API error ${response.status}: ${body.slice(0, 200)}`);
  }

  const data: any = await response.json();
  const raw = Array.isArray(data?.organic) ? data.organic : [];
  const results: WebSearchResult[] = raw.map((r: any) => ({
    title: String(r.title ?? '').trim(),
    url: String(r.link ?? '').trim(),
    description: String(r.snippet ?? '').replace(/<[^>]+>/g, '').trim(),
  }));

  logger.info({ query, count: results.length }, 'webSearch completed');
  return results;
}

// ─────────────────────────────── web.fetch ────────────────────────────────

const MAX_BYTES = 2 * 1024 * 1024; // ~2MB response cap (design §5)
const MAX_TEXT_CHARS = 8000; // ~8k chars of body text kept
const FETCH_TIMEOUT_MS = 15000; // 15s timeout

export interface WebFetchResult {
  url: string;
  ok: boolean;
  status?: number;
  text?: string;
  error?: string;
}

/**
 * SSRF guard: reject non-http(s) schemes and any URL that resolves to a
 * private / loopback / link-local / unspecified IP range. Returns an error
 * string when the URL is unsafe, or null when it is allowed to be fetched.
 */
async function ssrfGuard(target: URL): Promise<string | null> {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return `Blocked non-http(s) scheme: ${target.protocol}`;
  }

  const host = target.hostname;

  // If the host is already a literal IP, check it directly; otherwise resolve.
  const ipVersion = isIP(host);
  let addresses: string[];
  if (ipVersion) {
    addresses = [host];
  } else {
    try {
      const resolved = await lookup(host, { all: true });
      addresses = resolved.map((a) => a.address);
    } catch (err) {
      return `DNS resolution failed for ${host}: ${String(err)}`;
    }
  }

  for (const addr of addresses) {
    if (isPrivateAddress(addr)) {
      return `Blocked private/loopback address ${addr} for host ${host}`;
    }
  }

  return null;
}

function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split('.').map((n) => Number(n));
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 0) return true; // 0.0.0.0/8 unspecified
    if (a === 169 && b === 254) return true; // link-local 169.254/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true; // loopback / unspecified
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local fc00::/7
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — check embedded v4.
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return false;
  }
  // Unknown format — fail closed.
  return true;
}

/**
 * Strip HTML down to readable body text: drop script/style/nav/head chunks,
 * remove tags, collapse whitespace, cap length. Deliberately simple (no new
 * dependency) — good enough to feed a summarizer.
 */
function htmlToText(html: string): string {
  let text = html;
  // Remove whole blocks we never want.
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  text = text.replace(/<head[\s\S]*?<\/head>/gi, ' ');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, ' ');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  // Turn block boundaries into newlines so text stays readable.
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, '\n');
  // Drop all remaining tags.
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode a few common entities.
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Collapse whitespace.
  text = text.replace(/[ \t\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text.slice(0, MAX_TEXT_CHARS);
}

/**
 * Fetch a URL and return its body as text. Keyless. Never throws — returns a
 * structured {ok:false,error} on any failure so a worker loop can skip-and-
 * continue (design §5). Enforces SSRF guard + size + timeout caps.
 */
export async function webFetch(rawUrl: string): Promise<WebFetchResult> {
  const logger = getLogger();

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return { url: rawUrl, ok: false, error: 'Invalid URL' };
  }

  const blocked = await ssrfGuard(target);
  if (blocked) {
    logger.warn({ url: rawUrl, reason: blocked }, 'web.fetch blocked by SSRF guard');
    return { url: rawUrl, ok: false, error: blocked };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(target.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'ax-brain-crew-fetch',
        Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
      },
    });

    if (!response.ok) {
      return { url: rawUrl, ok: false, status: response.status, error: `HTTP ${response.status}` };
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!/text\/|html|xml|json|plain/i.test(contentType)) {
      return {
        url: rawUrl,
        ok: false,
        status: response.status,
        error: `Unsupported content-type: ${contentType || 'unknown'}`,
      };
    }

    // Read with a byte cap so a giant page can't blow memory.
    const reader = response.body?.getReader();
    if (!reader) {
      return { url: rawUrl, ok: false, status: response.status, error: 'No response body' };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_BYTES) {
          reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
      }
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const raw = buf.toString('utf8');
    const text = /html|xml/i.test(contentType) ? htmlToText(raw) : raw.slice(0, MAX_TEXT_CHARS);

    logger.info({ url: rawUrl, chars: text.length }, 'webFetch completed');
    return { url: rawUrl, ok: true, status: response.status, text };
  } catch (err) {
    const msg = controller.signal.aborted ? `Timed out after ${FETCH_TIMEOUT_MS}ms` : String(err);
    return { url: rawUrl, ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
