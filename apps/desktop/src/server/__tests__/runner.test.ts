import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { detectRun, getRun, killAllRuns, mimeFor, startRun, stopRun } from '../runner';

const project = () => fs.mkdtempSync(path.join(os.tmpdir(), 'otto-run-'));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('detectRun picks the dev command, framework port and static sites', () => {
  const vite = project();
  fs.writeFileSync(path.join(vite, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' }, devDependencies: { vite: '^5' } }));
  assert.deepEqual([detectRun(vite).command, detectRun(vite).port], ['npm run dev', 5173]);

  const start = project();
  fs.writeFileSync(path.join(start, 'package.json'), JSON.stringify({ scripts: { start: 'node app.js' } }));
  assert.equal(detectRun(start).command, 'npm start');

  const laravel = project();
  fs.writeFileSync(path.join(laravel, 'artisan'), '');
  assert.equal(detectRun(laravel).command, 'php artisan serve');

  const site = project();
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>x</h1>');
  const d = detectRun(site);
  assert.deepEqual([d.kind, d.command, d.hasIndex], ['static', '', true]);

  assert.equal(detectRun(project()).kind, 'none');
});

test('mime types for the static site route', () => {
  assert.match(mimeFor('a.html'), /text\/html/);
  assert.equal(mimeFor('a.svg'), 'image/svg+xml');
  assert.equal(mimeFor('a.unknown'), 'application/octet-stream');
});

test('a run learns its URL from the output and can be stopped', async () => {
  const root = project();
  const script = "console.log('  Local:   http://localhost:5199/');setInterval(()=>{},1000)";
  const state = startRun(9001, root, `node -e "${script}"`);
  assert.equal(state.status, 'starting');
  for (let i = 0; i < 40 && !getRun(9001).url; i++) await wait(100);
  const run = getRun(9001);
  assert.equal(run.url, 'http://localhost:5199/');
  assert.equal(run.status, 'running');
  assert.ok(run.log.some((l) => l.includes('Local:')));
  stopRun(9001);
  assert.equal(getRun(9001).status, 'exited');
  killAllRuns();
});

test('0.0.0.0 in the output becomes localhost; a crashing command ends as exited', async () => {
  const root = project();
  startRun(9002, root, `node -e "console.log('listening on http://0.0.0.0:4300');process.exit(3)"`);
  for (let i = 0; i < 40 && getRun(9002).status !== 'exited'; i++) await wait(100);
  const run = getRun(9002);
  assert.equal(run.url, 'http://localhost:4300');
  assert.equal(run.status, 'exited');
  assert.equal(run.exit_code, 3);
  killAllRuns();
});

test('a server that prints nothing is found through its well-known port', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    startRun(9003, project(), 'node -e "setInterval(()=>{},1000)"', port);
    for (let i = 0; i < 40 && !getRun(9003).url; i++) await wait(100);
    assert.equal(getRun(9003).url, `http://localhost:${port}/`);
  } finally {
    killAllRuns();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('a command that hits EADDRINUSE attaches to the server already running on that port', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    startRun(9004, project(), `node -e "console.error('Error: listen EADDRINUSE: address already in use :::${port}');process.exit(1)"`);
    for (let i = 0; i < 50 && !getRun(9004).attached; i++) await wait(100);
    const run = getRun(9004);
    assert.equal(run.busy_port, port);
    assert.equal(run.attached, true);
    assert.equal(run.url, `http://localhost:${port}/`);
    assert.equal(run.status, 'running');
  } finally {
    killAllRuns();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('EADDRINUSE with the port on a later line (Node error dump) is understood too', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    startRun(9005, project(), `node -e "console.error(\\"code: 'EADDRINUSE',\\");console.error('  port: ${port}');process.exit(1)"`);
    for (let i = 0; i < 50 && !getRun(9005).attached; i++) await wait(100);
    assert.equal(getRun(9005).url, `http://localhost:${port}/`);
  } finally {
    killAllRuns();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('listPages finds html/svg files (index first, junk folders skipped); siteStamp follows edits', async () => {
  const { listPages, siteStamp } = await import('../runner');
  const root = project();
  for (const [name, body] of Object.entries({
    'index.html': '<h1>i</h1>', 'about.html': 'a', 'components/card.html': 'c', 'logo.svg': '<svg/>',
    'node_modules/pkg/x.html': 'no', 'dist/y.html': 'no', 'notes.md': 'no',
  })) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  assert.deepEqual(listPages(root), ['index.html', 'about.html', 'logo.svg', 'components/card.html']);
  const before = siteStamp(root);
  await wait(30);
  fs.writeFileSync(path.join(root, 'style.css'), 'body{}');
  assert.ok(siteStamp(root) > before);
});

test('output of a failing command is readable text, not mojibake (Windows OEM code page)', async () => {
  startRun(9006, project(), 'definitely_not_a_command_xyz');
  for (let i = 0; i < 60 && getRun(9006).status !== 'exited'; i++) await wait(100);
  const log = getRun(9006).log.join('\n');
  assert.ok(!log.includes('\uFFFD'), `replacement characters in: ${log}`);
  assert.ok(log.includes('definitely_not_a_command_xyz'));
  const { decodeOutput } = await import('../runner');
  assert.equal(decodeOutput(Buffer.from('привет', 'utf8')), 'привет');
  killAllRuns();
});
