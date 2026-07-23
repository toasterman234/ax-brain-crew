import { Langfuse } from 'langfuse';
import { getLogger } from './logger.js';

let _client: Langfuse | null = null;
let _initialized = false;

/**
 * Returns a shared Langfuse client, or null when tracing is disabled or the
 * credentials are absent. Tracing must never be a hard dependency — every call
 * site treats a null client as "skip tracing".
 */
export function getLangfuse(): Langfuse | null {
  if (_initialized) return _client;
  _initialized = true;

  const enabled = process.env.LANGFUSE_TRACING !== 'false';
  const publicKey =
    process.env.LANGFUSE_PUBLIC_KEY ?? process.env.QODER_LANGFUSE_PUBLIC_KEY;
  const secretKey =
    process.env.LANGFUSE_SECRET_KEY ?? process.env.QODER_LANGFUSE_SECRET_KEY;
  const baseUrl =
    process.env.LANGFUSE_BASEURL ??
    process.env.LANGFUSE_BASE_URL ??
    process.env.QODER_LANGFUSE_BASE_URL;

  if (!enabled || !publicKey || !secretKey || !baseUrl) {
    return null;
  }

  try {
    _client = new Langfuse({ publicKey, secretKey, baseUrl });
    getLogger().info({ baseUrl }, 'Langfuse tracing enabled');
  } catch (err) {
    getLogger().warn({ err: String(err) }, 'Langfuse init failed — tracing off');
    _client = null;
  }
  return _client;
}

/** Flush pending events; safe to call when tracing is disabled. */
export async function flushLangfuse(): Promise<void> {
  if (!_client) return;
  try {
    await _client.flushAsync();
  } catch (err) {
    getLogger().warn({ err: String(err) }, 'Langfuse flush failed');
  }
}
