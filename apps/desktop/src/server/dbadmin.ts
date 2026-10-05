/**
 * What the Data tab needs beyond "run a query" (the DataGrip-style parts): databases list, table structure
 * (columns, keys, indexes, foreign keys, DDL), EXPLAIN, and editing rows by primary key.
 * Values always travel as bind parameters, never inside the SQL text.
 */

import { Client as PgClient } from 'pg';
import * as mysql from 'mysql2/promise';
import { checkConn, jsonSafe, quoteIdent, runQuery, type DbConn, type DbResult } from './dbclient';

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  primary: boolean;
  comment?: string;
}
export interface IndexInfo { name: string; columns: string[]; unique: boolean; primary: boolean }
export interface ForeignKeyInfo { name: string; columns: string[]; refSchema: string; refTable: string; refColumns: string[] }
export interface TableStructure {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  ddl: string;
  /** Primary key columns: rows can be edited only when the table has one. */
  primaryKey: string[];
}

const lit = (v: string): string => `'${String(v).replace(/'/g, "''")}'`;
const rowsOf = (r: DbResult): unknown[][] => r.rows;

export async function listDatabases(conn: DbConn): Promise<string[]> {
  checkConn(conn);
  const r = conn.kind === 'postgres'
    ? await runQuery(conn, `select datname from pg_database where not datistemplate order by 1`)
    : await runQuery(conn, `select schema_name from information_schema.schemata where schema_name not in ('information_schema','mysql','performance_schema','sys') order by 1`);
  return rowsOf(r).map((row) => String(row[0]));
}

export async function tableStructure(conn: DbConn, schema: string, table: string): Promise<TableStructure> {
  checkConn(conn);
  const cols = conn.kind === 'postgres'
    ? await runQuery(conn, `
        select c.column_name, c.data_type || coalesce('(' || c.character_maximum_length || ')', ''), c.is_nullable = 'YES', c.column_default,
               exists (select 1 from information_schema.table_constraints tc join information_schema.key_column_usage k
                         on k.constraint_name = tc.constraint_name and k.table_schema = tc.table_schema
                        where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = c.table_schema and tc.table_name = c.table_name and k.column_name = c.column_name),
               col_description((quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass, c.ordinal_position)
          from information_schema.columns c where c.table_schema = ${lit(schema)} and c.table_name = ${lit(table)} order by c.ordinal_position`)
    : await runQuery(conn, `
        select column_name, column_type, is_nullable = 'YES', column_default, column_key = 'PRI', nullif(column_comment, '')
          from information_schema.columns where table_schema = ${lit(schema)} and table_name = ${lit(table)} order by ordinal_position`);
  const columns: ColumnInfo[] = rowsOf(cols).map((r) => ({
    name: String(r[0]), type: String(r[1]), nullable: r[2] === true || r[2] === 1 || r[2] === '1', default: r[3] == null ? null : String(r[3]),
    primary: r[4] === true || r[4] === 1 || r[4] === '1', comment: r[5] == null ? undefined : String(r[5]),
  }));

  const indexes: IndexInfo[] = [];
  if (conn.kind === 'postgres') {
    const r = await runQuery(conn, `
      select i.relname, array_agg(a.attname order by x.n), ix.indisunique, ix.indisprimary
        from pg_index ix join pg_class t on t.oid = ix.indrelid join pg_class i on i.oid = ix.indexrelid
        join pg_namespace ns on ns.oid = t.relnamespace
        join lateral unnest(ix.indkey) with ordinality as x(attnum, n) on true
        join pg_attribute a on a.attrelid = t.oid and a.attnum = x.attnum
       where ns.nspname = ${lit(schema)} and t.relname = ${lit(table)} group by i.relname, ix.indisunique, ix.indisprimary order by 1`);
    for (const row of rowsOf(r)) indexes.push({ name: String(row[0]), columns: Array.isArray(row[1]) ? (row[1] as unknown[]).map(String) : String(row[1]).replace(/[{}]/g, '').split(','), unique: row[2] === true, primary: row[3] === true });
  } else {
    const r = await runQuery(conn, `select index_name, column_name, non_unique from information_schema.statistics where table_schema = ${lit(schema)} and table_name = ${lit(table)} order by index_name, seq_in_index`);
    const by = new Map<string, IndexInfo>();
    for (const row of rowsOf(r)) {
      const name = String(row[0]);
      const cur = by.get(name) ?? { name, columns: [], unique: String(row[2]) === '0', primary: name === 'PRIMARY' };
      cur.columns.push(String(row[1]));
      by.set(name, cur);
    }
    indexes.push(...by.values());
  }

  const foreignKeys: ForeignKeyInfo[] = [];
  if (conn.kind === 'postgres') {
    const r = await runQuery(conn, `
      select c.conname, array(select a.attname from unnest(c.conkey) k join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k),
             rn.nspname, rt.relname, array(select a.attname from unnest(c.confkey) k join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k)
        from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace ns on ns.oid = t.relnamespace
        join pg_class rt on rt.oid = c.confrelid join pg_namespace rn on rn.oid = rt.relnamespace
       where c.contype = 'f' and ns.nspname = ${lit(schema)} and t.relname = ${lit(table)}`);
    for (const row of rowsOf(r)) foreignKeys.push({ name: String(row[0]), columns: (row[1] as unknown[]).map(String), refSchema: String(row[2]), refTable: String(row[3]), refColumns: (row[4] as unknown[]).map(String) });
  } else {
    const r = await runQuery(conn, `select constraint_name, column_name, referenced_table_schema, referenced_table_name, referenced_column_name from information_schema.key_column_usage where table_schema = ${lit(schema)} and table_name = ${lit(table)} and referenced_table_name is not null order by constraint_name, ordinal_position`);
    const by = new Map<string, ForeignKeyInfo>();
    for (const row of rowsOf(r)) {
      const name = String(row[0]);
      const cur = by.get(name) ?? { name, columns: [], refSchema: String(row[2]), refTable: String(row[3]), refColumns: [] };
      cur.columns.push(String(row[1]));
      cur.refColumns.push(String(row[4]));
      by.set(name, cur);
    }
    foreignKeys.push(...by.values());
  }

  return { columns, indexes, foreignKeys, ddl: buildDdl(conn, schema, table, columns, indexes, foreignKeys), primaryKey: columns.filter((c) => c.primary).map((c) => c.name) };
}

/** A readable CREATE TABLE built from the catalog (not byte-identical to the server's own, but runnable). */
export function buildDdl(conn: DbConn, schema: string, table: string, columns: ColumnInfo[], indexes: IndexInfo[], fks: ForeignKeyInfo[]): string {
  const q = (n: string): string => quoteIdent(conn.kind, n);
  const lines = columns.map((c) => `  ${q(c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default != null ? ` DEFAULT ${c.default}` : ''}`);
  const pk = columns.filter((c) => c.primary).map((c) => q(c.name));
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(', ')})`);
  for (const f of fks) lines.push(`  CONSTRAINT ${q(f.name)} FOREIGN KEY (${f.columns.map(q).join(', ')}) REFERENCES ${q(f.refSchema)}.${q(f.refTable)} (${f.refColumns.map(q).join(', ')})`);
  let sql = `CREATE TABLE ${q(schema)}.${q(table)} (\n${lines.join(',\n')}\n);`;
  for (const i of indexes.filter((x) => !x.primary)) sql += `\nCREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${q(schema)}.${q(table)} (${i.columns.map(q).join(', ')});`;
  return sql;
}

/** EXPLAIN without running the statement (plain EXPLAIN, never ANALYZE: it would execute writes). */
export async function explainQuery(conn: DbConn, sql: string): Promise<DbResult> {
  const text = sql.trim().replace(/;+\s*$/, '');
  if (!text) throw new Error('Empty query');
  return runQuery(conn, `EXPLAIN ${text}`);
}

// ---------------------------------------------------------------- row edits --

async function runWithParams(conn: DbConn, text: string, values: unknown[]): Promise<number> {
  checkConn(conn);
  if (conn.kind === 'postgres') {
    const client = new PgClient({ host: conn.host, port: conn.port, user: conn.user, password: conn.password, database: conn.database || undefined, connectionTimeoutMillis: 5000, statement_timeout: 30_000 });
    await client.connect();
    try {
      const r = await client.query(text, values);
      return r.rowCount ?? 0;
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  const client = await mysql.createConnection({ host: conn.host, port: conn.port, user: conn.user, password: conn.password, database: conn.database || undefined, connectTimeout: 5000 });
  try {
    const [res] = await client.execute(text, values.map((v) => (v === undefined ? null : v)) as never[]);
    return (res as { affectedRows?: number }).affectedRows ?? 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const ph = (kind: DbConn['kind'], i: number): string => (kind === 'postgres' ? `$${i}` : '?');
const target = (conn: DbConn, schema: string, table: string): string => `${quoteIdent(conn.kind, schema)}.${quoteIdent(conn.kind, table)}`;

function where(conn: DbConn, pk: Record<string, unknown>, start: number): { sql: string; values: unknown[] } {
  const keys = Object.keys(pk);
  if (!keys.length) throw new Error('The table has no primary key: rows cannot be edited safely');
  return { sql: keys.map((k, i) => (pk[k] === null ? `${quoteIdent(conn.kind, k)} IS NULL` : `${quoteIdent(conn.kind, k)} = ${ph(conn.kind, start + i)}`)).join(' AND '), values: keys.filter((k) => pk[k] !== null).map((k) => pk[k]) };
}

/** Empty strings from the grid mean NULL for nullable columns only when the caller sends null; text stays text. */
export async function updateRow(conn: DbConn, schema: string, table: string, pk: Record<string, unknown>, values: Record<string, unknown>): Promise<number> {
  const cols = Object.keys(values);
  if (!cols.length) throw new Error('Nothing to update');
  const set = cols.map((c, i) => `${quoteIdent(conn.kind, c)} = ${ph(conn.kind, i + 1)}`).join(', ');
  const w = where(conn, pk, cols.length + 1);
  const n = await runWithParams(conn, `UPDATE ${target(conn, schema, table)} SET ${set} WHERE ${w.sql}`, [...cols.map((c) => values[c]), ...w.values]);
  if (n !== 1) throw new Error(n === 0 ? 'No row matched — it may have been changed or deleted' : `${n} rows were changed (expected 1)`);
  return n;
}

export async function insertRow(conn: DbConn, schema: string, table: string, values: Record<string, unknown>): Promise<number> {
  const cols = Object.keys(values);
  const t = target(conn, schema, table);
  if (!cols.length) return runWithParams(conn, conn.kind === 'postgres' ? `INSERT INTO ${t} DEFAULT VALUES` : `INSERT INTO ${t} () VALUES ()`, []);
  return runWithParams(conn, `INSERT INTO ${t} (${cols.map((c) => quoteIdent(conn.kind, c)).join(', ')}) VALUES (${cols.map((_, i) => ph(conn.kind, i + 1)).join(', ')})`, cols.map((c) => values[c]));
}

export async function deleteRow(conn: DbConn, schema: string, table: string, pk: Record<string, unknown>): Promise<number> {
  const w = where(conn, pk, 1);
  const n = await runWithParams(conn, `DELETE FROM ${target(conn, schema, table)} WHERE ${w.sql}`, w.values);
  if (n !== 1) throw new Error(n === 0 ? 'No row matched — it may have been changed or deleted' : `${n} rows matched (expected 1) — nothing was guaranteed`);
  return n;
}

/** A page of rows with an optional filter (a WHERE expression typed by the user) and sort. */
export async function browseTable(
  conn: DbConn, schema: string, table: string,
  opts: { page: number; pageSize: number; where?: string; orderBy?: string; desc?: boolean },
): Promise<DbResult> {
  const size = Math.min(Math.max(1, Math.floor(opts.pageSize) || 100), 500);
  const offset = Math.max(0, Math.floor(opts.page) || 0) * size;
  const filter = (opts.where ?? '').trim();
  if (/;/.test(filter)) throw new Error('The filter must be a single expression without ";"');
  const order = opts.orderBy ? ` ORDER BY ${quoteIdent(conn.kind, opts.orderBy)} ${opts.desc ? 'DESC' : 'ASC'}` : '';
  return runQuery(conn, `SELECT * FROM ${target(conn, schema, table)}${filter ? ` WHERE ${filter}` : ''}${order} LIMIT ${size + 1} OFFSET ${offset}`);
}

export async function countRows(conn: DbConn, schema: string, table: string, where = ''): Promise<number> {
  if (/;/.test(where)) throw new Error('The filter must be a single expression without ";"');
  const r = await runQuery(conn, `SELECT COUNT(*) FROM ${target(conn, schema, table)}${where.trim() ? ` WHERE ${where.trim()}` : ''}`);
  return Number(jsonSafe(r.rows[0]?.[0]) ?? 0);
}

// ------------------------------------------------------------------ linting --

export interface SqlProblem { message: string; /** offsets into the checked statement */ from: number; to: number }

/** The statement kinds EXPLAIN understands; anything else (DDL, SET, SHOW…) is not checked. */
const EXPLAINABLE = /^\s*(select|insert|update|delete|replace|with)\b/i;

/** Turn a driver error into a position in `sql` (PostgreSQL gives an offset, MySQL a line and a "near" excerpt). */
export function locateProblem(kind: DbConn['kind'], err: { message?: string; sqlMessage?: string; position?: string | number }, sql: string, prefixLength = 0): SqlProblem {
  const message = String(err.sqlMessage ?? err.message ?? 'Syntax error').replace(/^ERROR:\s*/i, '');
  const end = (from: number): number => {
    const m = /^[\w$."`]+|^\s*\S/.exec(sql.slice(from));
    return Math.min(sql.length, from + (m ? m[0].trimEnd().length || 1 : 1));
  };
  if (kind === 'postgres' && err.position !== undefined) {
    const from = Math.max(0, Math.min(sql.length, Number(err.position) - 1 - prefixLength));
    return { message, from, to: end(from) };
  }
  const near = /near '([^']*)'/.exec(message)?.[1];
  const line = Number(/at line (\d+)/.exec(message)?.[1]);
  if (near) {
    const lines = sql.split('\n');
    const lineStart = Number.isFinite(line) && line > 0 ? lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) : 0;
    const idx = sql.indexOf(near.split('\n')[0], lineStart);
    if (idx >= 0) return { message, from: idx, to: Math.min(sql.length, idx + Math.max(1, near.split('\n')[0].length)) };
  }
  return { message, from: 0, to: Math.min(sql.length, 1) };
}

/** Ask the database itself whether the statement parses and its tables/columns exist (EXPLAIN never runs it). Null when fine. */
export async function checkSql(conn: DbConn, sql: string): Promise<SqlProblem | null> {
  checkConn(conn);
  const text = sql.trim().replace(/;+\s*$/, '');
  if (!text || !EXPLAINABLE.test(text)) return null;
  const lead = sql.indexOf(text);
  const prefix = 'EXPLAIN ';
  try {
    if (conn.kind === 'postgres') {
      const client = new PgClient({ host: conn.host, port: conn.port, user: conn.user, password: conn.password, database: conn.database || undefined, connectionTimeoutMillis: 5000, statement_timeout: 8000 });
      await client.connect();
      try { await client.query(prefix + text); } finally { await client.end().catch(() => undefined); }
    } else {
      const client = await mysql.createConnection({ host: conn.host, port: conn.port, user: conn.user, password: conn.password, database: conn.database || undefined, connectTimeout: 5000 });
      try { await client.query(prefix + text); } finally { await client.end().catch(() => undefined); }
    }
    return null;
  } catch (exc) {
    const err = exc as { message?: string; sqlMessage?: string; position?: string | number; code?: string };
    // connection trouble is not a problem with the SQL
    if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|Access denied|password authentication/i.test(String(err.message ?? '') + String(err.code ?? ''))) return null;
    const p = locateProblem(conn.kind, err, text, prefix.length);
    return { ...p, from: p.from + Math.max(0, lead), to: p.to + Math.max(0, lead) };
  }
}
