import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { markSetupDone, readSetup } from '../setup';
import { startServer } from '../index';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'otto-setup-'));
const write = (d: string, text: string) => fs.writeFileSync(path.join(d, 'setup.json'), text, 'utf8');

test('no setup file → null', () => {
  assert.equal(readSetup(dir()), null);
});

test('installer output is parsed: comma-separated tools, BOM tolerated', () => {
  const d = dir();
  write(d, '﻿{"version":1,"locale":"ru","theme":"dracula","tools":"node,git,docker,ollama,"}');
  assert.deepEqual(readSetup(d), { version: 1, locale: 'ru', theme: 'dracula', tools: ['node', 'git', 'docker', 'ollama'] });
});

test('arrays work too, unknown tools and duplicates are dropped', () => {
  const d = dir();
  write(d, JSON.stringify({ locale: 'en', theme: 'nord', tools: ['python', 'PYTHON', 'rm -rf', 'go', ''] }));
  assert.deepEqual(readSetup(d)?.tools, ['python', 'go']);
});

test('garbage is sanitized to safe defaults', () => {
  const d = dir();
  write(d, JSON.stringify({ locale: 'xx', theme: '../../evil', tools: 42 }));
  assert.deepEqual(readSetup(d), { version: 1, locale: 'ru', theme: 'emerald', tools: [] });
});

test('unreadable JSON → null (never throws)', () => {
  const d = dir();
  write(d, '{not json');
  assert.equal(readSetup(d), null);
});

test('done renames the file so the setup applies once', () => {
  const d = dir();
  write(d, '{"locale":"it","theme":"light","tools":"git"}');
  assert.equal(markSetupDone(d), true);
  assert.equal(readSetup(d), null);
  assert.ok(fs.existsSync(path.join(d, 'setup.applied.json')));
  assert.equal(markSetupDone(d), false);
});

test('HTTP: GET /api/setup then POST /api/setup/done', async () => {
  const d = dir();
  write(d, '{"locale":"az","theme":"tokyo","tools":"node,git"}');
  const server = await startServer({ port: 0, dbPath: path.join(d, 'app.db'), workspaceRoot: path.join(d, 'ws') });
  try {
    const first = (await (await fetch(`${server.url}/api/setup`)).json()) as { setup: { locale: string; tools: string[] } | null };
    assert.equal(first.setup?.locale, 'az');
    assert.deepEqual(first.setup?.tools, ['node', 'git']);

    const done = (await (await fetch(`${server.url}/api/setup/done`, { method: 'POST' })).json()) as { done: boolean };
    assert.equal(done.done, true);

    const second = (await (await fetch(`${server.url}/api/setup`)).json()) as { setup: unknown };
    assert.equal(second.setup, null);
  } finally {
    await server.close();
  }
});
