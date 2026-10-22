import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describeComposition, needsOf, parseEnv, scanComposition } from '../composition';
import { recommendMode } from '../stack';
import { asksForTasks, tasksNote } from '../tasknote';
import { activeRun, beginRun, controlOf, emit, endRun, injectMessage, stopRun, updateRun } from '../chatruns';
import type { TaskRow } from '../db';

function write(root: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

test('a folder with several apps: each one, its ports, services and hidden secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-stack-'));
  write(root, 'api/artisan', '');
  write(root, 'api/composer.json', '{}');
  write(root, 'api/.env', 'APP_PORT=8001\nDB_CONNECTION=pgsql\nDB_HOST=127.0.0.1\nDB_PASSWORD=supersecret\nREDIS_HOST=127.0.0.1\n');
  write(root, 'site/package.json', JSON.stringify({ scripts: { dev: 'next dev -p 3001' }, dependencies: { next: '15', react: '19' } }));
  write(root, 'admin/package.json', JSON.stringify({ scripts: { dev: 'vite --port 3001' }, devDependencies: { vite: '6' }, dependencies: { react: '19' } }));
  write(root, 'admin/Dockerfile', 'FROM node:22\nEXPOSE 3001\n');
  write(root, 'compose.yaml', 'services:\n  postgres:\n    image: postgres:16\n    ports:\n      - "5432:5432"\n  redis:\n    image: redis\n');

  const c = scanComposition(root);
  const dirs = c.units.map((u) => u.dir).sort();
  assert.deepEqual(dirs, ['admin', 'api', 'site']);
  const api = c.units.find((u) => u.dir === 'api')!;
  assert.match(api.processes[0].command, /^cd api && php artisan serve/);
  assert.deepEqual(api.needs.sort(), ['postgres', 'redis']);
  assert.equal(api.env.entries.find((e) => e.key === 'DB_PASSWORD')?.value, '••• (set)');
  assert.ok(api.ports.some((p) => p.port === 8001));
  assert.ok(c.units.find((u) => u.dir === 'admin')!.docker.dockerfile);
  assert.deepEqual(c.compose[0].infra.map((s) => s.name), ['postgres', 'redis']);
  assert.equal(recommendMode(c), 'hybrid');
  const text = describeComposition(c);
  assert.ok(!text.includes('supersecret'), 'secrets never reach the model');
});

test('.env parsing and what an app needs', () => {
  assert.deepEqual(parseEnv('A=1\nexport B="two"\n# c\nC=x # note'), { A: '1', B: 'two', C: 'x' });
  assert.deepEqual(needsOf({ DATABASE_URL: 'mysql://u:p@h/db' }, ''), ['mysql']);
});

test('"do the remaining tasks" points the model at the task list', () => {
  assert.ok(asksForTasks('выполни оставшиеся'));
  assert.ok(asksForTasks('continue the tasks'));
  assert.ok(!asksForTasks('сделай кнопку синей'));
  const t = (id: number, title: string, status: TaskRow['status'], parent: number | null = null) => ({ id, title, status, parent_id: parent } as TaskRow);
  const note = tasksNote([t(1, 'Сайт', 'in_progress'), t(2, 'Шапка', 'done', 1), t(3, 'Подвал', 'todo', 1)], 'выполни оставшиеся');
  assert.match(note, /#3 \[todo\] Подвал/);
  assert.match(note, /THE USER ASKS FOR THESE TASKS/);
  assert.equal(tasksNote([], 'hello'), '');
});

test('a chat run: viewers get chunks, messages and switches reach the agent, stop aborts', () => {
  const seen: string[] = [];
  const run = beginRun({ chatId: 991, projectId: 1, messageId: 'm', prompt: 'p', model: 'a' }, new Set([(c: string) => seen.push(c)]));
  emit(run, JSON.stringify({ id: 'x', role: 'assistant', content: '1' }));
  emit(run, JSON.stringify({ id: 'x', role: 'assistant', content: '12' }));
  assert.equal(seen.length, 2);
  assert.equal(run.latest.size, 1, 'a later viewer gets the latest state, once');
  assert.ok(injectMessage(991, 'и добавь футер'));
  assert.ok(updateRun(991, { model: 'b', numCtx: 65536 }));
  const ctl = controlOf(run);
  assert.deepEqual(ctl.takeMessages(), ['и добавь футер']);
  assert.deepEqual(ctl.takeMessages(), []);
  assert.deepEqual(ctl.takeOverrides(), { model: 'b', numCtx: 65536 });
  assert.equal(ctl.takeOverrides(), null);
  assert.ok(stopRun(991));
  assert.ok(run.controller.signal.aborted);
  endRun(run);
  assert.equal(activeRun(991), undefined);
  assert.ok(!injectMessage(991, 'late'));
});

test('model roles: plans and audits go to the planner, work to the coder', async () => {
  const { roleFor, wantsExecution, applyRole } = await import('../roles');
  assert.equal(roleFor('создай задачи для лендинга'), 'planner');
  assert.equal(roleFor('сделай аудит проекта и исправь'), 'planner');
  assert.equal(roleFor('Audit the API'), 'planner');
  assert.equal(roleFor('исправь кнопку в шапке'), 'coder');
  assert.equal(roleFor('привет'), null);
  assert.ok(wantsExecution('сделай аудит и исправь'));
  assert.ok(!wantsExecution('сделай аудит'));
  const p = applyRole('planner', 'claude/sonnet', null, true);
  assert.equal(p.model, 'claude/sonnet');
  assert.equal(p.effort, 'high');
  assert.equal(applyRole('coder', 'claude/sonnet', null).effort, 'low');
});
