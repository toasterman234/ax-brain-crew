import { ai, type AxAIOpenAI } from '@ax-llm/ax';
import { getConfig } from '../config.js';
import type { ModelTier } from '../config.js';
import { buildModelInfo } from './model-capabilities.js';

/**
 * Resolve the concrete model id for a tier, honoring a per-agent override.
 * Exported so the executor can look up the same model id the client will use
 * (to pick the right tool-calling mode from the capability map).
 */
export function resolveModelId(
  tier: ModelTier,
  modelOverride?: string,
): string {
  const config = getConfig();
  return modelOverride ?? config.modelTiers[tier];
}

export function createModelClient(
  tier: ModelTier,
  modelOverride?: string,
): AxAIOpenAI {
  const config = getConfig();
  const modelName = resolveModelId(tier, modelOverride);

  // TRANSPORT — kept as the generic `openai` provider on purpose.
  //
  // The crew currently reaches DeepSeek through the commandcode OpenAI-
  // compatible proxy (127.0.0.1:8787/v1). As of ax v23 the native `deepseek`
  // provider IGNORES `apiURL` and hardcodes https://api.deepseek.com (verified
  // at runtime — it authenticates against the real DeepSeek API and rejects the
  // proxy key). The `openai` provider is the only built-in one that honors
  // `apiURL` for a custom endpoint, so all proxy-fronted models use it.
  //
  // To move a model onto a real first-class provider later (e.g. a genuinely
  // hosted Claude/GPT with native tool calling), this is the ONE place to
  // change: swap `name` and drop `apiURL`. Tool-calling behavior itself is NOT
  // hardcoded here — it travels with the model via the capability map (see
  // src/ai/model-capabilities.ts) and is applied at forward() in the executor.
  //
  // Any per-model capability flags (e.g. "can't do JSON-schema structured
  // outputs") come from that same map as `modelInfo` and are passed to ai()
  // below. Unlisted models pass `undefined` → ai() keeps its own defaults.
  const modelInfo = buildModelInfo(modelName);

  return ai({
    name: 'openai' as const,
    apiKey: config.proxyApiKey,
    apiURL: config.proxyBaseUrl,
    config: { model: modelName as any },
    ...(modelInfo ? { modelInfo } : {}),
  }) as unknown as AxAIOpenAI;
}

export function createRouterClient(): AxAIOpenAI {
  return createModelClient('router');
}

export function createFastClient(): AxAIOpenAI {
  return createModelClient('fast');
}

export function createSmartClient(): AxAIOpenAI {
  return createModelClient('smart');
}

/**
 * E5 GEPA reflection/teacher client — the Zima LiteLLM gateway, NOT the DeepSeek
 * runtime proxy. Points at the `reflection-chat` model group (Gemini Studio →
 * shared free pools → gpt-5.4-mini last). Used only by the offline optimizer
 * (scripts/optimize-router.ts) as the reflection model. Throws if
 * REFLECTION_API_KEY is unset so optimize fails loudly, not silently.
 */
export function createReflectionClient(): AxAIOpenAI {
  const config = getConfig();
  if (!config.reflectionApiKey) {
    throw new Error(
      'REFLECTION_API_KEY is not set — GEPA reflection model unavailable. ' +
        'Set it in .env (Zima LiteLLM virtual key for reflection-chat).',
    );
  }
  return ai({
    name: 'openai' as const,
    apiKey: config.reflectionApiKey,
    apiURL: config.reflectionBaseUrl,
    config: { model: config.reflectionModel as any },
  }) as unknown as AxAIOpenAI;
}
