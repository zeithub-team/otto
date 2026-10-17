import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { Db } from '../db';
import { FileClaims, nextGroup, parseStep, afterOf, checkIssue, checkOf, dependencies, phaseOf, readyGroup, shellCheck, stepDetail } from '../steps';
import { startTaskRun } from '../taskrunner';
// these tests exercise the native tool-calling loop (guided mode has its own tests: guided.test.ts)
process.env.OTTO_LOCAL_MODE = 'native';

test('a leading ∥ / || / [parallel] marks a step that runs together with the previous one', () => {
  assert.deepEqual(parseStep('∥ Экспорт в CSV'), { title: 'Экспорт в CSV', parallel: true, check: '', after: [] });
  assert.deepEqual(parseStep('|| Export'), { title: 'Export', parallel: true, check: '', after: [] });
  assert.deepEqual(parseStep('[Parallel] Export'), { title: 'Export', parallel: true, check: '', after: [] });
  assert.deepEqual(parseStep('[параллельно] Тесты'), { title: 'Тесты', parallel: true, check: '', after: [] });
  assert.deepEqual(parseStep('Обычный этап'), { title: 'Обычный этап', parallel: false, check: '', after: [] });
});

test('a group is the first unfinished step plus the parallel ones right after it (capped)', () => {
  const s = (id: number, status: string, parallel: boolean) => ({ id, status, parallel });
  const steps = [s(1, 'done', false), s(2, 'todo', false), s(3, 'todo', true), s(4, 'todo', true), s(5, 'todo', false), s(6, 'todo', true)];
  assert.deepEqual(nextGroup(steps, 3).map((x) => x.id), [2, 3, 4]);
  assert.deepEqual(nextGroup(steps, 2).map((x) => x.id), [2, 3], 'the limit caps the group');
  assert.deepEqual(nextGroup(steps, 1).map((x) => x.id), [2]);
  assert.deepEqual(nextGroup([s(1, 'done', false)], 3), []);
  // a finished step in the middle ends the chain of parallel followers
  assert.deepEqual(nextGroup([s(1, 'todo', false), s(2, 'done', true), s(3, 'todo', true)], 3).map((x) => x.id), [1]);
});

test('a file taken by one parallel step is refused to the other, in any spelling', () => {
  const claims = new FileClaims();
  assert.equal(claims.claim(1, 'src/App.tsx'), null);
  assert.equal(claims.claim(1, './src/app.tsx'), null, 'the owner may write again');
  assert.match(String(claims.claim(2, 'src\\App.tsx')), /другой параллельный этап/);
  assert.equal(claims.claim(2, 'src/Other.tsx'), null);
});

type Msg = { role: string; content: string };

test('runner: steps marked parallel run at the same time, and a shared file is given to one of them only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-par-'));
  const db = new Db(path.join(dir, 'app.db'));
  const projectPath = path.join(dir, 'proj');
  fs.mkdirSync(projectPath);
  const projectId = db.createProject('proj', projectPath);
  const task = db.createTask(projectId, 'Сайт', '', 'user');
  const s1 = db.createTask(projectId, 'Шапка', '', 'user', task.id, false);
  const s2 = db.createTask(projectId, 'Подвал', '', 'user', task.id, true);
  const s3 = db.createTask(projectId, 'Итоговая страница', '', 'user', task.id, false);

  let inFlight = 0;
  let maxInFlight = 0;
  const toolResults: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const messages = (JSON.parse(body) as { messages: Msg[] }).messages;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 120)); // long enough for the two steps to overlap
      inFlight--;
      const user = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const stepNo = /этап (\d+)/.exec(user)?.[1] ?? '?';
      const tools = messages.filter((m) => m.role === 'tool');
      tools.forEach((t) => { if (!toolResults.includes(t.content)) toolResults.push(t.content); });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      // steps 1 and 2 (the parallel pair) both try to write shared.txt; every step also writes its own file
      const plan = stepNo === '1' || stepNo === '2' ? ['shared.txt', `own-${stepNo}.txt`] : [`own-${stepNo}.txt`];
      const wanted = plan[tools.length];
      const call = wanted ? { function: { name: 'write_file', arguments: { path: wanted, content: wanted === 'shared.txt' ? `step ${stepNo}` : `own ${stepNo}` } } } : null;
      res.write(JSON.stringify({ message: { role: 'assistant', content: call ? '' : `ИТОГ этапа ${stepNo}`, tool_calls: call ? [call] : undefined }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const previous = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    startTaskRun({ db, workspaceRoot: dir }, task.id, null);
    const end = Date.now() + 15000;
    while (db.listSteps(task.id).some((s) => s.status !== 'done')) {
      if (Date.now() > end) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(maxInFlight >= 2, `the two parallel steps overlapped (max ${maxInFlight})`);
    assert.ok(fs.existsSync(path.join(projectPath, 'own-1.txt')) && fs.existsSync(path.join(projectPath, 'own-2.txt')), 'each step wrote its own file');
    assert.ok(toolResults.some((r) => /другой параллельный этап/.test(r)), 'the second writer of shared.txt was refused');
    const shared = fs.readFileSync(path.join(projectPath, 'shared.txt'), 'utf8');
    assert.match(shared, /^step [12]$/, 'shared.txt was written by exactly one step');
    assert.deepEqual(db.listSteps(task.id).map((s) => [s.id, s.parallel]), [[s1.id, false], [s2.id, true], [s3.id, false]]);
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = previous;
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('a plan written as a plain list is understood', async () => {
  const { parseListPlan } = await import('../taskrunner');
  assert.deepEqual(parseListPlan('План:\n1. **Шапка** сайта\n2) Футер\n- ∥ Стили\nитого'), ['Шапка сайта', 'Футер', '∥ Стили']);
  assert.deepEqual(parseListPlan('нет списка'), []);
});

test('a planned step carries its phase, the steps it needs and its check', () => {
  const s = parseStep('[Бэкенд] Сервис книг: поиск и фильтры — после: 4, 6 — проверка: npx tsc --noEmit');
  assert.deepEqual(s, { title: '[Бэкенд] Сервис книг: поиск и фильтры', parallel: false, check: 'npx tsc --noEmit', after: [4, 6] });
  assert.equal(phaseOf(s.title), 'Бэкенд');
  assert.deepEqual(parseStep('Docker — проверка: `docker compose config`'), { title: 'Docker', parallel: false, check: 'docker compose config', after: [] });
  assert.deepEqual(parseStep('[Фронтенд] Каталог (after: #3 and #5)').after, []);
  assert.deepEqual(parseStep('[Фронтенд] Каталог — after: 3 and 5').after, [3, 5]);
  const detail = stepDetail(s);
  assert.deepEqual(afterOf(detail), [4, 6]);
  assert.equal(checkOf(detail), 'npx tsc --noEmit');
});

test('steps start when the steps they need are done; independent ones run side by side', () => {
  const st = (status: string, after: number[] = [], parallel = false) => ({ status, parallel, detail: stepDetail({ check: '', after }) });
  // 1 blueprint, 2 deps, 3 books (needs 2), 4 authors (needs 2), 5 frontend (needs 3, 4)
  const plan = [st('done'), st('done'), st('todo', [2]), st('todo', [2]), st('todo', [3, 4])];
  assert.deepEqual(readyGroup(plan, 4).map((s) => plan.indexOf(s) + 1), [3, 4], 'books and authors are independent');
  assert.deepEqual(readyGroup(plan, 1).map((s) => plan.indexOf(s) + 1), [3], 'one at a time when parallel steps are off');
  plan[2].status = 'done';
  assert.deepEqual(readyGroup(plan, 4).map((s) => plan.indexOf(s) + 1), [4], 'the frontend still waits for authors');
  plan[3].status = 'done';
  assert.deepEqual(readyGroup(plan, 4).map((s) => plan.indexOf(s) + 1), [5]);
  // no "после:" anywhere: the old sequence (and ∥ pairs) is kept
  const seq = [st('todo'), st('todo', [], true), st('todo')];
  assert.deepEqual(readyGroup(seq, 4).map((s) => seq.indexOf(s)), [0, 1]);
  // a reference to a later or missing step never stalls the run
  const odd = [st('todo', [9])];
  assert.equal(readyGroup(odd, 1).length, 1);
  assert.deepEqual(dependencies(seq), [[], [], [0, 1]]);
});

test('a planned check that is not a real command is skipped instead of blocking a finished step', () => {
  assert.equal(checkIssue('npx tsc --noEmit'), null);
  assert.equal(checkIssue('npm test && npm run test:e2e'), null);
  assert.equal(checkIssue('docker compose config'), null);
  assert.match(checkIssue('preview_page + run_in_page') ?? '', /Otto tool/);
  assert.match(checkIssue('docker compose ps (all healthy), curl endpoints, сид + тесты') ?? '', /description/);
  assert.match(checkIssue('cat README.md') ?? '', /proves nothing/);
  if (process.platform === 'win32') {
    assert.match(checkIssue('test -f .otto/blueprint.md') ?? '', /bash/);
    assert.match(checkIssue('cat package.json | grep scripts') ?? '', /bash|proves nothing/);
  }
  assert.equal(shellCheck('npm test && npm run test:e2e', 'win32'), 'npm test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run test:e2e');
  assert.equal(shellCheck('curl -f http://localhost/api/books', 'win32'), 'curl.exe -f http://localhost/api/books');
  assert.equal(shellCheck('npm test && npm run build', 'linux'), 'npm test && npm run build');
});
