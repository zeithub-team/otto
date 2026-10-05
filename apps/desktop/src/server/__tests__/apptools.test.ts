import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appTools, AGENT_SETTABLE, OTTO_GUIDE, type AppToolContext } from '../apptools';
import { codexArgs } from '../codexcli';

function setup(window = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-app-'));
  fs.writeFileSync(path.join(root, 'concept.html'), '<h1>hi</h1>');
  const sent: Array<Record<string, unknown>> = [];
  const ctx: AppToolContext = { root, projectId: 7, emitUi: window ? (a) => { sent.push(a); return true; } : null };
  const tools = Object.fromEntries(appTools(ctx, async () => null).map((t) => [t.name, t]));
  return { root, sent, tools };
}

test('every model is told about the app tools, and their schemas exist without a run', () => {
  const names = appTools(null).map((t) => t.name);
  for (const n of ['otto_about', 'otto_open', 'otto_preview', 'otto_appearance', 'otto_settings', 'ssh_connect', 'ssh_disconnect']) {
    assert.ok(names.includes(n), n);
    assert.ok(OTTO_GUIDE.includes(n.startsWith('ssh_') ? 'ssh_connect' : n), `guide mentions ${n}`);
  }
});

test('opening a section, a generated page in the Preview, theme and language go to the window', async () => {
  const { sent, tools } = setup();
  assert.match(await tools.otto_open.run({ view: 'settings', page: 'terminal' }), /Opened settings/);
  assert.match(await tools.otto_open.run({ view: 'nowhere' }), /Unknown section/);
  assert.match(await tools.otto_preview.run({ mode: 'file', path: 'concept.html' }), /Showing concept\.html/);
  assert.match(await tools.otto_preview.run({ mode: 'file', path: 'missing.html' }), /does not exist/);
  assert.match(await tools.otto_preview.run({ mode: 'file', path: '../outside.html' }), /inside the project/);
  assert.match(await tools.otto_appearance.run({ theme: 'nord', language: 'en' }), /theme nord, language en/);
  assert.match(await tools.otto_appearance.run({ theme: 'pink' }), /Unknown theme/);
  assert.deepEqual(sent, [
    { action: 'navigate', view: 'settings', page: 'terminal' },
    { action: 'preview-file', path: 'concept.html' },
    { action: 'theme', id: 'nord' },
    { action: 'locale', id: 'en' },
  ]);
});

test('without a window the tool says so instead of pretending', async () => {
  const { tools } = setup(false);
  assert.match(await tools.otto_open.run({ view: 'services' }), /no Otto window/);
});

test('settings: reading is free, a change is always approved, security switches stay the user’s', async () => {
  const { tools } = setup();
  assert.equal(tools.otto_settings.approval({ key: 'agent.maxSteps' }), null);
  assert.deepEqual(tools.otto_settings.approval({ key: 'agent.maxSteps', value: 60 }), { kind: 'shell', text: 'Setting agent.maxSteps = 60', always: true });
  for (const k of ['agent.shell', 'permissions.ssh', 'permissions.terminal', 'server.port']) assert.ok(!(AGENT_SETTABLE as readonly string[]).includes(k), k);
});

test('ssh_connect is approved with the target and never shows the password', () => {
  const { tools } = setup();
  const need = tools.ssh_connect.approval({ host: '10.0.0.5', user: 'root', password: 's3cret' });
  assert.equal(need?.kind, 'ssh');
  assert.equal(need?.text, 'SSH connect root@10.0.0.5:22 (password)');
  assert.ok(!need?.text.includes('s3cret'));
});

test('Codex gets Otto’s MCP server and may call it (Otto asks the user itself)', () => {
  const args = codexArgs({ model: 'codex-cli/gpt-5', cwd: '/p', edits: true, mcpUrl: 'http://127.0.0.1:1/mcp/x' });
  assert.ok(args.includes('mcp_servers.otto.url="http://127.0.0.1:1/mcp/x"'));
  assert.ok(args.includes('mcp_servers.otto.default_tools_approval_mode="approve"'));
  assert.ok(!codexArgs({ model: 'codex-cli/gpt-5', cwd: '/p', edits: false }).some((a) => a.includes('mcp_servers')));
});

test('the task list is a tool for every model; deleting is always approved', () => {
  const { tools } = setup();
  assert.ok(tools.otto_tasks, 'otto_tasks exists');
  assert.ok(OTTO_GUIDE.includes('otto_tasks'));
  assert.equal(tools.otto_tasks.approval({ action: 'add', items: [{ title: 'x' }] }), null);
  assert.deepEqual(tools.otto_tasks.approval({ action: 'delete', id: 3 }), { kind: 'shell', text: 'Delete task #3', always: true });
});
