import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { Db } from '../db';
import { listTaskRuns, startTaskPlan, startTaskRun, stepPrompt } from '../taskrunner';
import { stepDetail } from '../steps';
import { configureAppSettings } from '../appconfig';
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
    assert.match(prompt, /выполнено 1/);
    assert.match(prompt, /1\. Создать index\.html → ИТОГ: создан index\.html/);
    assert.doesNotMatch(prompt, /:::changes/, 'the UI files card is not passed on');
    assert.match(prompt, /ТОЛЬКО этап 2 из 2/);
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
  const ollama = await fakeOllama([{ tool_calls: [call('write_file', { path: 'rest.txt', content: 'x' })] }, { content: 'ИТОГ: готово' }]);
  try {
    startTaskRun(deps, task.id);
    await waitFor(() => listTaskRuns(projectId)[0]?.status !== 'running');
    // only the unfinished step ran (one tool turn + the answer)
    assert.equal(ollama.requests.length, 2);
    assert.equal(db.getTask(todo.id)!.status, 'done');
  } finally {
    await ollama.close();
    db.close();
  }
});

test('a step that only talks (no file changed, no command run) is not ticked off', async () => {
  const { db, projectId, deps } = setup();
  const task = db.createTask(projectId, 'T', '', 'user');
  const step = db.createTask(projectId, 'шаг', '', 'user', task.id);
  const ollama = await fakeOllama([{ content: 'Извините, навык не найден.' }]);
  try {
    startTaskRun(deps, task.id);
    await waitFor(() => listTaskRuns(projectId)[0]?.status !== 'running');
    assert.equal(db.getTask(step.id)!.status, 'todo');
    assert.equal(listTaskRuns(projectId)[0].status, 'error');
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

test('a step gets the blueprint, the phases, the results of the steps it needs — not the whole plan', () => {
  const row = (id: number, title: string, status: string, detail: string) =>
    ({ id, title, status, detail, parallel: false, project_id: 1, parent_id: 9, source: 'agent', created_at: 0, updated_at: 0 }) as unknown as Parameters<typeof stepPrompt>[1][number];
  const steps = [
    row(1, '[Каркас] Записать .otto/blueprint.md', 'done', 'Каркас записан [файлы: .otto/blueprint.md]'),
    row(2, '[Каркас] package.json и npm install', 'done', 'Зависимости поставлены [файлы: package.json]'),
    ...Array.from({ length: 20 }, (_, i) => row(3 + i, `[Бэкенд] Модуль ${i + 1}`, 'done', `Модуль ${i + 1} готов [файлы: src/m${i + 1}.ts]`)),
    row(23, '[Фронтенд] Каталог книг', 'todo', stepDetail({ after: [2, 5], check: 'npm run build' })),
    row(24, '[Docker] Dockerfile', 'todo', ''),
  ];
  const prompt = stepPrompt({ title: 'Книжный магазин', detail: null }, steps, steps[22], 'Стек: NestJS 10, TypeORM, PostgreSQL 16');
  assert.match(prompt, /Каркас проекта .*\n.*Стек: NestJS 10/);
  assert.match(prompt, /Фазы: Каркас 2\/2 → Бэкенд 20\/20 → ▶ Фронтенд 0\/1 → Docker 0\/1/);
  assert.match(prompt, /опирается на результаты этапов:\n- 2\. \[Каркас\] package\.json и npm install → Зависимости поставлены/);
  assert.match(prompt, /- 5\. \[Бэкенд\] Модуль 3 → Модуль 3 готов/);
  assert.match(prompt, /src\/m20\.ts/, 'files made so far are listed');
  assert.doesNotMatch(prompt, /- 7\. \[Бэкенд\] Модуль 5 →/, 'an old step that this one does not need is not repeated');
  assert.match(prompt, /НЕ делай их сейчас\): «\[Docker\] Dockerfile»/);
  assert.match(prompt, /ТОЛЬКО этап 23 из 24: «\[Фронтенд\] Каталог книг»\nЭтап считается выполненным, только когда проходит проверка: `npm run build`/);
  assert.ok(prompt.length < 4000, `stays small (${prompt.length} chars for 24 steps)`);
});

test('a step whose check fails is sent back with the output and done only when the check passes', async () => {
  configureAppSettings((k) => (k === 'app.agent.shell' ? 'auto' : ''));
  const { db, projectPath, projectId, deps } = setup();
  const task = db.createTask(projectId, 'Конфиг', '', 'user');
  const node = `node -e "process.exit(require('fs').readFileSync('flag.txt','utf8').trim()==='ok'?0:1)"`;
  const step = db.createTask(projectId, 'Записать flag.txt', stepDetail({ check: node, after: [] }), 'user', task.id);
  const ollama = await fakeOllama([
    { tool_calls: [call('write_file', { path: 'flag.txt', content: 'bad' })] },
    { content: 'ИТОГ: записал' },
    { tool_calls: [call('write_file', { path: 'flag.txt', content: 'ok' })] },
    { content: 'ИТОГ: исправил' },
  ]);
  try {
    startTaskRun(deps, task.id);
    await waitFor(() => listTaskRuns(projectId)[0]?.status !== 'running', 30000);
    assert.equal(listTaskRuns(projectId)[0].status, 'done');
    assert.equal(fs.readFileSync(path.join(projectPath, 'flag.txt'), 'utf8'), 'ok');
    const retry = ollama.requests[2].messages.find((m) => m.role === 'user')!.content;
    assert.match(retry, /ПРОВЕРКА ЭТАПА НЕ ПРОШЛА/);
    assert.match(retry, /exit code 1/);
    assert.match(db.getTask(step.id)!.detail, /проверка ✓/);
  } finally {
    configureAppSettings(() => '');
    await ollama.close();
    db.close();
  }
});

test('without permission to run commands the check is skipped, never run unasked', async () => {
  const { db, projectPath, projectId, deps } = setup();
  const task = db.createTask(projectId, 'T', '', 'user');
  const step = db.createTask(projectId, 'Файл', stepDetail({ check: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'1\')"', after: [] }), 'user', task.id);
  const ollama = await fakeOllama([{ tool_calls: [call('write_file', { path: 'a.txt', content: 'x' })] }, { content: 'ИТОГ: ок' }]);
  try {
    startTaskRun(deps, task.id);
    await waitFor(() => listTaskRuns(projectId)[0]?.status !== 'running');
    assert.equal(fs.existsSync(path.join(projectPath, 'ran.txt')), false);
    assert.match(db.getTask(step.id)!.detail, /проверка не запускалась: commands need approval/);
  } finally {
    await ollama.close();
    db.close();
  }
});

test('planning only plans: no file is written, and the run ends as soon as the plan exists', async () => {
  const { db, projectPath, projectId, deps } = setup();
  const task = db.createTask(projectId, 'Большой проект', '', 'user');
  const ollama = await fakeOllama([
    { tool_calls: [call('write_file', { path: 'early.ts', content: 'export const a = 1;\n' })] },
    { tool_calls: [call('plan_task', { title: 'Проект', steps: ['[Каркас] Записать .otto/blueprint.md', '[Бэкенд] Модуль книг — после: 1 — проверка: npx tsc --noEmit'] })] },
    { tool_calls: [call('write_file', { path: 'late.ts', content: 'export const b = 2;\n' })] },
    { content: 'всё сделал сам' },
  ]);
  try {
    startTaskPlan(deps, task.id);
    await waitFor(() => listTaskRuns(projectId)[0]?.status !== 'planning');
    assert.equal(listTaskRuns(projectId)[0].status, 'done');
    assert.equal(fs.existsSync(path.join(projectPath, 'early.ts')), false, 'nothing written before the plan');
    assert.equal(fs.existsSync(path.join(projectPath, 'late.ts')), false, 'nothing written after it');
    assert.equal(ollama.requests.length, 2, 'the model is not asked again after plan_task');
    const steps = db.listSteps(task.id);
    assert.deepEqual(steps.map((s) => s.title), ['[Каркас] Записать .otto/blueprint.md', '[Бэкенд] Модуль книг']);
    assert.match(steps[1].detail, /after: 1/);
    assert.match(steps[1].detail, /check: npx tsc --noEmit/);
  } finally {
    await ollama.close();
    db.close();
  }
});
