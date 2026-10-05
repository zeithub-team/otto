import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFromEnv, fromUrl } from '../dbdetect';
import { buildDdl } from '../dbadmin';

test('DATABASE_URL is parsed, container host names become localhost', () => {
  assert.deepEqual(fromUrl('postgres://app:p%40ss@db:5433/shop?sslmode=disable'), { kind: 'postgres', host: '127.0.0.1', port: 5433, user: 'app', password: 'p@ss', database: 'shop' });
  assert.equal(fromUrl('mysql://root@localhost/x')?.port, 3306);
  assert.equal(fromUrl('redis://x'), null);
});

test('Laravel DB_* and docker MYSQL_* are both found; duplicates are merged', () => {
  const found = detectFromEnv({ DB_CONNECTION: 'mysql', DB_HOST: 'mysql', DB_PORT: '3307', DB_DATABASE: 'app', DB_USERNAME: 'dev', DB_PASSWORD: 'secret', MYSQL_USER: 'dev', MYSQL_PASSWORD: 'secret', MYSQL_DATABASE: 'app', MYSQL_PORT: '3307' });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].conn, { kind: 'mysql', host: '127.0.0.1', port: 3307, user: 'dev', password: 'secret', database: 'app' });
  const pg = detectFromEnv({ POSTGRES_USER: 'u', POSTGRES_PASSWORD: 'p', POSTGRES_DB: 'd' });
  assert.equal(pg[0].conn.port, 5432);
  assert.deepEqual(detectFromEnv({ FOO: 'bar' }), []);
});

test('DDL is built from the catalog with keys and indexes', () => {
  const conn = { kind: 'postgres' as const, host: 'h', port: 1, user: 'u', password: '', database: '' };
  const ddl = buildDdl(conn, 'public', 'users', [
    { name: 'id', type: 'integer', nullable: false, default: null, primary: true },
    { name: 'email', type: 'text', nullable: false, default: null, primary: false },
  ], [{ name: 'users_email_key', columns: ['email'], unique: true, primary: false }], []);
  assert.match(ddl, /CREATE TABLE "public"."users"/);
  assert.match(ddl, /PRIMARY KEY \("id"\)/);
  assert.match(ddl, /CREATE UNIQUE INDEX "users_email_key" ON "public"."users" \("email"\)/);
});

import { locateProblem } from '../dbadmin';

test('SQL problems are placed where the database pointed', () => {
  const sql = 'select * form users';
  // PostgreSQL reports a 1-based offset into the EXPLAIN text ("EXPLAIN " is 8 characters)
  const pg = locateProblem('postgres', { message: 'ERROR: syntax error at or near "form"', position: '18' }, sql, 8);
  assert.equal(sql.slice(pg.from, pg.to), 'form');
  assert.match(pg.message, /^syntax error/);
  // MySQL quotes the text after the error and gives the line
  const my = locateProblem('mysql', { sqlMessage: "You have an error in your SQL syntax; check the manual ... near 'form users' at line 1" }, sql);
  assert.equal(sql.slice(my.from, my.from + 4), 'form');
  const two = locateProblem('mysql', { sqlMessage: "You have an error ... near 'whre id = 1' at line 2" }, 'select 1\nfrom t whre id = 1');
  assert.equal('select 1\nfrom t whre id = 1'.slice(two.from, two.from + 4), 'whre');
  // no position at all: still a usable, in-range answer
  const none = locateProblem('mysql', { sqlMessage: "Table 'x.y' doesn't exist" }, 'select * from y');
  assert.ok(none.from >= 0 && none.to <= 'select * from y'.length);
});
