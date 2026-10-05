/**
 * Cloud model providers besides local Ollama. All of them but Claude speak the
 * OpenAI `/chat/completions` dialect with a Bearer key, so one adapter serves them
 * (Claude has its own: anthropic.ts, the native Messages API):
 *
 *   anthropic   Claude with an API key from console.anthropic.com (paid)
 *   xai         Grok from xAI (paid, key from console.x.ai; not the same as Groq)
 *   openrouter  free `:free` models (no card, free account key)
 *   groq        fast free tier
 *   gemini      Google AI Studio free tier (OpenAI-compatible endpoint)
 *   opencode    OpenCode Zen (free models need a key from opencode.ai/auth)
 *   nvidia      NVIDIA NIM (build.nvidia.com: free key, many open models)
 *   cohere      Cohere (free trial key; OpenAI-compatible endpoint)
 *   zai         Z.AI GLM (GLM-4.5-Flash and other free models)
 *   cloudflare  Cloudflare Workers AI (free daily allowance; the URL carries the account id)
 *   custom      any OpenAI-compatible server: LM Studio, llama.cpp, vLLM, …
 *
 * The agent loop speaks Ollama's NDJSON dialect, so this module is an
 * ADAPTER: it translates an Ollama-shaped chat payload into an OpenAI request
 * and turns the SSE answer back into Ollama-shaped NDJSON chunks. Nothing in
 * the loop (tool handling, fake-call parsing, truncation recovery) changes.
 *
 * A model belongs to its provider by id prefix: `openrouter/<model-id>`.
 */

import { live } from './appconfig';
import { CLI_MODELS, CLI_PREFIX, findClaude, isCliModel } from './claudecli';
import { findCodex, isCodexModel, usableCodexModels } from './codexcli';
import { anthropicChat, listAnthropicModels, mediaType, type AnthropicPayload } from './anthropic';

export interface ProviderDef {
  id: 'anthropic' | 'xai' | 'openrouter' | 'groq' | 'cerebras' | 'mistral' | 'gemini' | 'nvidia' | 'cohere' | 'zai' | 'cloudflare' | 'opencode' | 'custom';
  name: string;
  /** Model-id prefix, e.g. `openrouter/`. */
  prefix: string;
  defaultBase: string;
  /** Where the user gets a key. */
  signupUrl: string;
  keyRequired: boolean;
  /** The user supplies the base URL (custom). */
  needsBaseUrl: boolean;
}

export const PROVIDERS: ProviderDef[] = [
  { id: 'anthropic', name: 'Claude (Anthropic)', prefix: 'claude/', defaultBase: 'https://api.anthropic.com', signupUrl: 'https://console.anthropic.com/settings/keys', keyRequired: true, needsBaseUrl: false },
  { id: 'xai', name: 'Grok (xAI)', prefix: 'grok/', defaultBase: 'https://api.x.ai/v1', signupUrl: 'https://console.x.ai', keyRequired: true, needsBaseUrl: false },
  { id: 'openrouter', name: 'OpenRouter', prefix: 'openrouter/', defaultBase: 'https://openrouter.ai/api/v1', signupUrl: 'https://openrouter.ai/keys', keyRequired: true, needsBaseUrl: false },
  { id: 'groq', name: 'Groq', prefix: 'groq/', defaultBase: 'https://api.groq.com/openai/v1', signupUrl: 'https://console.groq.com/keys', keyRequired: true, needsBaseUrl: false },
  { id: 'cerebras', name: 'Cerebras', prefix: 'cerebras/', defaultBase: 'https://api.cerebras.ai/v1', signupUrl: 'https://cloud.cerebras.ai', keyRequired: true, needsBaseUrl: false },
  { id: 'mistral', name: 'Mistral', prefix: 'mistral/', defaultBase: 'https://api.mistral.ai/v1', signupUrl: 'https://console.mistral.ai/api-keys', keyRequired: true, needsBaseUrl: false },
  { id: 'gemini', name: 'Google Gemini', prefix: 'gemini/', defaultBase: 'https://generativelanguage.googleapis.com/v1beta/openai', signupUrl: 'https://aistudio.google.com/apikey', keyRequired: true, needsBaseUrl: false },
  { id: 'nvidia', name: 'NVIDIA NIM', prefix: 'nvidia/', defaultBase: 'https://integrate.api.nvidia.com/v1', signupUrl: 'https://build.nvidia.com/settings/api-keys', keyRequired: true, needsBaseUrl: false },
  { id: 'cohere', name: 'Cohere', prefix: 'cohere/', defaultBase: 'https://api.cohere.ai/compatibility/v1', signupUrl: 'https://dashboard.cohere.com/api-keys', keyRequired: true, needsBaseUrl: false },
  { id: 'zai', name: 'Z.AI (GLM)', prefix: 'zai/', defaultBase: 'https://api.z.ai/api/paas/v4', signupUrl: 'https://z.ai/manage-apikey/apikey-list', keyRequired: true, needsBaseUrl: false },
  // the account id is part of the URL: https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1
  { id: 'cloudflare', name: 'Cloudflare Workers AI', prefix: 'cloudflare/', defaultBase: '', signupUrl: 'https://dash.cloudflare.com/profile/api-tokens', keyRequired: true, needsBaseUrl: true },
  { id: 'opencode', name: 'OpenCode Zen', prefix: 'opencode/', defaultBase: 'https://opencode.ai/zen/v1', signupUrl: 'https://opencode.ai/auth', keyRequired: true, needsBaseUrl: false },
  { id: 'custom', name: 'OpenAI-compatible', prefix: 'custom/', defaultBase: '', signupUrl: '', keyRequired: false, needsBaseUrl: true },
];

/** Models documented as free on OpenCode Zen; the live list adds `*-free`. */
const OPENCODE_KNOWN_FREE = new Set(['big-pickle']);

let getSetting: (key: string) => string = () => '';
let legacyOpencodeKey: () => string = () => '';

/**
 * Wire the settings lookup (DB). `getOpencodeKey` is the pre-registry way to
 * provide the OpenCode key and still works.
 */
export function configureProviders(opts: { getSetting?: (key: string) => string; getOpencodeKey?: () => string }): void {
  if (opts.getSetting) getSetting = opts.getSetting;
  if (opts.getOpencodeKey) legacyOpencodeKey = opts.getOpencodeKey;
}

/**
 * Before the provider registry there was ONE key field ("OpenCode"), and users
 * pasted keys of other services into it (an OpenRouter key was seen in the wild).
 * Move it to the per-provider setting once, unless it duplicates another
 * provider's key — then it was never an OpenCode key and is dropped.
 */
export function migrateLegacyOpencodeKey(db: { getSetting(key: string): string; setSetting(key: string, value: string): void }): void {
  const legacy = db.getSetting('opencode_api_key');
  if (!legacy) return;
  const duplicatesOther = PROVIDERS.some((p) => p.id !== 'opencode' && db.getSetting(`provider.${p.id}.key`) === legacy);
  if (!duplicatesOther && !db.getSetting('provider.opencode.key')) db.setSetting('provider.opencode.key', legacy);
  db.setSetting('opencode_api_key', '');
}

export const providerById =(id: string): ProviderDef | undefined => PROVIDERS.find((p) => p.id === id);
export const providerForModel = (model: string): ProviderDef | undefined => PROVIDERS.find((p) => model.startsWith(p.prefix));
export const isCloudModel = (model: string): boolean => providerForModel(model) !== undefined;
export const isOpencodeModel = (model: string): boolean => model.startsWith('opencode/');

/** Setting keys (also used by the API layer). */
export const keySetting = (def: ProviderDef): string => `provider.${def.id}.key`;
export const urlSetting = (def: ProviderDef): string => `provider.${def.id}.url`;

export function apiKey(def: ProviderDef): string {
  const env = process.env[`${def.id.toUpperCase()}_API_KEY`];
  let key = env || getSetting(keySetting(def));
  // The pre-registry single OpenCode field is migrated at startup (index.ts) and cleared with the key;
  // reading it here would resurrect a key the user deleted.
  if (!key && def.id === 'opencode') key = legacyOpencodeKey();
  return (key || '').trim();
}

export function baseUrl(def: ProviderDef): string {
  const env = process.env[`${def.id.toUpperCase()}_BASE_URL`];
  const url = env || (def.needsBaseUrl ? getSetting(urlSetting(def)) : def.defaultBase);
  return (url || '').trim().replace(/\/+$/, '');
}

/** Ready to use: a key where one is required, a base URL where it is user-supplied. */
export function isConfigured(def: ProviderDef): boolean {
  if (def.needsBaseUrl && !baseUrl(def)) return false;
  return !def.keyRequired || apiKey(def) !== '';
}

export interface ProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  /** Last characters of the key, for display. */
  hint: string;
  from_env: boolean;
  signup_url: string;
  key_required: boolean;
  needs_base_url: boolean;
  base_url: string;
}

export function providerStatus(def: ProviderDef): ProviderStatus {
  const key = apiKey(def);
  return {
    id: def.id,
    name: def.name,
    configured: isConfigured(def),
    hint: key ? `…${key.slice(-4)}` : '',
    from_env: Boolean(process.env[`${def.id.toUpperCase()}_API_KEY`]),
    signup_url: def.signupUrl,
    key_required: def.keyRequired,
    needs_base_url: def.needsBaseUrl,
    base_url: def.needsBaseUrl ? baseUrl(def) : '',
  };
}

// ------------------------------------------------------------------ models --

interface RawModel {
  id?: string;
  pricing?: { prompt?: string | number; completion?: string | number };
  supported_parameters?: string[];
}

/** Chat models this provider offers to the current key (free ones where the provider has a paid tier). */
export async function listProviderModels(def: ProviderDef): Promise<string[]> {
  if (!isConfigured(def)) return [];
  const key = apiKey(def);
  if (def.id === 'anthropic') return (await listAnthropicModels(key, baseUrl(def))).map((m) => def.prefix + m.id);
  const res = await fetch(`${baseUrl(def)}/models`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`${def.name} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { data?: RawModel[] };
  const raw = data.data ?? [];

  let ids: string[];
  switch (def.id) {
    case 'openrouter':
      // free AND able to call tools — the agent is useless without them
      ids = raw
        .filter((m) => Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0)
        .filter((m) => (m.supported_parameters ?? []).includes('tools'))
        .map((m) => String(m.id ?? ''));
      break;
    case 'xai':
      ids = raw.map((m) => String(m.id ?? '')).filter((id) => /^grok/i.test(id) && !/image|imagine|embed|video/i.test(id));
      break;
    case 'groq':
      ids = raw.map((m) => String(m.id ?? '')).filter((id) => !/whisper|guard|tts|playai|orpheus|embed/i.test(id));
      break;
    case 'cerebras':
      ids = raw.map((m) => String(m.id ?? '')).filter((id) => !/embed|whisper/i.test(id));
      break;
    case 'mistral':
      ids = raw.map((m) => String(m.id ?? '')).filter((id) => /codestral|devstral|mistral|ministral|magistral/i.test(id) && !/embed|moderation|ocr|voxtral/i.test(id));
      break;
    case 'gemini':
      ids = raw.map((m) => String(m.id ?? '').replace(/^models\//, '')).filter((id) => /^(gemini|gemma)/i.test(id) && !/embed|tts|image|live/i.test(id));
      break;
    case 'opencode':
      ids = raw.map((m) => String(m.id ?? '')).filter((id) => OPENCODE_KNOWN_FREE.has(id) || /-free$/.test(id));
      break;
    default:
      ids = raw.map((m) => String(m.id ?? ''));
  }
  return ids.filter(Boolean).map((id) => def.prefix + id);
}

/** Models of every configured provider, plus per-provider errors (a failing one never hides the rest). */
export async function listAllCloudModels(): Promise<{ models: string[]; errors: Record<string, string> }> {
  const errors: Record<string, string> = {};
  const lists = await Promise.all(
    PROVIDERS.filter(isConfigured).map(async (def) => {
      try {
        return await listProviderModels(def);
      } catch (exc) {
        errors[def.id] = exc instanceof Error ? exc.message : String(exc);
        return [] as string[];
      }
    }),
  );
  // opt-in: Claude through the user's own Claude Code CLI login (see claudecli.ts)
  // exact versions the account knows (from the Claude API list, when a key is set) join the built-in ones
  const apiClaude = lists.flat().filter((m) => m.startsWith('claude/')).map((m) => CLI_PREFIX + m.slice('claude/'.length));
  const cli = live<boolean>('claude.cli') === true && findClaude() ? [...new Set([...CLI_MODELS, ...apiClaude])] : [];
  // opt-in: Codex through the user's own ChatGPT login (see codexcli.ts)
  const codex = live<boolean>('codex.cli') === true && findCodex() ? await usableCodexModels().catch(() => [] as string[]) : [];
  return { models: [...lists.flat(), ...cli, ...codex], errors };
}

/**
 * Another cloud model to continue with when `current` failed: same provider
 * first, then the others; models in `failed` are skipped. Null when none.
 */
export async function pickFallbackModel(current: string, failed: Set<string>, otherProvider = false): Promise<string | null> {
  // fetched fresh: it only runs after a failure, and keys/lists may have changed
  const models = (await listAllCloudModels()).models;
  const own = providerForModel(current);
  // never fall back onto the subscription CLI on its own: it is the user's personal plan
  const candidates = models.filter((m) => m !== current && !failed.has(m) && !isCliModel(m) && !isCodexModel(m));
  // a request limit is per account/provider: another model of the same provider would hit it too
  if (otherProvider) return candidates.find((m) => providerForModel(m) !== own) ?? candidates[0] ?? null;
  return candidates.find((m) => providerForModel(m) === own) ?? candidates[0] ?? null;
}

function formatWait(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} ч ${rest} мин` : `${h} ч`;
}

/**
 * Human text for an HTTP 429 from a provider. `detail` is the response body
 * plus the trailer added by providerChat (`[retry-after=SECONDS;reset=EPOCH]`).
 */
export function describeRateLimit(detail: string, now = Date.now()): string {
  const m = /\[retry-after=(\d*);reset=(\d*)\]/.exec(detail);
  const retry = m?.[1] ? Number(m[1]) : 0;
  let resetAt = m?.[2] ? Number(m[2]) : 0;
  if (resetAt && resetAt < 1e12) resetAt *= 1000; // seconds → milliseconds
  const wait = retry > 0 ? retry * 1000 : resetAt > now ? resetAt - now : 0;
  const daily = /per-day|per day|daily/i.test(detail);
  const head = daily ? 'дневной лимит бесплатных запросов исчерпан' : 'превышен лимит запросов бесплатного тарифа';
  const when = wait > 0
    ? `сброс примерно через ${formatWait(wait)}`
    : daily ? 'сброс в 00:00 UTC' : 'подождите минуту';
  return `${head} — ${when}. Можно выбрать другую модель или локальную.`;
}

/** What the provider tells us about the current key's limits (only OpenRouter exposes this). */
export interface ProviderLimits {
  supported: boolean;
  /** Free-model requests per minute (documented, same for every account). */
  perMinute?: number;
  /** Free-model requests today (UTC day). */
  daily?: { used: number; limit: number; remaining: number };
  /** true = never topped up: the low daily cap applies. */
  freeTier?: boolean;
  error?: string;
}

/**
 * Limits of the saved key. OpenRouter: `GET /key` reports the free-model daily
 * counter and whether the account ever bought credits (that decides 50 vs 1000
 * requests per day). Others publish limits only in their consoles.
 */
export async function providerLimits(def: ProviderDef): Promise<ProviderLimits> {
  if (def.id !== 'openrouter') return { supported: false };
  const key = apiKey(def);
  if (!key) return { supported: true, error: 'API key is not set' };
  try {
    const res = await fetch(`${baseUrl(def)}/key`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { supported: true, error: `${def.name} ${res.status}` };
    const data = ((await res.json()) as { data?: Record<string, unknown> }).data ?? {};
    const daily = data.free_model_daily_requests as { used?: number; limit?: number; remaining?: number } | undefined;
    return {
      supported: true,
      perMinute: 20,
      freeTier: typeof data.is_free_tier === 'boolean' ? data.is_free_tier : undefined,
      daily: daily && typeof daily.limit === 'number'
        ? { used: Number(daily.used ?? 0), limit: daily.limit, remaining: Number(daily.remaining ?? Math.max(0, daily.limit - Number(daily.used ?? 0))) }
        : undefined,
    };
  } catch (exc) {
    return { supported: true, error: exc instanceof Error ? exc.message : String(exc) };
  }
}

/**
 * Real key check: model lists are often public, so they prove nothing. Ask a
 * model for a single token — a bad key fails with 401/403.
 */
export async function testProvider(def: ProviderDef): Promise<{ ok: boolean; models: number; error?: string }> {
  if (!isConfigured(def)) return { ok: false, models: 0, error: def.needsBaseUrl && !baseUrl(def) ? 'Base URL is not set' : 'API key is not set' };
  let models: string[];
  try {
    models = await listProviderModels(def);
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    return { ok: false, models: 0, error: /\b40[13]\b/.test(msg) ? 'Invalid API key' : msg };
  }
  if (models.length === 0) return { ok: false, models: 0, error: 'No suitable models are available' };
  let res: Response;
  try {
    res = await providerChat({
      model: models[0],
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
      options: { num_predict: 1 },
    });
  } catch (exc) {
    return { ok: false, models: models.length, error: exc instanceof Error ? exc.message : String(exc) };
  }
  if (res.status === 200) return { ok: true, models: models.length };
  const detail = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
  return { ok: false, models: models.length, error: res.status === 401 || res.status === 403 ? 'Invalid API key' : `${def.name} ${res.status}: ${detail}` };
}

// ----- back-compat wrappers (OpenCode) --------------------------------------

export interface CloudModel {
  id: string;
  free: boolean;
}

const OPENCODE = PROVIDERS.find((p) => p.id === 'opencode') as ProviderDef;
export const opencodeConfigured = (): boolean => isConfigured(OPENCODE);
export async function listOpencodeModels(): Promise<CloudModel[]> {
  return (await listProviderModels(OPENCODE)).map((id) => ({ id, free: true }));
}
export const testOpencodeKey = (): ReturnType<typeof testProvider> => testProvider(OPENCODE);

// -------------------------------------------------------------------- chat --

interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  tool_name?: string;
}

interface OllamaPayload {
  model: string;
  /** Reasoning effort: off | low | medium | high | max (absent = the model decides). */
  effort?: string;
  messages: OllamaMessage[];
  stream?: boolean;
  tools?: unknown[];
  options?: Record<string, unknown>;
}

/** Ollama messages → OpenAI messages (tool-call ids paired in order). */
function toOpenAiMessages(messages: OllamaMessage[]): unknown[] {
  const out: unknown[] = [];
  let pending: string[] = [];
  let n = 0;
  messages.forEach((m, index) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const calls = m.tool_calls.map((c) => {
        const id = `call_${++n}`;
        const args = c.function?.arguments;
        return {
          id,
          type: 'function',
          function: {
            name: c.function?.name ?? '',
            arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
          },
        };
      });
      pending = calls.map((c) => c.id);
      out.push({ role: 'assistant', content: m.content || null, tool_calls: calls });
    } else if (m.role === 'tool') {
      // Cohere & co. reject empty messages ("must have non-empty content or tool calls")
      out.push({ role: 'tool', tool_call_id: pending.shift() ?? `call_${++n}`, content: m.content?.trim() ? m.content : '(пусто)' });
    } else if (m.role === 'system' && index > 0) {
      // system turns in the middle of a tool exchange are rejected by many
      // OpenAI-compatible backends — send them as user reminders instead
      out.push({ role: 'user', content: m.content?.trim() ? m.content : '(продолжай)' });
    } else if (!m.content?.trim()) {
      // an empty assistant turn carries nothing (and is invalid for strict backends)
      if (m.role !== 'assistant') out.push({ role: m.role, content: '(пусто)' });
    } else if (m.role === 'user' && m.images?.length) {
      // pictures go as image_url parts (OpenAI vision format: OpenRouter, Gemini, Grok, GPT-4o…)
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: m.content },
          ...m.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${mediaType(img)};base64,${img}` } })),
        ],
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  });
  return out;
}

const ndjson = (obj: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(obj) + '\n');

/**
 * POST an Ollama-shaped chat payload to the model's provider. Returns a
 * Response whose body is Ollama NDJSON (or, for `stream:false`, one Ollama JSON
 * object), and whose status/body mirror upstream errors so the caller's error
 * handling works.
 */
export async function providerChat(payload: OllamaPayload): Promise<Response> {
  const def = providerForModel(payload.model);
  if (!def) return new Response(JSON.stringify({ error: `Unknown provider for model ${payload.model}` }), { status: 400 });
  const key = apiKey(def);
  if (def.keyRequired && !key) {
    return new Response(JSON.stringify({ error: `${def.name} API key is not set` }), { status: 401 });
  }
  if (!baseUrl(def)) {
    return new Response(JSON.stringify({ error: `${def.name} base URL is not set` }), { status: 400 });
  }
  const model = payload.model.slice(def.prefix.length);
  if (def.id === 'anthropic') {
    return anthropicChat({ ...payload, model } as AnthropicPayload, key, baseUrl(def), Number(process.env.OTTO_CLOUD_IDLE_MS) || 120_000);
  }
  const stream = payload.stream !== false;
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAiMessages(payload.messages),
    stream,
  };
  const opts = payload.options ?? {};
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  if (payload.effort && payload.effort !== 'off') {
    const level = payload.effort === 'max' ? 'high' : payload.effort;
    if (def.id === 'openrouter') body.reasoning = { effort: level };
    else body.reasoning_effort = level;
  }
  if (typeof opts.num_predict === 'number') body.max_tokens = opts.num_predict;
  if (payload.tools?.length) body.tools = payload.tools;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  if (def.id === 'openrouter') {
    headers['HTTP-Referer'] = 'https://zeithub.team';
    headers['X-Title'] = 'zeithub.otto';
  }
  // Free cloud models queue requests: the server may hold the connection open
  // (even sending keep-alive comments) and never produce a token. Abort when
  // no real data arrives for IDLE_MS so the chat shows an error, not an
  // endless "thinking".
  const idleMs = Number(process.env.OTTO_CLOUD_IDLE_MS) || 120_000;
  const abort = new AbortController();
  let timedOut = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelBody: () => void = () => undefined;
  const bump = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      abort.abort();
      cancelBody(); // aborting the signal alone does not always wake a pending read()
    }, idleMs);
  };
  const stopTimer = (): void => clearTimeout(idleTimer);
  const idleError = `${def.name}: модель не ответила за ${Math.round(idleMs / 1000)} с (бесплатные модели часто стоят в очереди). Повторите или выберите другую модель.`;
  bump();
  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl(def)}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch (exc) {
    stopTimer();
    if (timedOut) return new Response(idleError, { status: 504 });
    throw exc;
  }
  if (!upstream.ok || !upstream.body) {
    stopTimer();
    let text = await upstream.text();
    if (upstream.status === 429) {
      // callers only see status + body, so the reset hints travel in a trailer
      const retry = upstream.headers.get('retry-after') ?? '';
      const reset = upstream.headers.get('x-ratelimit-reset') ?? '';
      text += `\n[retry-after=${retry};reset=${reset}]`;
    }
    return new Response(text, { status: upstream.status || 502 });
  }

  const parseArgs = (raw: string): unknown => {
    try {
      return JSON.parse(raw || '{}');
    } catch {
      return raw; // keep the string: normalizeToolCall() gets a second chance
    }
  };
  const finish = (
    calls: Map<number, { name: string; args: string }>,
    reason: string | null,
    content = '',
  ) => ({
    message: {
      role: 'assistant',
      content,
      tool_calls: calls.size
        ? [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({
            function: { name: c.name, arguments: parseArgs(c.args) },
          }))
        : undefined,
    },
    done: true,
    done_reason: reason === 'length' ? 'length' : 'stop',
  });

  if (!stream) {
    stopTimer();
    const data = (await upstream.json()) as {
      choices?: Array<{
        message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
        finish_reason?: string;
      }>;
    };
    const choice = data.choices?.[0];
    const calls = new Map<number, { name: string; args: string }>();
    (choice?.message?.tool_calls ?? []).forEach((c, i) =>
      calls.set(i, { name: c.function?.name ?? '', args: c.function?.arguments ?? '' }),
    );
    return new Response(JSON.stringify(finish(calls, choice?.finish_reason ?? null, choice?.message?.content ?? '')), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  const reader = upstream.body.getReader();
  cancelBody = () => void reader.cancel().catch(() => undefined);
  const decoder = new TextDecoder();
  const calls = new Map<number, { name: string; args: string }>();
  let reason: string | null = null;
  let buffer = '';

  const out = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // A pull() that enqueues nothing is NOT called again by the stream, so
      // keep reading (SSE comments such as ": PROCESSING" carry no data) until
      // something is enqueued or the upstream ends.
      for (;;) {
        if (await readOnce(controller)) return;
      }
    },
    cancel() {
      stopTimer();
      void reader.cancel();
    },
  });

  /** One upstream read; true when the controller received data or was closed. */
  async function readOnce(controller: ReadableStreamDefaultController<Uint8Array>): Promise<boolean> {
    {
      let queued = false;
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch (exc) {
        stopTimer();
        controller.enqueue(ndjson({ error: timedOut ? idleError : String(exc) }));
        controller.close();
        return true;
      }
      const { done, value } = read;
      if (done && timedOut) {
        controller.enqueue(ndjson({ error: idleError }));
        controller.close();
        return true;
      }
      if (done) {
        stopTimer();
        controller.enqueue(ndjson(finish(calls, reason)));
        controller.close();
        return true;
      }
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string | null;
              reasoning?: string | null;
              reasoning_content?: string | null;
              tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }>;
            };
            finish_reason?: string | null;
          }>;
          error?: unknown;
        };
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) {
          controller.enqueue(ndjson({ error: typeof chunk.error === 'string' ? chunk.error : JSON.stringify(chunk.error) }));
          queued = true;
          continue;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        bump(); // real data (text, reasoning, tool call, finish) — not a keep-alive comment
        if (choice.finish_reason) reason = choice.finish_reason;
        const reasoning = choice.delta?.reasoning ?? choice.delta?.reasoning_content;
        if (reasoning) {
          controller.enqueue(ndjson({ message: { role: 'assistant', content: '', thinking: reasoning }, done: false }));
          queued = true;
        }
        const text = choice.delta?.content;
        if (text) {
          controller.enqueue(ndjson({ message: { role: 'assistant', content: text }, done: false }));
          queued = true;
        }
        for (const tc of choice.delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const cur = calls.get(idx) ?? { name: '', args: '' };
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(idx, cur);
        }
      }
      return queued;
    }
  }
  return new Response(out, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

/** Pre-registry name kept for callers/tests. */
export const opencodeChat = providerChat;
