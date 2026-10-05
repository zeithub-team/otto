import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { generateResponse } from '../ollama';
import { configureProviders, listOpencodeModels, describeRateLimit, migrateLegacyOpencodeKey, providerById, providerLimits, testOpencodeKey } from '../providers';
// the fallback chain ends with a local model: point Ollama at a closed port so no real model is used
process.env.OLLAMA_URL ??= 'http://127.0.0.1:9';

interface Seen {
  url: string;
  auth: string | undefined;
  body: any;
}

/** Fake OpenCode Zen: /models and /chat/completions (SSE), scripted turns. */
async function fakeZen(turns: string[][]) {
  const seen: Seen[] = [];
  let turn = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      if (req.headers.authorization !== 'Bearer sk-test') {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"invalid api key"}');
        return;
      }
      if (req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'big-pickle' }, { id: 'mimo-v2.5-free' }, { id: 'gpt-5.5' }, { id: 'claude-sonnet' }] }));
        return;
      }
      if (seenBody(raw)?.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const line of turns[Math.min(turn++, turns.length - 1)]) res.write(`data: ${line}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.OPENCODE_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const seenBody = (raw: string): { stream?: boolean } | null => {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const delta = (d: unknown, finish: string | null = null) =>
  JSON.stringify({ choices: [{ delta: d, finish_reason: finish }] });

async function run(model: string, projectPath: string) {
  const chunks: Array<Record<string, any>> = [];
  for await (const raw of generateResponse({ prompt: 'создай a.txt', messageId: 'm', projectId: 1, projectPath, model, useTools: true })) {
    chunks.push(JSON.parse(raw));
  }
  return chunks;
}

test('opencode: streamed tool call is assembled from SSE pieces and executed', async () => {
  configureProviders({ getOpencodeKey: () => 'sk-test' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-oc-'));
  const zen = await fakeZen([
    [
      delta({ content: 'Создаю файл. ' }),
      // name and arguments arrive split across chunks, like real streams
      delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_', arguments: '' } }] }),
      delta({ tool_calls: [{ index: 0, function: { name: 'file', arguments: '{"path":"a.txt",' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '"content":"привет"}' } }] }, 'tool_calls'),
    ],
    [delta({ content: 'ИТОГ: создан a.txt' }, 'stop')],
  ]);
  try {
    const chunks = await run('opencode/big-pickle', root);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'привет');
    assert.match(String(chunks[chunks.length - 1].content), /a\.txt/);

    const [first, second] = zen.seen;
    assert.equal(first.url, '/chat/completions');
    assert.equal(first.auth, 'Bearer sk-test');
    assert.equal(first.body.model, 'big-pickle'); // prefix stripped
    assert.ok(first.body.tools.length > 0);

    // second request: assistant tool_call and the tool result are paired by id
    const msgs = second.body.messages as any[];
    const asst = msgs.find((m) => m.role === 'assistant' && m.tool_calls);
    const tool = msgs.find((m) => m.role === 'tool');
    assert.equal(asst.tool_calls[0].function.name, 'write_file');
    assert.equal(tool.tool_call_id, asst.tool_calls[0].id);
    // mid-conversation system reminders are demoted to user turns
    assert.ok(!msgs.slice(1).some((m) => m.role === 'system'));
  } finally {
    await zen.close();
  }
});

test('opencode: length cut-off is recognised so the loop can recover', async () => {
  configureProviders({ getOpencodeKey: () => 'sk-test' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-oc-'));
  const zen = await fakeZen([
    [delta({ content: '<function=write_file><parameter=path>b.txt</parameter><parameter=content>half' }, 'length')],
    [delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'write_file', arguments: '{"path":"b.txt","content":"ok"}' } }] }, 'tool_calls')],
    [delta({ content: 'готово' }, 'stop')],
  ]);
  try {
    await run('opencode/big-pickle', root);
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'ok');
    const retry = (zen.seen[1].body.messages as any[]).filter((m) => m.role === 'user').pop();
    assert.match(retry.content, /оборвался/);
  } finally {
    await zen.close();
  }
});

test('opencode: a wrong key gives an actionable message', async () => {
  configureProviders({ getOpencodeKey: () => 'wrong' });
  const zen = await fakeZen([[delta({ content: 'x' })]]);
  try {
    const chunks = await run('opencode/big-pickle', fs.mkdtempSync(path.join(os.tmpdir(), 'otto-oc-')));
    assert.match(String(chunks[0].content), /API-ключ/);
  } finally {
    await zen.close();
  }
});

test('opencode: missing key is reported before any request', async () => {
  configureProviders({ getOpencodeKey: () => '' });
  delete process.env.OPENCODE_API_KEY;
  const zen = await fakeZen([[delta({ content: 'x' })]]);
  try {
    const chunks = await run('opencode/big-pickle', fs.mkdtempSync(path.join(os.tmpdir(), 'otto-oc-')));
    assert.match(String(chunks[0].content), /API-ключ/);
    assert.equal(zen.seen.length, 0);
  } finally {
    await zen.close();
  }
});

test('opencode: only free models are listed, prefixed for the picker', async () => {
  configureProviders({ getOpencodeKey: () => 'sk-test' });
  const zen = await fakeZen([[]]);
  try {
    const models = await listOpencodeModels();
    assert.deepEqual(models.map((m) => m.id).sort(), ['opencode/big-pickle', 'opencode/mimo-v2.5-free']);
  } finally {
    await zen.close();
  }
});

test('opencode: key check uses a real request (the /models list is public)', async () => {
  const zen = await fakeZen([[delta({ content: 'pong' }, 'stop')]]);
  try {
    configureProviders({ getOpencodeKey: () => 'sk-test' });
    const good = await testOpencodeKey();
    assert.equal(good.ok, true);
    configureProviders({ getOpencodeKey: () => 'nope' });
    const bad = await testOpencodeKey();
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /Invalid API key/);
  } finally {
    await zen.close();
  }
});

// ---------------------------------------------------------------- registry --

interface Hit { url: string; headers: http.IncomingHttpHeaders; body: any }

/** Generic OpenAI-compatible fake: /models list + SSE chat answering "ok". */
async function fakeOpenAi(models: unknown[]) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits.push({ url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null });
      if (req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: models }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { hits, url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const settings = (values: Record<string, string>) => (key: string): string => values[key] ?? '';

test('openrouter: only free models that can call tools are listed, with the provider prefix', async () => {
  const fake = await fakeOpenAi([
    { id: 'nvidia/nemotron-3.5-lightning:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'temperature'] },
    { id: 'meta/free-but-no-tools:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['temperature'] },
    { id: 'openai/paid', pricing: { prompt: '0.001', completion: '0.002' }, supported_parameters: ['tools'] },
  ]);
  process.env.OPENROUTER_BASE_URL = fake.url;
  configureProviders({ getSetting: settings({ 'provider.openrouter.key': 'or-key' }), getOpencodeKey: () => "" });
  try {
    const res = (await import('../providers')).listAllCloudModels;
    const { models, errors } = await res();
    assert.deepEqual(models.filter((m) => m.startsWith('openrouter/')), ['openrouter/nvidia/nemotron-3.5-lightning:free']);
    assert.deepEqual(errors, {});
    assert.equal(fake.hits[0].headers.authorization, 'Bearer or-key');
  } finally {
    delete process.env.OPENROUTER_BASE_URL;
    await fake.close();
  }
});

test('openrouter: chat is routed by prefix, the prefix is stripped and attribution headers are sent', async () => {
  const fake = await fakeOpenAi([]);
  process.env.OPENROUTER_BASE_URL = fake.url;
  configureProviders({ getSetting: settings({ 'provider.openrouter.key': 'or-key' }), getOpencodeKey: () => "" });
  try {
    const chunks = await run('openrouter/nvidia/nemotron-3.5-lightning:free', fs.mkdtempSync(path.join(os.tmpdir(), 'otto-or-')));
    assert.match(String(chunks[chunks.length - 1].content), /ok/);
    const chat = fake.hits.find((h) => h.url === '/chat/completions')!;
    assert.equal(chat.body.model, 'nvidia/nemotron-3.5-lightning:free');
    assert.equal(chat.headers.authorization, 'Bearer or-key');
    assert.equal(chat.headers['x-title'], 'zeithub.otto');
  } finally {
    delete process.env.OPENROUTER_BASE_URL;
    await fake.close();
  }
});

test('custom OpenAI-compatible server works without a key and without an Authorization header', async () => {
  const fake = await fakeOpenAi([{ id: 'qwen3-coder' }]);
  configureProviders({ getSetting: settings({ 'provider.custom.url': fake.url + '/' }), getOpencodeKey: () => "" });
  try {
    const { models } = await (await import('../providers')).listAllCloudModels();
    assert.ok(models.includes('custom/qwen3-coder'));
    await run('custom/qwen3-coder', fs.mkdtempSync(path.join(os.tmpdir(), 'otto-cu-')));
    const chat = fake.hits.find((h) => h.url === '/chat/completions')!;
    assert.equal(chat.body.model, 'qwen3-coder');
    assert.equal(chat.headers.authorization, undefined);
  } finally {
    await fake.close();
  }
});

test('a cloud model without a key names the provider and points to Settings', async () => {
  configureProviders({ getSetting: settings({}), getOpencodeKey: () => "" });
  delete process.env.GROQ_API_KEY;
  const chunks = await run('groq/llama-3.3-70b', fs.mkdtempSync(path.join(os.tmpdir(), 'otto-nk-')));
  assert.match(String(chunks[0].content), /Groq.*API-ключ.*Облачные модели/);
});

// -------------------------------------------------------------- migration --

function memSettings(initial: Record<string, string>) {
  const data = { ...initial };
  return {
    data,
    getSetting: (k: string) => data[k] ?? '',
    setSetting: (k: string, v: string) => {
      if (v) data[k] = v;
      else delete data[k];
    },
  };
}

test('legacy OpenCode key is moved to the provider setting once', () => {
  const db = memSettings({ opencode_api_key: 'oc-real' });
  migrateLegacyOpencodeKey(db);
  assert.equal(db.data['provider.opencode.key'], 'oc-real');
  assert.equal(db.data['opencode_api_key'], undefined);
});

test('a legacy key that duplicates another provider (OpenRouter key pasted into the old field) is dropped', () => {
  const db = memSettings({ opencode_api_key: 'sk-or-1234', 'provider.openrouter.key': 'sk-or-1234' });
  migrateLegacyOpencodeKey(db);
  assert.equal(db.data['provider.opencode.key'], undefined);
  assert.equal(db.data['opencode_api_key'], undefined);
  assert.equal(db.data['provider.openrouter.key'], 'sk-or-1234');
});

test('after deleting the OpenCode key the provider is no longer configured', async () => {
  configureProviders({ getSetting: settings({}), getOpencodeKey: () => '' });
  delete process.env.OPENCODE_API_KEY;
  const { isConfigured, providerById } = await import('../providers');
  assert.equal(isConfigured(providerById('opencode')!), false);
});

// ------------------------------------------------------------------ limits --

test('429 text: retry-after seconds and daily wording', () => {
  assert.match(describeRateLimit('{"error":"slow down"}\n[retry-after=90;reset=]'), /через 2 мин/);
  const now = 1_790_000_000_000;
  const daily = describeRateLimit(`Rate limit exceeded: free-models-per-day\n[retry-after=;reset=${now + 3 * 3_600_000}]`, now);
  assert.match(daily, /дневной лимит/);
  assert.match(daily, /через 3 ч/);
  assert.match(describeRateLimit('Rate limit exceeded: free-models-per-day'), /00:00 UTC/);
});

test('openrouter limits come from GET /key (daily counter, free tier flag)', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/key' && req.headers.authorization === 'Bearer or-key') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { is_free_tier: true, free_model_daily_requests: { used: 12, limit: 50, remaining: 38 } } }));
    } else {
      res.writeHead(401).end('{}');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  configureProviders({ getSetting: settings({ 'provider.openrouter.key': 'or-key' }), getOpencodeKey: () => '' });
  try {
    const limits = await providerLimits(providerById('openrouter')!);
    assert.deepEqual(limits, { supported: true, perMinute: 20, freeTier: true, daily: { used: 12, limit: 50, remaining: 38 } });
    assert.deepEqual(await providerLimits(providerById('groq')!), { supported: false });
  } finally {
    delete process.env.OPENROUTER_BASE_URL;
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('a 429 from the provider reaches the user with the reset time', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
      res.end('{"error":{"message":"Rate limit exceeded"}}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  configureProviders({ getSetting: settings({ 'provider.openrouter.key': 'or-key' }), getOpencodeKey: () => '' });
  try {
    const chunks = await run('openrouter/x/y:free', fs.mkdtempSync(path.join(os.tmpdir(), 'otto-429-')));
    assert.match(String(chunks[0].content), /OpenRouter: .*лимит.*через 2 мин/);
  } finally {
    delete process.env.OPENROUTER_BASE_URL;
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('a cloud model that only sends keep-alive comments ends with a clear timeout error, not endless thinking', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const timer = setInterval(() => res.write(': PROCESSING\n\n'), 50);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  configureProviders({ getSetting: settings({ 'provider.custom.url': url }), getOpencodeKey: () => '' });
  process.env.OTTO_CLOUD_IDLE_MS = '400';
  try {
    const chunks = await run('custom/slow', fs.mkdtempSync(path.join(os.tmpdir(), 'otto-idle-')));
    const last = chunks[chunks.length - 1];
    assert.match(String(last.content), /не ответила за/);
  } finally {
    delete process.env.OTTO_CLOUD_IDLE_MS;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('SSE comments before the first token do not stall the stream (OpenRouter ": PROCESSING")', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': OPENROUTER PROCESSING\n\n');
    setTimeout(() => {
      res.write(`data: ${delta({ content: 'привет из облака' })}\n\n`);
      res.write(`data: ${delta({}, 'stop')}\n\n`);
      res.end('data: [DONE]\n\n');
    }, 80);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  configureProviders({ getSetting: settings({ 'provider.custom.url': url }), getOpencodeKey: () => '' });
  try {
    const chunks = await run('custom/q', fs.mkdtempSync(path.join(os.tmpdir(), 'otto-sse-')));
    assert.match(String(chunks[chunks.length - 1].content), /привет из облака/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('a failing cloud model is replaced by another one and the run continues', async () => {
  const used: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'bad' }, { id: 'good' }] }));
        return;
      }
      const model = JSON.parse(raw).model as string;
      used.push(model);
      if (model === 'bad') {
        res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"message":"invalid request"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${delta({ content: 'ответ от good' }, 'stop')}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  configureProviders({ getSetting: settings({ 'provider.custom.url': url }), getOpencodeKey: () => '' });
  try {
    const chunks = await run('custom/bad', fs.mkdtempSync(path.join(os.tmpdir(), 'otto-fb-')));
    const last = String(chunks[chunks.length - 1].content);
    assert.match(last, /ответ от good/);
    assert.match(last, /Смена модели: custom\/bad → custom\/good/);
    assert.doesNotMatch(last, /недоступна|HTTP|error/i, 'the provider error text is not shown, only from → to');
    assert.deepEqual(used, ['bad', 'bad', 'good'], 'one shrunk retry on the same model, then the fallback');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('pictures go to the cloud model the user picked (image_url parts) — Ollama is not asked at all', async () => {
  let userMessage: { content?: unknown } | undefined;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'm' }] }));
        return;
      }
      const messages = JSON.parse(raw).messages as Array<{ role: string; content?: unknown }>;
      userMessage = [...messages].reverse().find((m) => m.role === 'user');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${delta({ content: 'вижу картинку' }, 'stop')}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  configureProviders({ getSetting: settings({ 'provider.custom.url': `http://127.0.0.1:${(server.address() as AddressInfo).port}` }), getOpencodeKey: () => '' });
  const previousOllama = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = 'http://127.0.0.1:9'; // nothing listens there: any Ollama request would fail the run
  try {
    const chunks: Array<Record<string, unknown>> = [];
    for await (const raw of generateResponse({
      prompt: 'что на скриншоте?',
      messageId: 'm',
      projectId: 1,
      projectPath: fs.mkdtempSync(path.join(os.tmpdir(), 'otto-img-')),
      model: 'custom/m',
      useTools: true,
      images: ['iVBORw0KGgoAAAANSUhEUg'],
    })) chunks.push(JSON.parse(raw));
    assert.ok(!chunks.some((c) => c.role === 'error' || /Ollama/.test(String(c.content))), 'no Ollama error');
    assert.match(String(chunks[chunks.length - 1].content), /вижу картинку/);
    const parts = userMessage?.content as Array<{ type: string; image_url?: { url: string } }>;
    assert.ok(Array.isArray(parts), 'the user message carries parts');
    assert.equal(parts.find((p) => p.type === 'image_url')?.image_url?.url, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg');
  } finally {
    if (previousOllama === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = previousOllama;
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('empty messages are never sent to a cloud backend (Cohere: "must have non-empty content or tool calls")', async () => {
  let sent: Array<{ role: string; content?: string | null; tool_calls?: unknown }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'm' }] }));
        return;
      }
      sent = JSON.parse(raw).messages;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${delta({ content: 'ok' }, 'stop')}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  configureProviders({ getSetting: settings({ 'provider.custom.url': `http://127.0.0.1:${(server.address() as AddressInfo).port}` }), getOpencodeKey: () => '' });
  try {
    const gen = generateResponse({
      prompt: 'привет',
      messageId: 'm',
      projectId: 1,
      projectPath: fs.mkdtempSync(path.join(os.tmpdir(), 'otto-empty-')),
      model: 'custom/m',
      useTools: true,
      history: [
        { role: 'user', content: 'раз' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'два' },
      ],
    });
    for await (const _ of gen) void _;
    assert.ok(sent.length > 0);
    for (const m of sent) assert.ok(m.tool_calls || String(m.content ?? '').trim(), `empty ${m.role} message was sent`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('when the cloud provider runs out, the answer comes from a local model; with none left, a calm message says why', async () => {
  // a cloud provider that is out of its limit
  const cloud = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/models') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'm1' }] })); return; }
      res.writeHead(429, { 'content-type': 'application/json' }).end('{"error":{"message":"Rate limit exceeded"}}');
    });
  });
  // a local Ollama with one model
  const ollama = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/api/tags') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:14b' }] })); return; }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(`${JSON.stringify({ message: { role: 'assistant', content: '{"action":"answer","args":{"text":"ответ локальной модели"}}' }, done: true })}\n`);
    });
  });
  await new Promise<void>((r) => cloud.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r));
  const savedOllama = process.env.OLLAMA_URL;
  configureProviders({ getSetting: settings({ 'provider.custom.url': `http://127.0.0.1:${(cloud.address() as AddressInfo).port}` }), getOpencodeKey: () => '' });
  try {
    process.env.OLLAMA_URL = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
    const chunks = await run('custom/m1', fs.mkdtempSync(path.join(os.tmpdir(), 'otto-chain-')));
    const last = String(chunks[chunks.length - 1].content);
    assert.match(last, /Смена модели: custom\/m1 → qwen2\.5-coder:14b/);
    assert.match(last, /ответ локальной модели/);
    assert.ok(!chunks.some((c) => c.isError), 'no error card on the way');

    // nothing left: no local Ollama either
    process.env.OLLAMA_URL = 'http://127.0.0.1:9';
    const none = await run('custom/m1', fs.mkdtempSync(path.join(os.tmpdir(), 'otto-chain-')));
    const text = String(none[none.length - 1].content);
    assert.match(text, /Лимиты исчерпаны у всех доступных провайдеров/);
    assert.match(text, /custom\/m1: .*лимит/i, 'the reason of every provider is listed');
  } finally {
    process.env.OLLAMA_URL = savedOllama;
    await new Promise<void>((r) => cloud.close(() => r()));
    await new Promise<void>((r) => ollama.close(() => r()));
  }
});
