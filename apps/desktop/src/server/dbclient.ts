/**
 * Database client for the "Data" view: schema browser, table viewer and SQL
 * console for the databases the project runs in containers (PostgreSQL, MySQL,
 * MariaDB). Only local hosts are allowed, like the HTTP client in netclient.ts.
 */

import { Client as PgClient } from 'pg';
import * as mysql from 'mysql2/promise';
import { isLocalHost } from './netclient';

export type DbKind = 'postgres' | 'mysql';

export interface DbConn {
  kind: DbKind;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface DbResult {
  columns: string[];
  rows: unknown[][];
  /** Rows the statement returned (or affected, for INSERT/UPDATE/DELETE). */
  rowCount: number;
  truncated: boolean;
  ms: number;
}

export interface DbSchema {
  schema: string;
  tables: Array<{ name: string; type: string }>;
}

const MAX_ROWS = 500;
const CONNECT_TIMEOUT_MS = 5000;
const QUERY_TIMEOUT_MS = 30_000;

export function checkConn(conn: DbConn): void {
  if (conn.kind !== 'postgres' && conn.kind !== 'mysql') throw new Error(`Unsupported database kind: ${String(conn.kind)}`);
  if (!isLocalHost(conn.host)) throw new Error(`Only local hosts are allowed (localhost, 127.x, 10.x, 172.16–31.x, 192.168.x), not ${conn.host}`);
  if (!Number.isInteger(conn.port) || conn.port < 1 || conn.port > 65535) throw new Error('Invalid port');
}

/** Quote an identifier for the dialect (doubling the quote character). */
export function quoteIdent(kind: DbKind, name: string): string {
  const q = kind === 'postgres' ? '"' : '`';
  return q + String(name).split(q).join(q + q) + q;
}

/** Make a driver value safe to send as JSON. */
export function jsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value)) return `\\x${value.subarray(0, 64).toString('hex')}${value.length > 64 ? '…' : ''}`;
  if (typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    } catch {
      return String(value);
    }
  }
  return value;
}

async function withPg<T>(conn: DbConn, fn: (client: PgClient) => Promise<T>): Promise<T> {
  const client = new PgClient({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database || undefined,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function withMysql<T>(conn: DbConn, fn: (client: mysql.Connection) => Promise<T>): Promise<T> {
  const client = await mysql.createConnection({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database || undefined,
    connectTimeout: CONNECT_TIMEOUT_MS,
    rowsAsArray: true,
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Run one SQL statement (the console) or a generated query. */
export async function runQuery(conn: DbConn, sql: string): Promise<DbResult> {
  checkConn(conn);
  const text = String(sql ?? '').trim();
  if (!text) throw new Error('Empty query');
  const started = Date.now();

  if (conn.kind === 'postgres') {
    return withPg(conn, async (client) => {
      const raw = await client.query({ text, rowMode: 'array' });
      const result = Array.isArray(raw) ? raw[raw.length - 1] : raw; // several statements: show the last
      const columns = result.fields.map((f: { name: string }) => f.name);
      const rows = (result.rows as unknown[][]).slice(0, MAX_ROWS).map((row) => row.map(jsonSafe));
      const count = columns.length ? result.rows.length : (result.rowCount ?? 0);
      return { columns, rows, rowCount: count, truncated: result.rows.length > MAX_ROWS, ms: Date.now() - started };
    });
  }

  return withMysql(conn, async (client) => {
    const [data, fields] = await client.query({ sql: text, timeout: QUERY_TIMEOUT_MS, rowsAsArray: true });
    if (Array.isArray(data)) {
      const columns = Array.isArray(fields) ? (fields as Array<{ name: string }>).map((f) => f.name) : [];
      const all = data as unknown[][];
      const rows = all.slice(0, MAX_ROWS).map((row) => (Array.isArray(row) ? row.map(jsonSafe) : [jsonSafe(row)]));
      return { columns, rows, rowCount: all.length, truncated: all.length > MAX_ROWS, ms: Date.now() - started };
    }
    const header = data as { affectedRows?: number };
    return { columns: [], rows: [], rowCount: header.affectedRows ?? 0, truncated: false, ms: Date.now() - started };
  });
}

/** Databases' tables grouped by schema (PostgreSQL schema / MySQL database). */
export async function listSchema(conn: DbConn): Promise<DbSchema[]> {
  const sql =
    conn.kind === 'postgres'
      ? `select table_schema, table_name, table_type from information_schema.tables
         where table_schema not in ('pg_catalog', 'information_schema') and table_schema not like 'pg_toast%'
         order by 1, 2`
      : `select table_schema, table_name, table_type from information_schema.tables
         where table_schema not in ('information_schema', 'mysql', 'performance_schema', 'sys')
         order by 1, 2`;
  const result = await runQuery(conn, sql);
  const bySchema = new Map<string, DbSchema>();
  for (const row of result.rows) {
    const schema = String(row[0]);
    if (!bySchema.has(schema)) bySchema.set(schema, { schema, tables: [] });
    bySchema.get(schema)!.tables.push({ name: String(row[1]), type: /view/i.test(String(row[2])) ? 'view' : 'table' });
  }
  return [...bySchema.values()];
}

/** A page of rows of one table. */
export async function tableRows(conn: DbConn, schema: string, table: string, page = 0, pageSize = 100): Promise<DbResult> {
  const size = Math.min(Math.max(1, Math.floor(pageSize) || 100), MAX_ROWS);
  const offset = Math.max(0, Math.floor(page) || 0) * size;
  const target = `${quoteIdent(conn.kind, schema)}.${quoteIdent(conn.kind, table)}`;
  return runQuery(conn, `select * from ${target} limit ${size + 1} offset ${offset}`);
}
