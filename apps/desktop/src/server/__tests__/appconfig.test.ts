import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_PORT, configureAppSettings, configuredPort, live, readConfig, saveSettings, snapshot } from '../appconfig';
import { startServer } from '../index';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'otto-cfg-'));
const memoryDb = () => {
  const map = new Map<string, string>();
  return { getSetting: (k: string) => map.get(k) ?? '', setSetting: (k: string, v: string) => void map.set(k, v) };
};

test('defaults, then saved values; live settings come from the database, the port from config.json', () => {
  const dir = tmp();
  const db = memoryDb();
  const before = snapshot(dir, db);
  assert.equal(before.values['server.port'], DEFAULT_PORT);
  assert.equal(before.values['agent.maxSteps'], 40);
  assert.equal(before.values['agent.web'], true);

  const r = saveSettings(dir, db, { 'server.port': 45000, 'agent.maxSteps': 25, 'agent.web': false, 'terminal.shell': 'cmd', 'agent.numCtx': '65536' }, { 'server.port': DEFAULT_PORT });
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.restart_required, ['server.port']);
  assert.equal(readConfig(dir)['server.port'], 45000);
  assert.equal(db.getSetting('app.agent.maxSteps'), '25');

  configureAppSettings((k) => db.getSetting(k));
  assert.equal(live<number>('agent.maxSteps'), 25);
  assert.equal(live<boolean>('agent.web'), false);
  assert.equal(live<number>('agent.numCtx'), 65536);
  assert.equal(live<string>('terminal.shell'), 'cmd');
  assert.equal(configuredPort(dir, {}), 45000);
  assert.equal(configuredPort(tmp(), { OTTO_PORT: '9100' }), 9100);
  assert.equal(configuredPort(tmp(), {}), DEFAULT_PORT);
});

test('a restart is only required when the port really differs from the running one', () => {
  const dir = tmp();
  const db = memoryDb();
  assert.deepEqual(saveSettings(dir, db, { 'server.port': 43117 }, { 'server.port': 43117 }).restart_required, []);
  assert.deepEqual(saveSettings(dir, db, { 'server.port': 43120 }, { 'server.port': 43117 }).restart_required, ['server.port']);
});

test('invalid values are rejected with a reason and nothing else is lost', () => {
  const dir = tmp();
  const db = memoryDb();
  const r = saveSettings(dir, db, { 'server.port': 80, 'agent.maxSteps': 'many', 'agent.effort': 'ludicrous', 'ollama.url': 'localhost:11434', nope: 1, 'agent.web': true }, {});
  assert.deepEqual(Object.keys(r.errors).sort(), ['agent.effort', 'agent.maxSteps', 'nope', 'ollama.url', 'server.port']);
  assert.deepEqual(r.saved, ['agent.web']);
  assert.match(r.errors['server.port'], /1024/);
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
});

test('HTTP: GET/PUT /api/app-settings; the Ollama address applies immediately', async () => {
  const d = tmp();
  const server = await startServer({ port: 0, dbPath: path.join(d, 'app.db'), workspaceRoot: path.join(d, 'ws') });
  const oldUrl = process.env.OLLAMA_URL;
  try {
    const before = await (await fetch(`${server.url}/api/app-settings`)).json();
    assert.equal(before.running['server.port'], server.port);
    assert.equal(before.values['agent.maxSteps'], 40);
    assert.ok(before.meta.some((m: { key: string; restart?: boolean }) => m.key === 'server.port' && m.restart));

    const put = await fetch(`${server.url}/api/app-settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { 'ollama.url': 'http://127.0.0.1:12345', 'agent.maxSteps': 12, 'server.port': server.port + 1 } }),
    });
    const saved = await put.json();
    assert.equal(put.status, 200);
    assert.deepEqual(saved.restart_required, ['server.port']);
    assert.equal(saved.values['agent.maxSteps'], 12);
    assert.equal(process.env.OLLAMA_URL, 'http://127.0.0.1:12345');
    assert.equal(readConfig(d)['server.port'], server.port + 1);

    const bad = await fetch(`${server.url}/api/app-settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: { 'agent.maxSteps': 1 } }) });
    assert.equal(bad.status, 400);
  } finally {
    if (oldUrl === undefined) delete process.env.OLLAMA_URL;
    else process.env.OLLAMA_URL = oldUrl;
    await server.close();
  }
});
