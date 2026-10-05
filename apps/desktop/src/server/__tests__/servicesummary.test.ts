import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeServiceNames, summarize } from '../servicesummary';

const yaml = `services:
  mariadb:
    image: mariadb:11
    ports:
      - "127.0.0.1:3307:3306"
  postgresql:
    image: postgres:17
  redis:
    image: redis:7

volumes:
  mariadb_data:
`;

test('service names come from the services section only', () => {
  assert.deepEqual(composeServiceNames(yaml), ['mariadb', 'postgresql', 'redis']);
});

test('each project counts the containers started in its folder, plus declared services without one', () => {
  const projects = [{ id: 1, path: 'C:\\Code\\auto-plus' }, { id: 2, path: 'C:\\Code\\momcare' }, { id: 3, path: 'C:\\Code\\empty' }];
  const ps = [
    'running|C:\\Code\\auto-plus|postgresql',
    'running|c:\\code\\auto-plus\\|mariadb',
    'exited|C:\\Code\\momcare|postgres',
    'running|C:\\Code\\other|web',
    'exited||lonely',
  ];
  const out = summarize(projects, ps, (dir) => (dir.endsWith('auto-plus') ? yaml : null));
  assert.equal(out[1].running, 2);
  assert.equal(out[1].total, 3, 'redis is declared but has no container');
  assert.deepEqual(out[1].services.find((s) => s.name === 'redis'), { name: 'redis', state: 'stopped' });
  assert.deepEqual([out[2].running, out[2].total], [0, 1]);
  assert.deepEqual([out[3].running, out[3].total], [0, 0]);
});
