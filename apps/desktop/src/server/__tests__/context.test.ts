import test from 'node:test';
import assert from 'node:assert/strict';
import { compactMessages, readLimitChars, sliceFile, type ChatMessage } from '../context';

const big = Array.from({ length: 400 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`).join('\n');

test('small files are returned whole', () => {
  assert.equal(sliceFile('a\nb', 1000), 'a\nb');
});

test('a big file is cut with a hint to continue by line number', () => {
  const out = sliceFile(big, 2000);
  assert.ok(out.length < 2600);
  assert.match(out, /Показаны строки 1–\d+ из 400/);
  const next = /start_line=(\d+)/.exec(out);
  assert.ok(next);
  const part2 = sliceFile(big, 2000, Number(next[1]));
  assert.ok(part2.startsWith(`line ${next[1]} `));
});

test('an explicit line range is honoured', () => {
  const out = sliceFile(big, 100000, 10, 12);
  assert.ok(out.startsWith('line 10 '));
  assert.ok(out.includes('line 12 ') && !out.includes('line 13 '));
});

test('read limit scales with the window', () => {
  assert.ok(readLimitChars(32768) < readLimitChars(131072));
  assert.equal(readLimitChars(1000), 6000);
});

test('compaction shrinks old tool payloads but keeps the task and recent steps', () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'TASK: build the page' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'a', content: 'y'.repeat(20000) } } }] },
    { role: 'tool', tool_name: 'read_file', content: 'z'.repeat(30000) },
    { role: 'tool', tool_name: 'read_file', content: 'q'.repeat(30000) },
    { role: 'assistant', content: 'a' },
    { role: 'tool', tool_name: 'read_file', content: 'r'.repeat(30000) },
    { role: 'assistant', content: 'b' },
    { role: 'tool', tool_name: 'read_file', content: 'RECENT' },
    { role: 'assistant', content: 'c' },
    { role: 'user', content: 'go' },
  ];
  assert.equal(compactMessages(msgs.map((m) => ({ ...m })), 1_000_000), 0, 'nothing happens while there is room');
  const n = compactMessages(msgs, 32768);
  assert.ok(n >= 2);
  assert.equal(msgs[1].content, 'TASK: build the page');
  assert.match(msgs[3].content, /убран/);
  assert.match(String((msgs[2].tool_calls?.[0].function?.arguments as { content: string }).content), /записано 20000/);
  assert.equal(msgs[8].content, 'RECENT');
});
