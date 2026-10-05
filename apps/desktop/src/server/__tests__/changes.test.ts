import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { ChangeTracker, ThinkSplitter, lineDelta, stripChangesMarker } from '../changes';
import { generateResponse } from '../ollama';

test('lineDelta counts added and removed lines', () => {
  assert.deepEqual(lineDelta('', 'a\nb\nc'), { added: 3, removed: 0 });
  assert.deepEqual(lineDelta('a\nb\nc', 'a\nX\nc\nd'), { added: 2, removed: 1 });
  assert.deepEqual(lineDelta('a\nb', ''), { added: 0, removed: 2 });
  assert.deepEqual(lineDelta('same', 'same'), { added: 0, removed: 0 });
});

test('tracker: created stays created, made-and-deleted vanishes, marker round-trips', () => {
  const t = new ChangeTracker();
  t.track('write_file', { path: 'new.html' }, 'File CREATED (новый файл): new.html (10 bytes). x [Δ +12 −0]');
  t.track('append_file', { path: 'new.html' }, 'Appended to new.html (+3 bytes) [Δ +3 −0]');
  t.track('write_file', { path: 'old.css' }, 'File overwritten: old.css (5 bytes, was 9 bytes) [Δ +2 −4]');
  t.track('delete_file', { path: 'gone.txt' }, 'Deleted file: gone.txt [Δ +0 −7]');
  t.track('write_file', { path: 'tmp.txt' }, 'File CREATED (новый файл): tmp.txt (1 bytes). x [Δ +1 −0]');
  t.track('delete_file', { path: 'tmp.txt' }, 'Deleted file: tmp.txt [Δ +0 −1]');
  assert.deepEqual(t.list(), [
    { path: 'new.html', action: 'created', added: 15, removed: 0 },
    { path: 'old.css', action: 'modified', added: 2, removed: 4 },
    { path: 'gone.txt', action: 'deleted', added: 0, removed: 7 },
  ]);
  const text = `Готово.${t.marker()}`;
  assert.match(text, /:::changes\n\[.*\]\n:::$/s);
  assert.equal(stripChangesMarker(text), 'Готово.');
  assert.equal(new ChangeTracker().marker(), '');
});

test('ThinkSplitter separates <think> blocks even when the tags are cut between chunks', () => {
  const s = new ThinkSplitter();
  let visible = '';
  let think = '';
  for (const part of ['Привет <thi', 'nk>размышляю', ' долго</th', 'ink> ответ']) {
    const r = s.feed(part);
    visible += r.visible;
    think += r.think;
  }
  const rest = s.flush();
  visible += rest.visible;
  think += rest.think;
  assert.equal(visible, 'Привет  ответ');
  assert.equal(think, 'размышляю долго');
});

async function fake(turns: Array<Array<Record<string, unknown>>>) {
  let n = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (const chunk of turns[Math.min(n++, turns.length - 1)]) res.write(JSON.stringify(chunk) + '\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.OLLAMA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { close: () => new Promise<void>((r) => server.close(() => r())) };
}

const run = async (root: string) => {
  const chunks: Array<Record<string, any>> = [];
  for await (const raw of generateResponse({ prompt: 'сделай', messageId: 'm1', projectId: 1, projectPath: root, model: 'fake:1b', useTools: true })) chunks.push(JSON.parse(raw));
  return chunks;
};

test('the final answer carries a changes card; reasoning arrives as a thinking block', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-chg-'));
  fs.writeFileSync(path.join(root, 'old.txt'), 'a\nb\nc\n');
  const ollama = await fake([
    [
      { message: { role: 'assistant', content: '<think>надо создать', thinking: undefined }, done: false },
      { message: { role: 'assistant', content: ' файл</think>' }, done: false },
      { message: { role: 'assistant', content: '', tool_calls: [
        { function: { name: 'write_file', arguments: { path: 'new.txt', content: 'x\ny\n' } } },
        { function: { name: 'write_file', arguments: { path: 'old.txt', content: 'a\nB\nc\nd\n' } } },
        { function: { name: 'delete_file', arguments: { path: 'old.txt' } } },
      ] }, done: false },
      { message: { role: 'assistant', content: '' }, done: true },
    ],
    [
      { message: { role: 'assistant', thinking: 'проверяю', content: '' }, done: false },
      { message: { role: 'assistant', content: 'ИТОГ: сделано' }, done: false },
      { message: { role: 'assistant', content: '' }, done: true },
    ],
  ]);
  try {
    const chunks = await run(root);
    const thinking = chunks.filter((c) => c.role === 'thinking');
    assert.ok(thinking.length >= 2);
    assert.match(thinking[thinking.length - 1].content, /надо создать файл/);
    assert.match(thinking[thinking.length - 1].content, /проверяю/);
    assert.equal(thinking[thinking.length - 1].isStreaming, false);
    const final = chunks[chunks.length - 1];
    assert.equal(final.role, 'assistant');
    assert.ok(!final.content.includes('<think>'));
    const card = /:::changes\n(.*)\n:::/s.exec(final.content);
    assert.ok(card, 'changes card present');
    const files = JSON.parse(card![1]);
    assert.deepEqual(files.map((f: { path: string; action: string }) => [f.path, f.action]), [['new.txt', 'created'], ['old.txt', 'deleted']]);
    assert.equal(files[0].added, 2);
  } finally {
    await ollama.close();
  }
});
