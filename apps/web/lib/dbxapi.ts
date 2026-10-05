import { API_BASE, type DbConn, type DbResult } from './api';

export interface ColumnInfo { name: string; type: string; nullable: boolean; default: string | null; primary: boolean; comment?: string }
export interface IndexInfo { name: string; columns: string[]; unique: boolean; primary: boolean }
export interface ForeignKeyInfo { name: string; columns: string[]; refSchema: string; refTable: string; refColumns: string[] }
export interface TableStructure { columns: ColumnInfo[]; indexes: IndexInfo[]; foreignKeys: ForeignKeyInfo[]; ddl: string; primaryKey: string[] }
export interface DetectedConn { label: string; source: string; conn: DbConn }

async function post<T>(action: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}/api/dbx/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : typeof data?.detail === 'string' ? data.detail : `HTTP ${res.status}`);
  return data as T;
}

export async function detectDatabases(projectId: number): Promise<DetectedConn[]> {
  try {
    const res = await fetch(`${API_BASE}/api/dbx/detect?project_id=${projectId}`);
    if (!res.ok) return [];
    return ((await res.json()) as { connections: DetectedConn[] }).connections ?? [];
  } catch {
    return [];
  }
}

export const dbxDatabases = (conn: DbConn) => post<{ databases: string[] }>('databases', { conn }).then((r) => r.databases);
export const dbxStructure = (conn: DbConn, schema: string, table: string) => post<TableStructure>('structure', { conn, schema, table });
export const dbxExplain = (conn: DbConn, sql: string) => post<DbResult>('explain', { conn, sql });
export const dbxBrowse = (conn: DbConn, schema: string, table: string, o: { page: number; pageSize: number; where?: string; orderBy?: string; desc?: boolean }) =>
  post<DbResult>('browse', { conn, schema, table, page: o.page, page_size: o.pageSize, where: o.where ?? '', order_by: o.orderBy, desc: o.desc });
export const dbxCount = (conn: DbConn, schema: string, table: string, where = '') => post<{ count: number }>('count', { conn, schema, table, where }).then((r) => r.count);
export const dbxUpdateRow = (conn: DbConn, schema: string, table: string, pk: Record<string, unknown>, values: Record<string, unknown>) => post<{ affected: number }>('update-row', { conn, schema, table, pk, values });
export const dbxInsertRow = (conn: DbConn, schema: string, table: string, values: Record<string, unknown>) => post<{ affected: number }>('insert-row', { conn, schema, table, values });
export const dbxDeleteRow = (conn: DbConn, schema: string, table: string, pk: Record<string, unknown>) => post<{ affected: number }>('delete-row', { conn, schema, table, pk });

// ------------------------------------------------------------- saved sets --

export interface SavedConn { id: string; name: string; conn: DbConn }
const SAVED_KEY = 'otto-db-saved';

export function loadSaved(): SavedConn[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(SAVED_KEY) || '[]') as unknown;
    return Array.isArray(v) ? (v as SavedConn[]) : [];
  } catch {
    return [];
  }
}
export function storeSaved(list: SavedConn[]): void {
  try { window.localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch { /* storage blocked */ }
}

const HISTORY_KEY = 'otto-db-history';
export function loadHistory(): string[] {
  try { const v = JSON.parse(window.localStorage.getItem(HISTORY_KEY) || '[]') as unknown; return Array.isArray(v) ? (v as string[]) : []; } catch { return []; }
}
export function pushHistory(sql: string): string[] {
  const next = [sql, ...loadHistory().filter((x) => x !== sql)].slice(0, 50);
  try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
  return next;
}

// ------------------------------------------------------------------ export --

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(r: DbResult): string {
  return [r.columns.map(csvCell).join(','), ...r.rows.map((row) => row.map(csvCell).join(','))].join('\r\n');
}

export function toJson(r: DbResult): string {
  return JSON.stringify(r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))), null, 2);
}

export function download(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The statement under the cursor: text between semicolons (outside quotes), or the selection. */
export function statementAt(text: string, from: number, to: number): string {
  if (to > from) return text.slice(from, to).trim();
  const bounds: number[] = [-1];
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === ';') bounds.push(i);
  }
  bounds.push(text.length);
  for (let i = 0; i < bounds.length - 1; i++) {
    if (from > bounds[i] && from <= bounds[i + 1]) return text.slice(bounds[i] + 1, bounds[i + 1]).trim();
  }
  return text.trim();
}

export interface SqlProblem { message: string; from: number; to: number }
export const dbxCheck = (conn: DbConn, sql: string) => post<{ problem: SqlProblem | null }>('check', { conn, sql }).then((r) => r.problem);

/** The statements of a script with their positions (split on `;` outside quotes; blank ones are skipped). */
export function splitStatements(text: string): Array<{ from: number; to: number; text: string }> {
  const out: Array<{ from: number; to: number; text: string }> = [];
  let start = 0;
  let quote = '';
  const push = (end: number) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (body) out.push({ from: start + lead, to: start + lead + body.length, text: body });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === ';') { push(i); start = i + 1; }
  }
  push(text.length);
  return out;
}
