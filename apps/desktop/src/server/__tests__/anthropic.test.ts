import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { buildAnthropicBody, toAnthropicMessages, type AnthropicPayload } from '../anthropic';
import { generateResponse } from '../ollama';
import { configureProviders, listAllCloudModels, testProvider, providerById } from '../providers';

const msgs = (list: AnthropicPayload['messages']) => list;

test('messages: system goes to `system`, tool calls pair with their results, turns alternate', () => {
  const { system, turns } = toAnthropicMessages(msgs([
    { role: 'system', content: 'RULES' },
    { role: 'user', content: 'сделай файл' },
    { role: 'assistant', content: 'ок', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'a', content: 'b' } } }, { function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
    { role: 'tool', content: 'written', tool_name: 'write_file' },
    { role: 'tool', content: '', tool_name: 'read_file' },
    { role: 'system', content: 'Продолжай' },
  ]));
  assert.equal(system, 'RULES');
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'user']);
  const assistant = turns[1].content as Array<Record<string, unknown>>;
  assert.deepEqual(assistant.map((b) => b.type), ['text', 'tool_use', 'tool_use']);
  assert.deepEqual(assistant[2].input, { path: 'a' }); // JSON-string arguments are parsed
  const results = turns[2].content as Array<Record<string, unknown>>;
  assert.deepEqual(results.map((b) => b.type), ['tool_result', 'tool_result', 'text']); // results first, then the nudge
  assert.equal(results[0].tool_use_id, assistant[1].id);
  assert.equal(results[1].tool_use_id, assistant[2].id);
  assert.equal(results[1].content, '(пусто)'); // empty results are not allowed
});

test('images become base64 blocks with the right media type', () => {
  const { turns } = toAnthropicMessages(msgs([{ role: 'user', content: 'что тут?', images: ['/9j/AAAA', 'iVBORw0KGgo'] }]));
  const blocks = turns[0].content as Array<{ type: string; source?: { media_type: string } }>;
  assert.deepEqual(blocks.map((b) => b.source?.media_type ?? b.type), ['image/jpeg', 'image/png', 'text']);
});

test('effort → extended thinking budget; not used while earlier tool turns lack their reasoning blocks', () => {
  const base: AnthropicPayload = { model: 'm', messages: [{ role: 'user', content: 'hi' }], effort: 'high', options: { num_predict: 2000, temperature: 0.4 } };
  const on = buildAnthropicBody(base);
  assert.deepEqual(on.thinking, { type: 'enabled', budget_tokens: 16384 });
  assert.ok((on.max_tokens as number) >= 16384 + 4096);
  assert.equal(on.temperature, undefined, 'temperature must be left out while thinking');

  const off = buildAnthropicBody({ ...base, effort: 'off' });
  assert.equal(off.thinking, undefined);
  assert.equal(off.temperature, 0.4);

  const withTools = buildAnthropicBody({
    ...base,
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: {} } }] },
      { role: 'tool', content: 'r' },
    ],
  });
  assert.equal(withTools.thinking, undefined, 'no thinking without the earlier reasoning blocks');
  const kept = buildAnthropicBody({
    ...base,
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: {} } }], thinking_blocks: [{ thinking: 'hm', signature: 'sig' }] },
      { role: 'tool', content: 'r' },
    ],
  });
  assert.ok(kept.thinking, 'thinking stays on when the blocks are passed back');
});

/** A scripted Claude: `/v1/models` and streamed `/v1/messages`. */
async function fakeClaude(streams: string[][]) {
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: any }> = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null });
      if (req.headers['x-api-key'] !== 'sk-ant-test') {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
        return;
      }
      if (req.url?.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'claude-test-1', display_name: 'Claude Test 1' }, { id: 'claude-test-2', display_name: 'Claude Test 2' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of streams[Math.min(n++, streams.length - 1)]) res.write(`data: ${event}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seen, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const ev = (o: unknown) => JSON.stringify(o);

test('Claude end to end: models list, thinking, tool_use with streamed JSON, results and reasoning sent back', async () => {
  const fake = await fakeClaude([
    [
      ev({ type: 'message_start', message: { usage: { input_tokens: 120, output_tokens: 1 } } }),
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Нужно создать файл.' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG123' } }),
      ev({ type: 'content_block_stop', index: 0 }),
      ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_a', name: 'write_file', input: {} } }),
      ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"claude.txt",' } }),
      ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"content":"привет"}' } }),
      ev({ type: 'content_block_stop', index: 1 }),
      ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } }),
      ev({ type: 'message_stop' }),
    ],
    [
      ev({ type: 'message_start', message: { usage: { input_tokens: 200, output_tokens: 1 } } }),
      ': ping',
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ИТОГ: создан claude.txt' } }),
      ev({ type: 'content_block_stop', index: 0 }),
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }),
    ],
  ]);
  configureProviders({ getSetting: () => '', getOpencodeKey: () => '' });
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  try {
    const list = await listAllCloudModels();
    assert.deepEqual(list.models.filter((m) => m.startsWith('claude/')), ['claude/claude-test-1', 'claude/claude-test-2']);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-claude-'));
    const chunks: Array<Record<string, any>> = [];
    const usages: number[] = [];
    for await (const raw of generateResponse({
      prompt: 'создай claude.txt',
      messageId: 'm1',
      projectId: 1,
      projectPath: root,
      model: 'claude/claude-test-1',
      useTools: true,
      effort: 'medium',
      onUsage: (u) => usages.push(u.used),
    })) chunks.push(JSON.parse(raw));

    assert.equal(fs.readFileSync(path.join(root, 'claude.txt'), 'utf8'), 'привет');
    assert.match(String(chunks[chunks.length - 1].content), /ИТОГ: создан claude\.txt/);
    assert.ok(chunks.some((c) => c.role === 'thinking' && /создать файл/.test(c.content)), 'reasoning shown');
    assert.ok(usages.length >= 2 && usages[0] > 0, 'real token counts reach the meter');

    const [first, second] = fake.seen.filter((s) => s.url === '/v1/messages');
    assert.equal(first.headers['x-api-key'], 'sk-ant-test');
    assert.equal(first.headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(first.body.thinking, { type: 'enabled', budget_tokens: 8192 });
    assert.ok(first.body.tools.every((t: any) => t.name && t.input_schema));
    assert.equal(first.body.model, 'claude-test-1', 'the provider prefix is stripped');
    // the second request carries the tool result and the reasoning block with its signature
    const assistant = second.body.messages.find((m: any) => m.role === 'assistant').content;
    assert.deepEqual(assistant.map((b: any) => b.type), ['thinking', 'tool_use']);
    assert.equal(assistant[0].signature, 'SIG123');
    const result = second.body.messages[second.body.messages.length - 1].content;
    assert.equal(result[0].type, 'tool_result');
    assert.equal(result[0].tool_use_id, assistant[1].id);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    await fake.close();
  }
});

test('a wrong Claude key is reported by the key check', async () => {
  const fake = await fakeClaude([[]]);
  configureProviders({ getSetting: (k) => (k === 'provider.anthropic.key' ? 'nope' : ''), getOpencodeKey: () => '' });
  try {
    const result = await testProvider(providerById('anthropic')!);
    assert.equal(result.ok, false);
    assert.match(String(result.error), /Invalid API key/);
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    await fake.close();
  }
});
