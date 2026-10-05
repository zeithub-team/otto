import test from 'node:test';
import assert from 'node:assert/strict';
import { checkConn, jsonSafe, quoteIdent, runQuery, type DbConn } from '../dbclient';

const conn: DbConn = { kind: 'postgres', host: '127.0.0.1', port: 5432, user: 'dev', password: 'x', database: 'app' };

test('identifiers are quoted per dialect, quotes inside are doubled', () => {
  assert.equal(quoteIdent('postgres', 'users'), '"users"');
  assert.equal(quoteIdent('postgres', 'we"ird'), '"we""ird"');
  assert.equal(quoteIdent('mysql', 'us`ers'), '`us``ers`');
});

test('only local hosts and sane ports are accepted', () => {
  assert.doesNotThrow(() => checkConn(conn));
  assert.doesNotThrow(() => checkConn({ ...conn, host: 'localhost', kind: 'mysql' }));
  assert.throws(() => checkConn({ ...conn, host: 'db.example.com' }), /local hosts/);
  assert.throws(() => checkConn({ ...conn, port: 0 }), /port/i);
});

test('driver values become JSON-safe', () => {
  assert.equal(jsonSafe(10n), '10');
  assert.equal(jsonSafe(new Date('2026-01-02T03:04:05Z')), '2026-01-02T03:04:05.000Z');
  assert.equal(jsonSafe(Buffer.from([1, 2, 255])), '\\x0102ff');
  assert.equal(jsonSafe(undefined), null);
  assert.deepEqual(jsonSafe({ a: 1n }), { a: '1' });
});

test('an unreachable database is reported as an error, not a hang', async () => {
  await assert.rejects(runQuery({ ...conn, port: 1 }, 'select 1'), /ECONNREFUSED|connect/i);
  await assert.rejects(runQuery({ ...conn, host: 'example.com' }, 'select 1'), /local hosts/);
});
