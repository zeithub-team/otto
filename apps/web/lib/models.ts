/** Model-id prefixes that mark a cloud provider (see apps/desktop/src/server/providers.ts). */
export const CLOUD_PREFIXES = ['claude-cli/', 'codex-cli/', 'claude/', 'grok/', 'openrouter/', 'groq/', 'cerebras/', 'mistral/', 'gemini/', 'nvidia/', 'cohere/', 'zai/', 'cloudflare/', 'custom/', 'opencode/'] as const;

export const isCloudModel = (id: string): boolean => CLOUD_PREFIXES.some((p) => id.startsWith(p));

/** Short label for the model picker: cloud models get a ☁ and lose their provider prefix. */
export function displayModel(id: string): string {
  const prefix = CLOUD_PREFIXES.find((p) => id.startsWith(p));
  return prefix ? `☁ ${id.slice(prefix.length)}` : id;
}

/**
 * Preference order of cloud providers (also the sort order of the picker), the
 * order of CLOUD_PREFIXES. OpenCode is last: its model list is public, so it
 * shows up for ANY saved key, even an invalid one — it must never win the
 * automatic choice.
 */
const providerRank = (id: string): number => {
  const rank = CLOUD_PREFIXES.findIndex((p) => id.startsWith(p));
  return rank < 0 ? -1 : rank; // local models first
};

/** Local models first, then cloud models by provider preference, then by name. */
export function compareModels(a: string, b: string): number {
  return providerRank(a) - providerRank(b) || a.localeCompare(b);
}

/** Model to select when nothing valid is remembered. */
/** Local models to start with, best first (the first one the user has wins). */
export const PREFERRED_LOCAL = ['qwen3.6:35b', 'qwen3-coder:30b', 'qwen3.5:27b', 'gemma4:26b', 'qwen3.5:9b', 'gemma4:12b', 'qwen3.5:4b'];

export function pickDefaultModel(list: string[], preferred: string | string[] = PREFERRED_LOCAL): string | null {
  for (const p of Array.isArray(preferred) ? preferred : [preferred]) if (list.includes(p)) return p;
  return [...list].sort(compareModels)[0] ?? null;
}

// ---------------------------------------------------------------- picker data --

export type ProviderKey = 'local' | 'claudecli' | 'codexcli' | 'anthropic' | 'xai' | 'openrouter' | 'groq' | 'cerebras' | 'mistral' | 'gemini' | 'nvidia' | 'cohere' | 'zai' | 'cloudflare' | 'opencode' | 'custom';

export const PROVIDER_KEYS: ProviderKey[] = ['local', 'claudecli', 'codexcli', 'anthropic', 'xai', 'openrouter', 'groq', 'cerebras', 'mistral', 'gemini', 'nvidia', 'cohere', 'zai', 'cloudflare', 'opencode', 'custom'];

const PREFIX_TO_KEY: Record<string, ProviderKey> = {
  'claude-cli/': 'claudecli',
  'codex-cli/': 'codexcli',
  'claude/': 'anthropic',
  'grok/': 'xai',
  'openrouter/': 'openrouter',
  'groq/': 'groq',
  'cerebras/': 'cerebras',
  'mistral/': 'mistral',
  'gemini/': 'gemini',
  'nvidia/': 'nvidia',
  'cohere/': 'cohere',
  'zai/': 'zai',
  'cloudflare/': 'cloudflare',
  'opencode/': 'opencode',
  'custom/': 'custom',
};

/** Which provider a model id belongs to ('local' = Ollama). */
export function providerOf(id: string): ProviderKey {
  const prefix = CLOUD_PREFIXES.find((p) => id.startsWith(p));
  return prefix ? PREFIX_TO_KEY[prefix] : 'local';
}

/** Model id without the provider prefix. */
export function shortModelName(id: string): string {
  const prefix = CLOUD_PREFIXES.find((p) => id.startsWith(p));
  return prefix ? id.slice(prefix.length) : id;
}

export type ModelBadge = 'free' | 'vision' | 'reasoning' | 'coder' | 'small' | 'large';

/** Capability hints guessed from the name (the providers do not report them uniformly). */
export function modelBadges(id: string): ModelBadge[] {
  const name = shortModelName(id).toLowerCase();
  const out: ModelBadge[] = [];
  if (/:free\b|-free\b/.test(name)) out.push('free');
  if (/vision|(^|[-_:/.])vl\b|vl[-_:]|llava|pixtral|minicpm-v|gemma-?3|qwen2\.5vl|gpt-4o|gemini|claude|sonnet|opus|haiku/.test(name)) out.push('vision');
  if (/thinking|reason|(^|[-_:/.])r1\b|deepseek-r|qwen3|gpt-oss|o[134](-|$)|claude|sonnet|opus|magistral/.test(name)) out.push('reasoning');
  if (/coder|code|devstral|codestral|starcoder/.test(name)) out.push('coder');
  const size = /(\d+(?:\.\d+)?)b\b/.exec(name);
  if (size) {
    const b = Number(size[1]);
    if (b <= 8) out.push('small');
    else if (b >= 30) out.push('large');
  }
  return out;
}

// ---------------------------------------------------------------- parameters --

export type Effort = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max';
export const EFFORTS: Effort[] = ['auto', 'off', 'low', 'medium', 'high', 'max'];
export const CONTEXT_SIZES = [8192, 16384, 32768, 65536, 131072] as const;

export interface ModelParams {
  effort: Effort;
  /** Context window for local models; null = the Settings default. */
  numCtx: number | null;
  /** Sampling temperature; null = automatic. */
  temperature: number | null;
}

export const DEFAULT_PARAMS: ModelParams = { effort: 'auto', numCtx: null, temperature: null };
const PARAMS_KEY = 'otto-model-params';
const RECENT_KEY = 'otto-recent-models';

export function loadParams(): ModelParams {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PARAMS_KEY) ?? '{}') as Partial<ModelParams>;
    return {
      effort: EFFORTS.includes(raw.effort as Effort) ? (raw.effort as Effort) : 'auto',
      numCtx: typeof raw.numCtx === 'number' && raw.numCtx >= 2048 ? raw.numCtx : null,
      temperature: typeof raw.temperature === 'number' && raw.temperature >= 0 && raw.temperature <= 1 ? raw.temperature : null,
    };
  } catch {
    return DEFAULT_PARAMS;
  }
}

export function saveParams(params: ModelParams): void {
  try {
    window.localStorage.setItem(PARAMS_KEY, JSON.stringify(params));
  } catch { /* ignore */ }
}

export function loadRecent(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((m): m is string => typeof m === 'string').slice(0, 6) : [];
  } catch {
    return [];
  }
}

export function pushRecent(id: string): string[] {
  const next = [id, ...loadRecent().filter((m) => m !== id)].slice(0, 6);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  return next;
}

// ---------------------------------------------------------------- classes --

export type ModelClass = 'coding' | 'vision' | 'chat';

/** Rough class of a model by name: code models, image-understanding models, everything else is general chat. */
export function modelClass(id: string): ModelClass {
  const name = shortModelName(id).toLowerCase();
  if (/coder|codestral|devstral|starcoder|codellama|deepseek-coder|(^|[-_:/.])code([-_:.]|$)/.test(name)) return 'coding';
  if (/vision|(^|[-_:/.])vl\b|vl[-_:]|llava|pixtral|minicpm-v|moondream|bakllava|qwen2\.5vl|-vl-/.test(name)) return 'vision';
  return 'chat';
}
