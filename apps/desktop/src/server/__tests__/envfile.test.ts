import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyEnvUpdates, envStatus, formatEnvValue, parseEnv, servicesToEnv, syncEnvFile } from '../envfile';

const SAMPLE = '# App\nAPP_NAME=Laravel\nDB_HOST=127.0.0.1\nDB_PORT=3306\n# DB_PORT=1111\nDB_PASSWORD="old pass"\nexport EXTRA=1\n';

test('values are patched in place; comments, order and other keys stay untouched', () => {
  const { text, changed } = applyEnvUpdates(SAMPLE, { DB_PORT: '3307', DB_PASSWORD: 'new pass', APP_NAME: 'Laravel' });
  assert.equal(text, '# App\nAPP_NAME=Laravel\nDB_HOST=127.0.0.1\nDB_PORT=3307\n# DB_PORT=1111\nDB_PASSWORD="new pass"\nexport EXTRA=1\n');
  assert.deepEqual(changed, [{ key: 'DB_PORT', from: '3306', to: '3307' }, { key: 'DB_PASSWORD', from: 'old pass', to: 'new pass' }]);
});

test('unchanged values change nothing; missing keys are appended once under a marker', () => {
  assert.deepEqual(applyEnvUpdates(SAMPLE, { DB_HOST: '127.0.0.1' }).changed, []);
  const { text, changed } = applyEnvUpdates(SAMPLE, { REDIS_HOST: '127.0.0.1', REDIS_PORT: '6379' });
  assert.deepEqual(changed.map((c) => c.key), ['REDIS_HOST', 'REDIS_PORT']);
  assert.match(text, /# Added by zeithub\.otto[\s\S]*REDIS_HOST=127\.0\.0\.1\nREDIS_PORT=6379\n$/);
  assert.equal(applyEnvUpdates(text, { REDIS_HOST: '127.0.0.1', REDIS_PORT: '6379' }).changed.length, 0, 'second run is a no-op');
});

test('CRLF files stay CRLF, empty files get the keys', () => {
  const crlf = applyEnvUpdates('A=1\r\nB=2\r\n', { B: '3' }).text;
  assert.equal(crlf, 'A=1\r\nB=3\r\n');
  assert.equal(applyEnvUpdates('', { A: '1' }).text.includes('A=1'), true);
});

test('values with spaces / # / quotes / $ are quoted so they read back the same', () => {
  for (const value of ['plain-value_1', 'has space', 'a#b', 'q"uote', 'dollar$x', 'p@ss:w/rd', '']) {
    const written = applyEnvUpdates('K=old\n', { K: value }).text;
    assert.equal(parseEnv(written).K, value, `round trip of ${JSON.stringify(value)}`);
  }
  assert.equal(formatEnvValue('abc'), 'abc');
});

test('syncEnvFile creates .env from the example, then only changes what differs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-env-'));
  fs.writeFileSync(path.join(root, '.env.example'), 'APP_KEY=\nDB_HOST=localhost\nDB_PORT=3306\n');
  assert.deepEqual(envStatus(root), { hasEnv: false, example: '.env.example', missing: [] });

  const first = syncEnvFile(root, { DB_HOST: '127.0.0.1', DB_PORT: '3307' });
  assert.equal(first.created, true);
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'APP_KEY=\nDB_HOST=127.0.0.1\nDB_PORT=3307\n');

  fs.appendFileSync(path.join(root, '.env'), 'MY_OWN=keep\n');
  const again = syncEnvFile(root, { DB_HOST: '127.0.0.1', DB_PORT: '3307' });
  assert.deepEqual(again, { path: '.env', created: false, changed: [] });
  assert.match(fs.readFileSync(path.join(root, '.env'), 'utf8'), /MY_OWN=keep/);

  // create:false never makes a file
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-env-'));
  assert.equal(syncEnvFile(empty, { A: '1' }, { create: false }).created, false);
  assert.equal(fs.existsSync(path.join(empty, '.env')), false);
});

test('services → .env values (Laravel keys + URLs, published ports, first DB is primary)', () => {
  const env = servicesToEnv([
    { key: 'mariadb', name: 'mariadb', ports: [{ host: 3307 }], env: { MARIADB_USER: 'dev', MARIADB_PASSWORD: 'p@ss w', MARIADB_DATABASE: 'app', MARIADB_ROOT_PASSWORD: 'root' } },
    { key: 'postgres', ports: [{ host: 5432 }], env: { POSTGRES_USER: 'x', POSTGRES_PASSWORD: 'y', POSTGRES_DB: 'z' } },
    { key: 'redis', ports: [{ host: 6380 }], env: { REDIS_PASSWORD: 'rp' } },
    { key: 'rabbitmq', ports: [{ host: 5672 }, { host: 15672, label: 'management' }], env: { RABBITMQ_DEFAULT_USER: 'dev', RABBITMQ_DEFAULT_PASS: 'rq' } },
    { key: 'elasticsearch', ports: [{ host: 9200 }] },
    { key: 'soketi', ports: [{ host: 6001 }, { host: 9601, label: 'metrics' }], env: { SOKETI_DEFAULT_APP_SECRET: 'sec' } },
  ]);
  assert.equal(env.DB_CONNECTION, 'mariadb');
  assert.equal(env.DB_PORT, '3307');
  assert.equal(env.DB_USERNAME, 'dev');
  assert.equal(env.DB_PASSWORD, 'p@ss w');
  assert.equal(env.DATABASE_URL, 'mysql://dev:p%40ss%20w@127.0.0.1:3307/app');
  assert.equal(env.REDIS_PORT, '6380');
  assert.equal(env.REDIS_URL, 'redis://:rp@127.0.0.1:6380');
  assert.equal(env.AMQP_URL, 'amqp://dev:rq@127.0.0.1:5672');
  assert.equal(env.RABBITMQ_MANAGEMENT_URL, 'http://127.0.0.1:15672');
  assert.equal(env.ELASTICSEARCH_HOST, 'http://127.0.0.1:9200');
  assert.equal(env.PUSHER_PORT, '6001');
  assert.equal(env.PUSHER_APP_SECRET, 'sec');
  assert.deepEqual(servicesToEnv([]), {});
  assert.equal(servicesToEnv([{ key: 'postgres', ports: [{ host: 5433 }], env: { POSTGRES_USER: 'u', POSTGRES_PASSWORD: 'p', POSTGRES_DB: 'd' } }]).DB_CONNECTION, 'pgsql');
});

test('missing keys of the example are reported', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-env-'));
  fs.writeFileSync(path.join(root, 'env.example'), 'A=1\nB=2\nC=3\n');
  fs.writeFileSync(path.join(root, '.env'), 'A=1\n');
  assert.deepEqual(envStatus(root), { hasEnv: true, example: 'env.example', missing: ['B', 'C'] });
});
