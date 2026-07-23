import type { AxModelInfo } from '@ax-llm/ax';

// ---------------------------------------------------------------------------
// Model-agnostic tool-calling capabilities
// ---------------------------------------------------------------------------
//
// Tool-calling behavior must travel WITH the model, not be hardcoded globally.
// The crew runs a changing mix of models over time (DeepSeek today; GPT/Claude
// tomorrow), and they disagree on native tool calling:
//
//   - DeepSeek V4 (pro/flash) does NOT support native `tool_choice`, so ax must
//     simulate function calling through prompt engineering (`functionCallMode:
//     'prompt'`). Emitting native tool_choice makes the model reject/misbehave.
//   - GPT / Claude have excellent native tool calling — forcing `'prompt'` on
//     them would cripple quality. They should use ax's default (`'auto'`).
//
// This map keys capability by model id with prefix/substring matching, so a new
// model swap is a one-line config change here, not a code change in the executor.

// ax v23 verified enum (node_modules/@ax-llm/ax/index.d.ts):
//   functionCallMode?: 'auto' | 'native' | 'prompt'
//     - 'auto'   : provider decides (ax default) — trust native tool calling
//     - 'native' : force the provider's native API (fails if unsupported)
//     - 'prompt' : simulate tool calls via prompt engineering (works anywhere)
export type FunctionCallMode = 'auto' | 'native' | 'prompt';

export interface ModelCapability {
  // How ax should drive tool/function calling for this model.
  functionCallMode: FunctionCallMode;
  // Optional per-model capability flags passed into ai() as `modelInfo` for the
  // matched model. Lets us tell ax e.g. that a model can't do JSON-schema
  // structured outputs. Only `name`, `supported`, `notSupported` etc. from
  // AxModelInfo are meaningful here; `name` is filled in automatically with the
  // resolved model id, so callers only need to set the capability flags.
  modelInfo?: Omit<AxModelInfo, 'name'>;
}

// ax's own defaults when a model isn't listed: trust the model's native tool
// calling and add no capability overrides. This is what makes the crew
// model-agnostic — unknown models are assumed to be well-behaved.
export const DEFAULT_CAPABILITY: ModelCapability = {
  functionCallMode: 'auto',
};

// Entries are matched by substring against the resolved model id (case-
// insensitive). Order matters only if patterns overlap — first match wins, so
// list more-specific patterns before broader ones.
interface CapabilityRule {
  // Substring to look for in the model id (e.g. 'deepseek/deepseek-v4').
  match: string;
  capability: ModelCapability;
}

const CAPABILITY_RULES: CapabilityRule[] = [
  // DeepSeek V4 pro/flash via the commandcode OpenAI-compatible proxy: no
  // native tool_choice, so simulate tool calls via prompt. Both known crew
  // models (deepseek/deepseek-v4-pro, deepseek/deepseek-v4-flash) match the
  // shared 'deepseek/deepseek-v4' prefix; a bare 'deepseek/' also catches any
  // future DeepSeek variant behind the same proxy.
  {
    match: 'deepseek/deepseek-v4',
    capability: { functionCallMode: 'prompt' },
  },
  {
    match: 'deepseek/',
    capability: { functionCallMode: 'prompt' },
  },

  // Gemini models behind the cliproxy OpenAI-compatible endpoint have been
  // reliable for plain generation, but tool-calling through the generic OpenAI
  // surface is still flaky with native tool_choice. Drive them through prompt-
  // simulated tool calls for stability.
  {
    match: 'gemini-',
    capability: { functionCallMode: 'prompt' },
  },

  // --- Example: native-capable models (uncomment / adjust on the next swap) ---
  // When you point a tier at a model with real native tool calling, add it here
  // with `functionCallMode: 'auto'` (or omit it entirely — 'auto' is already the
  // default for unlisted models). Listing it explicitly documents intent:
  //
  // { match: 'gpt-',    capability: { functionCallMode: 'auto' } },
  // { match: 'claude-', capability: { functionCallMode: 'auto' } },
  //
  // If a model can't do JSON-schema structured outputs, declare it too:
  // {
  //   match: 'some-weak-model',
  //   capability: {
  //     functionCallMode: 'prompt',
  //     modelInfo: { supported: { structuredOutputs: false } },
  //   },
  // },
];

/**
 * Resolve the tool-calling capability for a model id. Matches CAPABILITY_RULES
 * by case-insensitive substring; falls back to DEFAULT_CAPABILITY (ax-native
 * 'auto', no overrides) for any model not explicitly listed.
 */
export function getModelCapability(modelId: string): ModelCapability {
  const id = modelId.toLowerCase();
  for (const rule of CAPABILITY_RULES) {
    if (id.includes(rule.match.toLowerCase())) {
      return rule.capability;
    }
  }
  return DEFAULT_CAPABILITY;
}

/**
 * Build the `modelInfo` array to hand to ai() for a given model, or undefined
 * when the model has no capability overrides (so ai() keeps its own defaults).
 * The AxModelInfo `name` is set to the resolved model id so ax applies the flags
 * to the right model.
 */
export function buildModelInfo(modelId: string): AxModelInfo[] | undefined {
  const cap = getModelCapability(modelId);
  if (!cap.modelInfo) return undefined;
  return [{ name: modelId, ...cap.modelInfo }];
}
