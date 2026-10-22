/**
 * Model capability registry — what each model family can actually do.
 *
 * The agent loop uses this to auto-select the right mode (native tool calling vs.
 * guided JSON), context size, temperature, and other settings instead of one-size-
 * fits-all defaults that work for big models but break small ones.
 *
 * A profile is matched by the Ollama model name (or cloud prefix). When no profile
 * matches, the model gets conservative defaults that work for most cases.
 */

export interface ModelProfile {
  /** Human-readable family name. */
  family: string;
  /** Can the model use Ollama's native tool-calling API reliably? */
  nativeTools: boolean;
  /** Recommended context window (num_ctx) — avoid over-allocating for small models. */
  contextWindow: number;
  /** Recommended max output tokens (num_predict). */
  maxOutput: number;
  /** Generation temperature: lower for guided, higher for creative. */
  temperature: number;
  /** Does the model support vision (image inputs)? */
  vision: boolean;
  /** Does the model have a thinking/reasoning mode? */
  thinking: boolean;
  /** Minimum VRAM in GB to run comfortably (0 = unknown / CPU-ok). */
  minVram: number;
}

const DEFAULTS: ModelProfile = {
  family: 'unknown',
  nativeTools: false,
  contextWindow: 8192,
  maxOutput: 4096,
  temperature: 0.2,
  vision: false,
  thinking: false,
  minVram: 0,
};

/**
 * Known model families: a regex on the Ollama model name → profile overrides.
 * Order matters: first match wins. The regex is tested against the full model id
 * (e.g. "hf.co/peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF:UD-IQ4_XS").
 */
const FAMILIES: Array<[RegExp, Partial<ModelProfile>]> = [
  // === Qwen family ===
  [/qwen3-coder|qwen3\.5/i, { family: 'qwen3-coder', nativeTools: true, contextWindow: 32768, maxOutput: 8192, temperature: 0.4, thinking: true }],
  [/qwen2\.5-coder/i, { family: 'qwen2.5-coder', nativeTools: false, contextWindow: 32768, maxOutput: 8192, temperature: 0.2 }],
  [/qwen3-vl/i, { family: 'qwen3-vl', nativeTools: true, contextWindow: 32768, maxOutput: 4096, temperature: 0.4, vision: true }],
  [/qwen3/i, { family: 'qwen3', nativeTools: true, contextWindow: 32768, maxOutput: 8192, temperature: 0.4, thinking: true }],
  [/qwen2/i, { family: 'qwen2', nativeTools: false, contextWindow: 32768, maxOutput: 4096, temperature: 0.2 }],

  // === Tiel (MoE, small active params) ===
  [/tiel/i, { family: 'tiel', nativeTools: true, contextWindow: 32768, maxOutput: 8192, temperature: 0.3 }],

  // === Gemma family ===
  [/gemma4/i, { family: 'gemma4', nativeTools: true, contextWindow: 32768, maxOutput: 8192, temperature: 0.4 }],
  [/gemma3/i, { family: 'gemma3', nativeTools: true, contextWindow: 16384, maxOutput: 4096, temperature: 0.4 }],
  [/gemma/i, { family: 'gemma', nativeTools: false, contextWindow: 8192, maxOutput: 4096, temperature: 0.3 }],

  // === DeepSeek ===
  [/deepseek-r1/i, { family: 'deepseek-r1', nativeTools: false, contextWindow: 32768, maxOutput: 8192, temperature: 0.2, thinking: true }],
  [/deepseek-coder/i, { family: 'deepseek-coder', nativeTools: false, contextWindow: 16384, maxOutput: 4096, temperature: 0.2 }],
  [/deepseek/i, { family: 'deepseek', nativeTools: false, contextWindow: 32768, maxOutput: 4096, temperature: 0.3 }],

  // === Llama family ===
  [/llama-?4/i, { family: 'llama4', nativeTools: true, contextWindow: 32768, maxOutput: 8192, temperature: 0.4 }],
  [/llama-?3\.3/i, { family: 'llama3.3', nativeTools: true, contextWindow: 32768, maxOutput: 8192, temperature: 0.4 }],
  [/llama-?3\.?[12]/i, { family: 'llama3', nativeTools: true, contextWindow: 16384, maxOutput: 4096, temperature: 0.4 }],
  [/llama/i, { family: 'llama', nativeTools: false, contextWindow: 8192, maxOutput: 4096, temperature: 0.3 }],

  // === Mistral / Codestral / Devstral ===
  [/devstral/i, { family: 'devstral', nativeTools: true, contextWindow: 32768, maxOutput: 8192, temperature: 0.3 }],
  [/codestral/i, { family: 'codestral', nativeTools: true, contextWindow: 32768, maxOutput: 8192, temperature: 0.3 }],
  [/mistral/i, { family: 'mistral', nativeTools: true, contextWindow: 32768, maxOutput: 4096, temperature: 0.3 }],

  // === Phi ===
  [/phi-?4/i, { family: 'phi4', nativeTools: true, contextWindow: 16384, maxOutput: 4096, temperature: 0.3 }],
  [/phi/i, { family: 'phi', nativeTools: false, contextWindow: 8192, maxOutput: 4096, temperature: 0.2 }],

  // === StarCoder / CodeGemma / CodeLlama ===
  [/starcoder/i, { family: 'starcoder', nativeTools: false, contextWindow: 8192, maxOutput: 4096, temperature: 0.2 }],
  [/codellama/i, { family: 'codellama', nativeTools: false, contextWindow: 8192, maxOutput: 4096, temperature: 0.2 }],

  // === GPT-OSS ===
  [/gpt-?oss/i, { family: 'gpt-oss', nativeTools: true, contextWindow: 32768, maxOutput: 8192, temperature: 0.4 }],

  // === Yi-Coder ===
  [/yi-coder/i, { family: 'yi-coder', nativeTools: false, contextWindow: 16384, maxOutput: 4096, temperature: 0.2 }],

  // === Internlm ===
  [/internlm/i, { family: 'internlm', nativeTools: false, contextWindow: 16384, maxOutput: 4096, temperature: 0.3 }],
];

/** Size bucket from model name (e.g. "qwen2.5-coder:14b" → 14). */
function sizeFromName(model: string): number | null {
  const m = model.match(/[:\-_](\d+(?:\.\d+)?)b\b/i);
  return m ? parseFloat(m[1]) : null;
}

/** Apply size-based adjustments to a profile. */
function applySizeAdjustments(profile: ModelProfile, model: string): ModelProfile {
  const size = sizeFromName(model);
  // Small models (≤3B active params) should always use guided mode
  if (size !== null && size <= 3) {
    profile.nativeTools = false;
    profile.maxOutput = Math.min(profile.maxOutput, 4096);
  }
  // Very small context for tiny models
  if (size !== null && size <= 1) {
    profile.contextWindow = Math.min(profile.contextWindow, 4096);
  }
  return profile;
}

/** Get the profile for a model, merging family defaults with size adjustments. */
export function modelProfile(model: string): ModelProfile {
  const lower = model.toLowerCase();
  for (const [re, overrides] of FAMILIES) {
    if (re.test(lower) || re.test(model)) {
      return applySizeAdjustments({ ...DEFAULTS, ...overrides }, model);
    }
  }
  return applySizeAdjustments({ ...DEFAULTS }, model);
}

/**
 * Should the agent use guided mode (structured JSON output, one action per turn)
 * for this model? Returns true for models without reliable native tool calling.
 *
 * The user can override with OTTO_LOCAL_MODE=guided|native|auto.
 */
export function shouldUseGuided(model: string, localMode: string): boolean {
  if (localMode === 'guided') return true;
  if (localMode === 'native') return false;
  // Cloud-hosted Ollama models (e.g. kimi-k3:cloud) are big and call tools natively
  if (/[:-]cloud$/i.test(model)) return false;
  const profile = modelProfile(model);
  return !profile.nativeTools;
}

/**
 * Recommended num_ctx for a model, capped to what the GPU can handle.
 * availableVram in GB; 0 means unknown (use the profile default).
 */
export function recommendedContext(model: string, availableVram = 0): number {
  const profile = modelProfile(model);
  let ctx = profile.contextWindow;
  // For models larger than available VRAM, halve context to save memory
  const size = sizeFromName(model);
  if (availableVram > 0 && size && size > availableVram * 0.8) {
    ctx = Math.min(ctx, 8192);
  }
  return ctx;
}

/** Temperature for a model — lower for weaker models, higher for capable ones. */
export function recommendedTemperature(model: string, toolsEnabled: boolean): number {
  const profile = modelProfile(model);
  // When tools are off (pure chat), allow slightly more creativity
  return toolsEnabled ? profile.temperature : Math.min(profile.temperature + 0.3, 0.8);
}
