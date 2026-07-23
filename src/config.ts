import { z } from 'zod';
import { config as dotenvLoad } from 'dotenv';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

// override:true so the project's .env wins over any inherited shell exports
// (e.g. a global OBSIDIAN_VAULT_PATH), which otherwise mis-resolve crew/ paths.
dotenvLoad({ override: true });

const envSchema = z.object({
  // LLM endpoint — any OpenAI-compatible API. Set these and you're done.
  // Falls back to PROXY_* for backward compat with Ben's existing setup.
  OPENAI_BASE_URL: z.string().url().optional().or(z.literal('')).default(''),
  OPENAI_API_KEY: z.string().optional().default(''),
  // Legacy proxy vars — used only when OPENAI_* is not set.
  PROXY_BASE_URL: z.string().url().default('http://127.0.0.1:8317/v1'),
  PROXY_API_KEY: z.string().default('sk-cliproxy'),
  // Vault path — optional. When absent, vault tools return "vault not configured".
  OBSIDIAN_VAULT_PATH: z.string().optional().default(''),
  EXTERNAL_VAULT_PATH: z.string().optional().default(''),
  // Demo mode — stubs personal integrations, uses demo agents + demo vault.
  CREW_DEMO_MODE: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .optional()
    .default('false'),
  ROUTER_MODEL: z.string().min(1).default('gpt-5.4-mini'),
  FAST_MODEL: z.string().min(1).default('gpt-5.4-mini'),
  SMART_MODEL: z.string().min(1).default('gpt-5.4'),
  DATABASE_PATH: z.string().default('./data/crew.sqlite'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  MAX_HANDOFF_DEPTH: z.coerce.number().int().positive().default(3),
  DRY_RUN: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('true'),
  ROUTING_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  ROUTING_CLARIFY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.55),
  SCOUT_ALLOWED_PATHS: z.string().optional().default(''),
  GITHUB_TOKEN: z.string().optional().default(''),
  GITHUB_USER: z.string().optional().default(''),
  // agentmemory REST server (memory.recall / memory.save). Confirmed live at
  // http://127.0.0.1:3111/agentmemory this session; auth is a Bearer secret.
  AGENTMEMORY_BASE_URL: z.string().url().default('http://127.0.0.1:3111/agentmemory'),
  AGENTMEMORY_SECRET: z.string().optional().default(''),
  // Life OS semantic-search API (life.query). Confirmed live at
  // http://127.0.0.1:8447 with a POST /search route this session.
  LIFEOS_BASE_URL: z.string().url().default('http://127.0.0.1:8447'),
  // Serper (Google Search) API (web.search). Read from SERPER_API_KEY, or fall
  // back to ~/.life/secrets/serper.env (see loadSerperKey). Web tools degrade
  // gracefully to a "not configured" string when no key is found.
  SERPER_API_KEY: z.string().optional().default(''),
  VAULT_EXCLUDED_DIRS: z.string().optional().default(''),
  // E5 GEPA reflection model — the Zima LiteLLM gateway. A `reflection-chat`
  // model group there fronts Gemini Studio (free) and falls back through the
  // shared free pools to gpt-5.4-mini (paid cliproxy) LAST, so optimize runs
  // survive free-tier 429s. Separate from the DeepSeek runtime proxy above.
  // Key blank by default → optimize refuses to run until set (offline tooling).
  REFLECTION_BASE_URL: z.string().url().default('http://192.168.1.121:4000/v1'),
  REFLECTION_API_KEY: z.string().optional().default(''),
  REFLECTION_MODEL: z.string().min(1).default('reflection-chat'),
  // Hard ceiling (ms) on a single agent's LLM turn. A hung commandcode proxy
  // call would otherwise leave a run stuck in 'started' forever (see
  // root-cause-analysis-2026-07-19). On expiry the forward() aborts and the run
  // is finalized as failed. Default 120s.
  CREW_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
});

/**
 * Resolve the Serper key: env var first, then ~/.life/secrets/serper.env
 * (format `SERPER_API_KEY=...`, value may be quoted). Same key Life OS uses.
 */
function loadSerperKey(): string {
  const fromEnv = (process.env.SERPER_API_KEY ?? '').trim();
  if (fromEnv) return fromEnv;

  const secretPath = resolve(homedir(), '.life/secrets/serper.env');
  if (!existsSync(secretPath)) return '';
  try {
    const contents = readFileSync(secretPath, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (key !== 'SERPER_API_KEY') continue;
      let value = trimmed.slice(eq + 1).trim();
      // Strip surrounding single or double quotes.
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      return value.trim();
    }
  } catch {
    return '';
  }
  return '';
}

function parseRawEnv() {
  const result = envSchema.safeParse({
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CREW_DEMO_MODE: process.env.CREW_DEMO_MODE,
    OBSIDIAN_VAULT_PATH: process.env.OBSIDIAN_VAULT_PATH,
    EXTERNAL_VAULT_PATH: process.env.EXTERNAL_VAULT_PATH,
    PROXY_BASE_URL: process.env.PROXY_BASE_URL,
    PROXY_API_KEY: process.env.PROXY_API_KEY,
    ROUTER_MODEL: process.env.ROUTER_MODEL,
    FAST_MODEL: process.env.FAST_MODEL,
    SMART_MODEL: process.env.SMART_MODEL,
    DATABASE_PATH: process.env.DATABASE_PATH,
    LOG_LEVEL: process.env.LOG_LEVEL,
    MAX_HANDOFF_DEPTH: process.env.MAX_HANDOFF_DEPTH,
    DRY_RUN: process.env.DRY_RUN,
    ROUTING_CONFIDENCE_THRESHOLD: process.env.ROUTING_CONFIDENCE_THRESHOLD,
    ROUTING_CLARIFY_THRESHOLD: process.env.ROUTING_CLARIFY_THRESHOLD,
    SCOUT_ALLOWED_PATHS: process.env.SCOUT_ALLOWED_PATHS,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GITHUB_USER: process.env.GITHUB_USER,
    AGENTMEMORY_BASE_URL: process.env.AGENTMEMORY_BASE_URL,
    AGENTMEMORY_SECRET: process.env.AGENTMEMORY_SECRET,
    LIFEOS_BASE_URL: process.env.LIFEOS_BASE_URL,
    SERPER_API_KEY: loadSerperKey(),
    VAULT_EXCLUDED_DIRS: process.env.VAULT_EXCLUDED_DIRS,
    REFLECTION_BASE_URL: process.env.REFLECTION_BASE_URL,
    REFLECTION_API_KEY: process.env.REFLECTION_API_KEY,
    REFLECTION_MODEL: process.env.REFLECTION_MODEL,
    CREW_LLM_TIMEOUT_MS: process.env.CREW_LLM_TIMEOUT_MS,
  });

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuration error:\n${issues}`);
  }

  return result.data;
}

export type ModelTier = 'router' | 'fast' | 'smart';

export interface AppConfig {
  obsidianVaultPath: string;
  externalVaultPath: string;
  proxyBaseUrl: string;
  proxyApiKey: string;
  demoMode: boolean;
  modelTiers: {
    router: string;
    fast: string;
    smart: string;
  };
  databasePath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  maxHandoffDepth: number;
  dryRun: boolean;
  routingConfidenceThreshold: number;
  routingClarifyThreshold: number;
  scoutAllowedPaths: string;
  githubToken: string;
  githubUser: string;
  agentmemoryBaseUrl: string;
  agentmemorySecret: string;
  lifeosBaseUrl: string;
  serperApiKey: string;
  vaultExcludedDirs: string[];
  reflectionBaseUrl: string;
  reflectionApiKey: string;
  reflectionModel: string;
  llmTimeoutMs: number;
}

function buildConfig(raw: z.infer<typeof envSchema>): AppConfig {
  const excludedDirs = raw.VAULT_EXCLUDED_DIRS
    ? raw.VAULT_EXCLUDED_DIRS.split(',')
        .map((d) => d.trim().replace(/\/$/, ''))
        .filter(Boolean)
    : [];

  // Resolve LLM endpoint: OPENAI_* wins, then PROXY_* for backward compat.
  const llmBaseUrl = raw.OPENAI_BASE_URL || raw.PROXY_BASE_URL;
  const llmApiKey = raw.OPENAI_API_KEY || raw.PROXY_API_KEY;

  return {
    obsidianVaultPath: raw.OBSIDIAN_VAULT_PATH || '',
    externalVaultPath: raw.EXTERNAL_VAULT_PATH || '',
    proxyBaseUrl: llmBaseUrl,
    proxyApiKey: llmApiKey,
    demoMode: raw.CREW_DEMO_MODE === true,
    modelTiers: {
      router: raw.ROUTER_MODEL,
      fast: raw.FAST_MODEL,
      smart: raw.SMART_MODEL,
    },
    databasePath: raw.DATABASE_PATH,
    logLevel: raw.LOG_LEVEL,
    maxHandoffDepth: raw.MAX_HANDOFF_DEPTH,
    dryRun: raw.DRY_RUN,
    routingConfidenceThreshold: raw.ROUTING_CONFIDENCE_THRESHOLD,
    routingClarifyThreshold: raw.ROUTING_CLARIFY_THRESHOLD,
    scoutAllowedPaths: raw.SCOUT_ALLOWED_PATHS,
    githubToken: raw.GITHUB_TOKEN,
    githubUser: raw.GITHUB_USER,
    agentmemoryBaseUrl: raw.AGENTMEMORY_BASE_URL,
    agentmemorySecret: raw.AGENTMEMORY_SECRET,
    lifeosBaseUrl: raw.LIFEOS_BASE_URL,
    serperApiKey: raw.SERPER_API_KEY,
    vaultExcludedDirs: excludedDirs,
    reflectionBaseUrl: raw.REFLECTION_BASE_URL,
    reflectionApiKey: raw.REFLECTION_API_KEY,
    reflectionModel: raw.REFLECTION_MODEL,
    llmTimeoutMs: raw.CREW_LLM_TIMEOUT_MS,
  };
}

let _config: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (_config) return _config;

  try {
    const raw = parseRawEnv();
    _config = buildConfig(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(`Configuration error:\n${issues}`);
    }
    throw err;
  }

  return _config;
}

export function getConfig(): AppConfig {
  if (!_config) return loadConfig();
  return _config;
}

export function validatePaths(config: AppConfig): string[] {
  const errors: string[] = [];

  // Vault is optional — only validate if configured.
  if (config.obsidianVaultPath) {
    const vaultPath = resolve(config.obsidianVaultPath);
    if (!existsSync(vaultPath)) {
      errors.push(`Vault path does not exist: ${vaultPath}`);
    } else if (!statSync(vaultPath).isDirectory()) {
      errors.push(`Vault path is not a directory: ${vaultPath}`);
    }
  }

  return errors;
}

export function getVaultPath(config: AppConfig): string {
  if (!config.obsidianVaultPath) return '';
  return resolve(config.obsidianVaultPath);
}
