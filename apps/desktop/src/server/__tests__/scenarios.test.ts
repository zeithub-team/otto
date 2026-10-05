/**
 * Scenario tests for the image → template and "use my HTML" flows, against a
 * fake Ollama that distinguishes the vision stage (stream:false + images)
 * from the tool-using stage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { generateResponse } from '../ollama';
// these tests exercise the native tool-calling loop (guided mode has its own tests: guided.test.ts)
process.env.OTTO_LOCAL_MODE = 'native';

interface ChatBody {
  model: string;
  stream?: boolean;
  messages: Array<{ role: string; content: string; images?: string[] }>;
}

async function fakeOllama(opts: { visionSpec?: string; agentTurns: Array<Record<string, unknown>>; installed?: string[] }) {
  const chatRequests: ChatBody[] = [];
  let agentIdx = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: (opts.installed ?? []).map((name) => ({ name })) }));
        return;
      }
      if (req.url !== '/api/chat') {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as ChatBody;
      chatRequests.push(body);
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: { role: 'assistant', content: opts.visionSpec ?? '' }, done: true }));
        return;
      }
      const turn = opts.agentTurns[Math.min(agentIdx++, opts.agentTurns.length - 1)];
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: turn.content ?? '', tool_calls: turn.tool_calls }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.OLLAMA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { chatRequests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const call = (name: string, args: unknown) => ({ function: { name, arguments: args } });
const project = () => fs.mkdtempSync(path.join(os.tmpdir(), 'otto-scn-'));

async function run(opts: Parameters<typeof generateResponse>[0]) {
  const chunks: Array<Record<string, any>> = [];
  for await (const raw of generateResponse(opts)) chunks.push(JSON.parse(raw));
  return chunks;
}

test('screenshot → the vision model writes a spec, the tool model builds concept.html', async () => {
  const root = project();
  const spec = 'Тёмная тема, фон #0a0f0d, акцент #00f5a0, кнопка «Начать»';
  const ollama = await fakeOllama({
    visionSpec: spec,
    installed: ['llava:7b', 'qwen3-coder:30b'],
    agentTurns: [
      { tool_calls: [call('write_file', { path: 'concept.html', content: '<!doctype html><body style="background:#0a0f0d"><button>Начать</button>' })] },
      { content: 'ИТОГ: создан concept.html' },
    ],
  });
  try {
    const chunks = await run({
      prompt: 'сделай шаблон по скриншоту',
      messageId: 'm',
      projectId: 1,
      projectPath: root,
      images: ['aGVsbG8='],
      model: 'llava:7b',
      useTools: true,
    });

    const [visionReq, agentReq] = ollama.chatRequests;
    assert.equal(visionReq.model, 'llava:7b');
    assert.equal(visionReq.stream, false);
    assert.ok(visionReq.messages.some((m) => m.images?.length));

    // the tool stage runs on the text model and never receives the raw image
    assert.notEqual(agentReq.model, 'llava:7b');
    assert.ok(!agentReq.messages.some((m) => m.images?.length));
    const user = agentReq.messages.find((m) => m.role === 'user')!;
    assert.match(user.content, /#00f5a0/);
    assert.match(user.content, /сделай шаблон по скриншоту/);

    const html = fs.readFileSync(path.join(root, 'concept.html'), 'utf8');
    assert.match(html, /Начать/);
    assert.match(String(chunks[chunks.length - 1].content), /concept\.html/);
  } finally {
    await ollama.close();
  }
});

test('screenshot without any vision model gives a clear instruction', async () => {
  const ollama = await fakeOllama({ installed: ['qwen3-coder:30b'], agentTurns: [{ content: 'x' }] });
  try {
    const chunks = await run({
      prompt: 'по скриншоту',
      messageId: 'm',
      projectId: 1,
      projectPath: project(),
      images: ['aGVsbG8='],
      model: 'qwen3-coder:30b',
      useTools: true,
    });
    assert.match(String(chunks[0].content), /vision-модель/);
    assert.equal(ollama.chatRequests.length, 0);
  } finally {
    await ollama.close();
  }
});

test('an empty vision description is reported, not silently ignored', async () => {
  const ollama = await fakeOllama({ visionSpec: '', installed: ['llava:7b'], agentTurns: [{ content: 'x' }] });
  try {
    const chunks = await run({
      prompt: 'p',
      messageId: 'm',
      projectId: 1,
      projectPath: project(),
      images: ['aGVsbG8='],
      model: 'llava:7b',
      useTools: true,
    });
    assert.match(String(chunks[chunks.length - 1].content), /не вернула описание/);
  } finally {
    await ollama.close();
  }
});

test('user HTML is passed intact and the template rules are in the system prompt', async () => {
  const root = project();
  const html = '<!doctype html><html><head><style>.hero{color:#123456}</style></head><body><h1 class="hero">Hi</h1></body></html>';
  const ollama = await fakeOllama({ agentTurns: [{ content: 'ok' }] });
  try {
    await run({ prompt: `Используй этот шаблон и поменяй заголовок:\n${html}`, messageId: 'm', projectId: 1, projectPath: root, model: 'x', useTools: true });
    const req = ollama.chatRequests[0];
    assert.match(req.messages[0].content, /ОБРАЗЦЫ И ШАБЛОНЫ/);
    assert.ok(req.messages.find((m) => m.role === 'user')!.content.includes(html));
  } finally {
    await ollama.close();
  }
});

test('a big HTML template from earlier in the chat keeps its head, not its tail', async () => {
  const root = project();
  const template = '<!doctype html><html><head><title>TEMPLATE-HEAD</title></head><body>' + 'x'.repeat(9000) + 'TAIL</body></html>';
  const ollama = await fakeOllama({ agentTurns: [{ content: 'ok' }] });
  try {
    await run({
      prompt: 'теперь добавь футер',
      messageId: 'm',
      projectId: 1,
      projectPath: root,
      model: 'x',
      useTools: true,
      history: [
        { role: 'user', content: template },
        { role: 'assistant', content: 'принято' },
      ],
    });
    const kept = ollama.chatRequests[0].messages.find((m) => m.role === 'user' && m.content.includes('TEMPLATE-HEAD'));
    assert.ok(kept, 'template head must survive history trimming');
    assert.ok(kept.content.length > 8000);
  } finally {
    await ollama.close();
  }
});

type WithTools = { tools?: Array<{ function: { name: string } }> };
const toolNames = (req: unknown): string[] => ((req as WithTools).tools ?? []).map((t) => t.function.name);

test('Web on (default): web_search and fetch_url are offered and described in the prompt', async () => {
  const ollama = await fakeOllama({ agentTurns: [{ content: 'ok' }] });
  try {
    await run({ prompt: 'изучи тему', messageId: 'm', projectId: 1, projectPath: project(), model: 'x', useTools: true });
    const names = toolNames(ollama.chatRequests[0]);
    assert.ok(names.includes('web_search') && names.includes('fetch_url'));
    assert.match(ollama.chatRequests[0].messages[0].content, /ИССЛЕДОВАНИЕ/);
  } finally {
    await ollama.close();
  }
});

test('Web off: web tools are neither offered nor mentioned', async () => {
  const ollama = await fakeOllama({ agentTurns: [{ content: 'ok' }] });
  try {
    await run({ prompt: 'p', messageId: 'm', projectId: 1, projectPath: project(), model: 'x', useTools: true, useWeb: false });
    const names = toolNames(ollama.chatRequests[0]);
    assert.ok(!names.includes('web_search') && !names.includes('fetch_url'));
    assert.ok(names.includes('write_file'));
    assert.ok(!/web_search/.test(ollama.chatRequests[0].messages[0].content));
  } finally {
    await ollama.close();
  }
});

test('Web off: a web call the model makes anyway is refused', async () => {
  const ollama = await fakeOllama({
    agentTurns: [{ tool_calls: [call('web_search', { query: 'x' })] }, { content: 'готово' }],
  });
  try {
    await run({ prompt: 'p', messageId: 'm', projectId: 1, projectPath: project(), model: 'x', useTools: true, useWeb: false });
    const toolMsg = ollama.chatRequests[1].messages.find((m) => m.role === 'tool');
    assert.match(String(toolMsg?.content), /отключены пользователем/);
  } finally {
    await ollama.close();
  }
});
