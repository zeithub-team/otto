import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteAgent, listAgents, registerRun, stopAgent } from '../agents';

test('a task step registered with the Agents tab shows its log and result, and stopping it stops the task run', () => {
  let stopped = 0;
  const run = registerRun({ projectId: 7, title: 'Задача «Сайт» · этап 1: шапка', prompt: 'p', model: null, onStop: () => { stopped++; } });
  run.log('tool', 'write_file({"path":"a.txt"}) → File CREATED');
  run.setContent('ИТОГ: шапка готова');

  const [shown] = listAgents(7);
  assert.equal(shown.id, run.id);
  assert.equal(shown.source, 'task');
  assert.equal(shown.status, 'running');
  assert.equal(shown.content, 'ИТОГ: шапка готова');
  assert.ok(shown.log.some((l) => l.kind === 'tool' && /write_file/.test(l.text)));

  assert.equal(stopAgent(run.id), true);
  assert.equal(stopped, 1, 'the task run is told to stop');
  assert.equal(run.isStopped(), true);
  run.finish('stopped');
  assert.equal(listAgents(7)[0].status, 'stopped', 'a finished run keeps its final state');
  deleteAgent(run.id);
  assert.equal(listAgents(7).length, 0);
});

test('finishing a step: done keeps the answer, an error is logged and never overwritten by a later finish', () => {
  const ok = registerRun({ projectId: 8, title: 't', prompt: 'p', model: null });
  ok.finish('done');
  assert.equal(listAgents(8).find((r) => r.id === ok.id)?.status, 'done');

  const bad = registerRun({ projectId: 8, title: 't2', prompt: 'p', model: null });
  bad.finish('error', 'boom');
  bad.finish('done');
  const shown = listAgents(8).find((r) => r.id === bad.id)!;
  assert.equal(shown.status, 'error');
  assert.equal(shown.error, 'boom');
  deleteAgent(ok.id);
  deleteAgent(bad.id);
});
