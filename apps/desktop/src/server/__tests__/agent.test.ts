/**
 * End-to-end agent loop against a fake Ollama server: verifies that the loop
 * really applies files, recovers from broken tool calls and cut-off answers.
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

type Turn = { content?: string; tool_calls?: unknown[]; done_reason?: string };

/** Serves scripted /api/chat turns (NDJSON) and records the request bodies. */
async function fakeOllama(turns: Turn[]) {
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url !== '/api/chat') {
        res.writeHead(404).end();
        return;
      }
      requests.push(JSON.parse(body));
      const turn = turns[Math.min(requests.length - 1, turns.length - 1)];
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: turn.content ?? '', tool_calls: turn.tool_calls }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: turn.done_reason ?? 'stop' }) + '\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  process.env.OLLAMA_URL = `http://127.0.0.1:${port}`;
  return { requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function run(projectPath: string, prompt: string): Promise<Array<Record<string, any>>> {
  const chunks: Array<Record<string, any>> = [];
  for await (const raw of generateResponse({
    prompt,
    messageId: 'm1',
    projectId: 1,
    projectPath,
    model: 'fake:1b',
    useTools: true,
  })) {
    chunks.push(JSON.parse(raw));
  }
  return chunks;
}

const call = (name: string, args: unknown) => ({ function: { name, arguments: args } });
const project = () => fs.mkdtempSync(path.join(os.tmpdir(), 'otto-agent-'));

test('agent writes the file requested via native tool_calls', async () => {
  const root = project();
  const ollama = await fakeOllama([
    { tool_calls: [call('write_file', { path: 'hello.txt', content: 'hi' })] },
    { content: 'ИТОГ: создан hello.txt' },
  ]);
  try {
    const chunks = await run(root, 'создай hello.txt');
    assert.equal(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8'), 'hi');
    const last = chunks[chunks.length - 1];
    assert.match(String(last.content), /hello\.txt/);
  } finally {
    await ollama.close();
  }
});

test('agent survives an aliased tool with file_path/text arguments', async () => {
  const root = project();
  const ollama = await fakeOllama([
    { tool_calls: [call('create_file', { file_path: 'a.md', text: '# a' })] },
    { content: 'готово' },
  ]);
  try {
    await run(root, 'создай a.md');
    assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), '# a');
  } finally {
    await ollama.close();
  }
});

test('agent recovers when write_file is called without content', async () => {
  const root = project();
  fs.writeFileSync(path.join(root, 'f.txt'), 'original');
  const ollama = await fakeOllama([
    { tool_calls: [call('write_file', { path: 'f.txt' })] },
    { tool_calls: [call('write_file', { path: 'f.txt', content: 'fixed' })] },
    { content: 'готово' },
  ]);
  try {
    await run(root, 'исправь f.txt');
    // second request must have carried the error result back to the model
    const toolMsg = ollama.requests[1].messages.find((m) => m.role === 'tool');
    assert.match(String(toolMsg?.content), /без 'content'/);
    assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'fixed');
  } finally {
    await ollama.close();
  }
});

test('agent executes a tool call emitted as text (XML)', async () => {
  const root = project();
  const ollama = await fakeOllama([
    { content: '<function=write_file><parameter=path>t.txt</parameter><parameter=content>text-call</parameter></function>' },
    { content: 'готово' },
  ]);
  try {
    await run(root, 'создай t.txt');
    assert.equal(fs.readFileSync(path.join(root, 't.txt'), 'utf8'), 'text-call');
  } finally {
    await ollama.close();
  }
});

test('a cut-off answer triggers a "write in parts" retry instead of a lost file', async () => {
  const root = project();
  const ollama = await fakeOllama([
    { content: '<function=write_file><parameter=path>big.txt</parameter><parameter=content>half', done_reason: 'length' },
    { tool_calls: [call('write_file', { path: 'big.txt', content: 'p1\n' })] },
    { tool_calls: [call('append_file', { path: 'big.txt', content: 'p2\n' })] },
    { content: 'готово' },
  ]);
  try {
    await run(root, 'создай большой файл');
    const retry = ollama.requests[1].messages.filter((m) => m.role === 'user').pop();
    assert.match(String(retry?.content), /оборвался/);
    assert.equal(fs.readFileSync(path.join(root, 'big.txt'), 'utf8'), 'p1\np2\n');
  } finally {
    await ollama.close();
  }
});

test('agent cannot write outside the project', async () => {
  const root = project();
  const outside = path.join(path.dirname(root), 'otto-escape.txt');
  const ollama = await fakeOllama([
    { tool_calls: [call('write_file', { path: '../otto-escape.txt', content: 'x' })] },
    { content: 'готово' },
  ]);
  try {
    await run(root, 'x');
    assert.ok(!fs.existsSync(outside));
  } finally {
    await ollama.close();
  }
});

test('a crashed model runner (500) is retried with a smaller context instead of failing the run', async () => {
  const root = project();
  const seen: number[] = [];
  let calls = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push(body.options?.num_ctx);
      if (++calls === 1) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"llama-server process has terminated: exit status 0xc0000409"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'ok после сбоя' }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.OLLAMA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const chunks = await run(root, 'привет');
    assert.match(String(chunks[chunks.length - 1].content), /после сбоя/);
    assert.equal(calls, 2);
    assert.equal(seen[1], seen[0] / 2, 'the retry halves num_ctx');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
