import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { Db } from '../db';
import { listTaskRuns, startTaskPlan, startTaskRun } from '../taskrunner';
// these tests exercise the native tool-calling loop (guided mode has its own tests: guided.test.ts)
process.env.OTTO_LOCAL_MODE = 'native';

type Turn = { content?: string; tool_calls?: unknown[] };

/** Scripted /api/chat turns; records every request's messages. */
async function fakeOllama(turns: Turn[]) {
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const turn = turns[Math.min(requests.length - 1, turns.length - 1)];
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: turn.content ?? '', tool_calls: turn.tool_calls }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.OLLAMA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const call = (name: string, args: unknown) => ({ function: { name, arguments: args } });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-tr-'));
  const db = new Db(path.join(dir, 'app.db'));
  const projectPath = path.join(dir, 'proj');
  fs.mkdirSync(projectPath);
  const projectId = db.createProject('proj', projectPath);
  return { db, dir, projectPath, projectId, deps: { db, workspaceRoot: dir } };
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('runner executes steps in order with fresh context and checks them off', async () => {
  const { db, projectPath, projectId, deps } = setup();
  const task = db.createTask(projectId, 'Сделать сайт', '', 'user');
  const s1 = db.createTask(projectId, 'Создать index.html', '', 'user', task.id);
  const s2 = db.createTask(projectId, 'Добавить styles.css', '', 'user', task.id);
  const ollama = await fakeOllama([
    { tool_calls: [call('write_file', { path: 'index.html', content: '<h1>hi</h1>' })] },
    { content: 'ИТОГ: создан index.html' },
    { tool_calls: [call('write_file', { path: 'styles.css', content: 'h1{}' })] },
    { content: 'ИТОГ: создан styles.css' },
  ]);
  try {
    startTaskRun(deps, task.id);
    await waitFor(() => listTaskRuns(projectId)[0]?.status !== 'running');

    assert.equal(listTaskRuns(projectId)[0].status, 'done');
    assert.equal(db.getTask(s1.id)!.status, 'done');
    assert.equal(db.getTask(s2.id)!.status, 'done');
    assert.equal(db.getTask(task.id)!.status, 'done');
    assert.ok(fs.existsSync(path.join(projectPath, 'index.html')));
    assert.ok(fs.existsSync(path.join(projectPath, 'styles.css')));
    assert.match(db.getTask(s1.id)!.detail, /index\.html/);

    // step 2 starts a NEW conversation that carries step 1's recorded result
    const step2First = ollama.requests[2].messages;
    assert.equal(step2First.filter((m) => m.role === 'user').length, 1);
    const prompt = step2First.find((m) => m.role === 'user')!.content;
    assert.match(prompt, /1\. \[x\] Создать index\.html/);
    assert.match(prompt, /итог: .*index\.html/);
    assert.match(prompt, /ТОЛЬКО этап 2/);
  } finally {
    await ollama.close();
    db.close();
  }
});

test('runner skips already finished steps', async () => {
  const { db, projectId, deps } = setup();
  const task = db.createTask(projectId, 'T', '', 'user');
  const done = db.createTask(projectId, 'уже сделано', '', 'user', task.id);
  db.updateTask(done.id, { status: 'done' });
  const todo = db.createTask(projectId, 'осталось', '', 'user', task.id);
  const ollama = await fakeOllama([{ content: 'ИТОГ: готово' }]);
  try {
    startTaskRun(deps, task.id);
    await waitFor(() => listTaskRuns(projectId)[0]?.status !== 'running');
    assert.equal(ollama.requests.length, 1);
    assert.equal(db.getTask(todo.id)!.status, 'done');
  } finally {
    await ollama.close();
    db.close();
  }
});

test('a failing step stops the run and stays unchecked', async () => {
  const { db, projectId, deps } = setup();
  const task = db.createTask(projectId, 'T', '', 'user');
  const step = db.createTask(projectId, 'шаг', '', 'user', task.id);
  // unreachable Ollama → connection error chunk
  process.env.OLLAMA_URL = 'http://127.0.0.1:9';
  try {
    startTaskRun(deps, task.id);
    await waitFor(() => listTaskRuns(projectId)[0]?.status !== 'running');
    assert.equal(listTaskRuns(projectId)[0].status, 'error');
    assert.equal(db.getTask(step.id)!.status, 'todo');
  } finally {
    db.close();
  }
});

test('plan: the model fills the checklist through plan_task', async () => {
  const { db, projectId, deps } = setup();
  const task = db.createTask(projectId, 'Большая фича', '', 'user');
  const ollama = await fakeOllama([
    { tool_calls: [call('plan_task', { title: 'ignored', steps: ['1. Схема БД', '2. API', '- UI'] })] },
    { content: 'План готов' },
  ]);
  try {
    startTaskPlan(deps, task.id);
    await waitFor(() => listTaskRuns(projectId)[0]?.status !== 'planning');
    assert.equal(listTaskRuns(projectId)[0].status, 'done');
    assert.deepEqual(db.listSteps(task.id).map((s) => s.title), ['Схема БД', 'API', 'UI']);
  } finally {
    await ollama.close();
    db.close();
  }
});

test('deleting a task removes its steps', () => {
  const { db, projectId } = setup();
  const task = db.createTask(projectId, 'T', '', 'user');
  db.createTask(projectId, 's', '', 'user', task.id);
  db.deleteTask(task.id);
  assert.equal(db.listTasks(projectId).length, 0);
  db.close();
});
