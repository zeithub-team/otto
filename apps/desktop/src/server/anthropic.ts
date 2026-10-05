/**
 * Claude via the native Anthropic Messages API.
 *
 * The agent loop speaks Ollama's NDJSON dialect. This adapter turns an
 * Ollama-shaped chat payload into a `/v1/messages` request (system prompt,
 * tool_use/tool_result pairing, images, extended thinking for "effort") and the
 * server-sent events back into Ollama-shaped chunks — text, `thinking` and
 * tool calls — with real token counts in the final chunk.
 */

export const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicPayload {
  model: string;
  messages: Array<{
    role: string;
    content: string;
    images?: string[];
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
    tool_name?: string;
    /** Reasoning blocks of an earlier turn (must be sent back with tool_use while thinking is on). */
    thinking_blocks?: Array<{ thinking: string; signature: string }>;
  }>;
  stream?: boolean;
  tools?: unknown[];
  effort?: string;
  options?: Record<string, unknown>;
}

/** Extended-thinking token budget per effort level (0 = thinking off). */
export const EFFORT_BUDGET: Record<string, number> = { off: 0, low: 2048, medium: 8192, high: 16384, max: 32768 };

const ndjson = (obj: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(obj) + '\n');

type Block = Record<string, unknown>;
type Turn = { role: 'user' | 'assistant'; content: Block[] };

/** MIME type of a base64 picture, from its first bytes. */
export const mediaType = (b64: string): string =>
  b64.startsWith('/9j/') ? 'image/jpeg' : b64.startsWith('UklGR') ? 'image/webp' : b64.startsWith('R0lGOD') ? 'image/gif' : 'image/png';

/** Ollama messages → Anthropic `system` + alternating user/assistant turns. */
export function toAnthropicMessages(messages: AnthropicPayload['messages']): { system: string; turns: Turn[]; hasToolUseWithoutThinking: boolean } {
  const systemParts: string[] = [];
  const turns: Turn[] = [];
  let pending: string[] = [];
  let n = 0;
  let hasToolUseWithoutThinking = false;
  const push = (role: 'user' | 'assistant', blocks: Block[]): void => {
    if (!blocks.length) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...blocks); // the API wants strict alternation
    else turns.push({ role, content: [...blocks] });
  };
  messages.forEach((m, index) => {
    if (m.role === 'system' && index === 0) {
      systemParts.push(m.content);
    } else if (m.role === 'system') {
      if (m.content.trim()) push('user', [{ type: 'text', text: m.content }]);
    } else if (m.role === 'assistant') {
      const blocks: Block[] = [];
      for (const t of m.thinking_blocks ?? []) blocks.push({ type: 'thinking', thinking: t.thinking, signature: t.signature });
      if (m.content.trim()) blocks.push({ type: 'text', text: m.content });
      pending = [];
      for (const call of m.tool_calls ?? []) {
        const id = `toolu_${++n}`;
        pending.push(id);
        const raw = call.function?.arguments;
        let input: unknown = raw;
        if (typeof raw === 'string') {
          try {
            input = JSON.parse(raw || '{}');
          } catch {
            input = {};
          }
        }
        blocks.push({ type: 'tool_use', id, name: call.function?.name ?? '', input: input && typeof input === 'object' ? input : {} });
      }
      if (m.tool_calls?.length && !(m.thinking_blocks?.length)) hasToolUseWithoutThinking = true;
      push('assistant', blocks);
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: pending.shift() ?? `toolu_${++n}`, content: m.content.trim() ? m.content : '(пусто)' }]);
    } else {
      const blocks: Block[] = [];
      for (const img of m.images ?? []) blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType(img), data: img } });
      blocks.push({ type: 'text', text: m.content.trim() ? m.content : '(пусто)' });
      push('user', blocks);
    }
  });
  // tool_result blocks must come before any text in the same user turn
  for (const turn of turns) {
    if (turn.role === 'user') turn.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'));
  }
  if (turns.length && turns[0].role === 'assistant') turns.unshift({ role: 'user', content: [{ type: 'text', text: '(продолжай)' }] });
  return { system: systemParts.join('\n\n'), turns, hasToolUseWithoutThinking };
}

/** Request body for `/v1/messages`. */
export function buildAnthropicBody(payload: AnthropicPayload): Record<string, unknown> {
  const { system, turns, hasToolUseWithoutThinking } = toAnthropicMessages(payload.messages);
  const opts = payload.options ?? {};
  let maxTokens = typeof opts.num_predict === 'number' && opts.num_predict > 0 ? Math.floor(opts.num_predict) : 8192;
  const budget = EFFORT_BUDGET[payload.effort ?? ''] ?? 0;
  const body: Record<string, unknown> = { model: payload.model, messages: turns, stream: payload.stream !== false };
  if (system) body.system = system;
  if (payload.tools?.length) {
    body.tools = (payload.tools as Array<{ function?: { name?: string; description?: string; parameters?: unknown } }>).map((t) => ({
      name: t.function?.name ?? '',
      description: t.function?.description ?? '',
      input_schema: t.function?.parameters ?? { type: 'object', properties: {} },
    }));
  }
  // Thinking needs the earlier reasoning blocks whenever tools were already used: without them the API refuses.
  const thinkingOn = budget > 0 && !hasToolUseWithoutThinking;
  if (thinkingOn) {
    maxTokens = Math.max(maxTokens, budget + 4096);
    body.thinking = { type: 'enabled', budget_tokens: budget };
  } else if (typeof opts.temperature === 'number') {
    body.temperature = Math.min(1, Math.max(0, opts.temperature));
  }
  body.max_tokens = maxTokens;
  return body;
}

/** GET /v1/models → ids (newest first, as the API returns them). */
export async function listAnthropicModels(key: string, base: string): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch(`${base}/v1/models?limit=100`, {
    headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { data?: Array<{ id?: string; display_name?: string }> };
  return (data.data ?? []).filter((m) => m.id).map((m) => ({ id: String(m.id), name: String(m.display_name ?? m.id) }));
}

interface Usage {
  input: number;
  output: number;
}

const finalChunk = (calls: Array<{ name: string; args: string }>, stop: string | null, usage: Usage, thinkingBlocks: Array<{ thinking: string; signature: string }>) => ({
  message: {
    role: 'assistant',
    content: '',
    tool_calls: calls.length
      ? calls.map((c) => {
          let args: unknown = {};
          try {
            args = JSON.parse(c.args || '{}');
          } catch {
            args = c.args;
          }
          return { function: { name: c.name, arguments: args } };
        })
      : undefined,
    thinking_blocks: thinkingBlocks.length ? thinkingBlocks : undefined,
  },
  done: true,
  done_reason: stop === 'max_tokens' ? 'length' : 'stop',
  prompt_eval_count: usage.input,
  eval_count: usage.output,
});

/**
 * POST the request and return an Ollama-shaped Response. Errors keep their HTTP
 * status and body so the caller's error handling (and cloud fallback) works.
 * `idleMs` aborts a stream that goes silent.
 */
export async function anthropicChat(payload: AnthropicPayload, key: string, base: string, idleMs = 120_000): Promise<Response> {
  const body = buildAnthropicBody(payload);
  const stream = body.stream === true;
  const abort = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bump = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, idleMs);
  };
  bump();
  const idleError = `Claude: модель не ответила за ${Math.round(idleMs / 1000)} с. Повторите или выберите другую модель.`;
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch (exc) {
    clearTimeout(timer);
    if (timedOut) return new Response(idleError, { status: 504 });
    throw exc;
  }
  if (!upstream.ok || !upstream.body) {
    clearTimeout(timer);
    let text = await upstream.text();
    if (upstream.status === 429 || upstream.status === 529) {
      const retry = upstream.headers.get('retry-after') ?? '';
      const reset = upstream.headers.get('anthropic-ratelimit-requests-reset') ?? upstream.headers.get('anthropic-ratelimit-tokens-reset') ?? '';
      text += `\n[retry-after=${retry};reset=${reset ? Math.floor(Date.parse(reset) / 1000) || '' : ''}]`;
    }
    return new Response(text, { status: upstream.status || 502 });
  }

  if (!stream) {
    clearTimeout(timer);
    const data = (await upstream.json()) as { content?: Block[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    let text = '';
    let thinking = '';
    const calls: Array<{ name: string; args: string }> = [];
    const blocks: Array<{ thinking: string; signature: string }> = [];
    for (const b of data.content ?? []) {
      if (b.type === 'text') text += String(b.text ?? '');
      else if (b.type === 'thinking') {
        thinking += String(b.thinking ?? '');
        blocks.push({ thinking: String(b.thinking ?? ''), signature: String(b.signature ?? '') });
      } else if (b.type === 'tool_use') calls.push({ name: String(b.name ?? ''), args: JSON.stringify(b.input ?? {}) });
    }
    const chunk = finalChunk(calls, data.stop_reason ?? null, { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 }, blocks);
    chunk.message.content = text;
    if (thinking) (chunk.message as Record<string, unknown>).thinking = thinking;
    return new Response(JSON.stringify(chunk), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const kinds = new Map<number, { type: string; name: string; args: string; thinking: string; signature: string }>();
  const calls: Array<{ name: string; args: string }> = [];
  const thinkingBlocks: Array<{ thinking: string; signature: string }> = [];
  let stop: string | null = null;
  const usage: Usage = { input: 0, output: 0 };

  const out = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          read = await reader.read();
        } catch (exc) {
          clearTimeout(timer);
          controller.enqueue(ndjson({ error: timedOut ? idleError : String(exc) }));
          controller.close();
          return;
        }
        if (read.done) {
          clearTimeout(timer);
          if (timedOut) controller.enqueue(ndjson({ error: idleError }));
          else controller.enqueue(ndjson(finalChunk(calls, stop, usage, thinkingBlocks)));
          controller.close();
          return;
        }
        buffer += decoder.decode(read.value, { stream: true });
        let queued = false;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          let event: Record<string, any>;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          switch (event.type) {
            case 'message_start':
              usage.input = Number(event.message?.usage?.input_tokens ?? 0);
              usage.output = Number(event.message?.usage?.output_tokens ?? 0);
              break;
            case 'content_block_start': {
              const b = event.content_block ?? {};
              kinds.set(event.index, { type: String(b.type), name: String(b.name ?? ''), args: '', thinking: '', signature: '' });
              break;
            }
            case 'content_block_delta': {
              const d = event.delta ?? {};
              const kind = kinds.get(event.index);
              bump(); // real data, not a ping
              if (d.type === 'text_delta' && d.text) {
                controller.enqueue(ndjson({ message: { role: 'assistant', content: String(d.text) }, done: false }));
                queued = true;
              } else if (d.type === 'thinking_delta' && d.thinking) {
                if (kind) kind.thinking += String(d.thinking);
                controller.enqueue(ndjson({ message: { role: 'assistant', content: '', thinking: String(d.thinking) }, done: false }));
                queued = true;
              } else if (d.type === 'signature_delta' && kind) {
                kind.signature += String(d.signature ?? '');
              } else if (d.type === 'input_json_delta' && kind) {
                kind.args += String(d.partial_json ?? '');
              }
              break;
            }
            case 'content_block_stop': {
              const kind = kinds.get(event.index);
              if (kind?.type === 'tool_use') calls.push({ name: kind.name, args: kind.args });
              else if (kind?.type === 'thinking' && kind.thinking) thinkingBlocks.push({ thinking: kind.thinking, signature: kind.signature });
              break;
            }
            case 'message_delta':
              if (event.delta?.stop_reason) stop = String(event.delta.stop_reason);
              if (event.usage?.output_tokens != null) usage.output = Number(event.usage.output_tokens);
              break;
            case 'error':
              controller.enqueue(ndjson({ error: JSON.stringify(event.error ?? event) }));
              queued = true;
              break;
            default:
              break; // ping, message_stop
          }
        }
        if (queued) return;
      }
    },
    cancel() {
      clearTimeout(timer);
      void reader.cancel();
    },
  });
  return new Response(out, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}
