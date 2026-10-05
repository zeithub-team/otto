/** `/api/dbx/*`: the DataGrip-style endpoints (structure, row editing, explain, detection). */

import type { DbConn } from './dbclient';
import { browseTable, checkSql, countRows, deleteRow, explainQuery, insertRow, listDatabases, tableStructure, updateRow } from './dbadmin';

export const DBX_ROUTES: ReadonlyArray<{ path: string; methods: string[] }> = [
  { path: '/api/dbx/detect', methods: ['GET'] },
  ...['databases', 'structure', 'explain', 'check', 'browse', 'count', 'update-row', 'insert-row', 'delete-row'].map((p) => ({ path: `/api/dbx/${p}`, methods: ['POST'] })),
];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function connFromBody(body: Record<string, unknown>): DbConn {
  const raw = obj(body.conn);
  return {
    kind: raw.kind === 'mysql' ? 'mysql' : 'postgres',
    host: str(raw.host) || '127.0.0.1',
    port: Number(raw.port),
    user: str(raw.user),
    password: str(raw.password),
    database: str(raw.database),
  };
}

export async function handleDbxRoute(pathname: string, body: Record<string, unknown>): Promise<{ payload: unknown } | undefined> {
  if (!pathname.startsWith('/api/dbx/')) return undefined;
  const conn = connFromBody(body);
  const schema = str(body.schema);
  const table = str(body.table);
  const reply = (payload: unknown) => ({ payload });
  switch (pathname.slice('/api/dbx/'.length)) {
    case 'databases':
      return reply({ databases: await listDatabases(conn) });
    case 'structure':
      return reply(await tableStructure(conn, schema, table));
    case 'explain':
      return reply(await explainQuery(conn, str(body.sql)));
    case 'check':
      return reply({ problem: await checkSql(conn, str(body.sql)) });
    case 'browse':
      return reply(await browseTable(conn, schema, table, {
        page: Number(body.page) || 0, pageSize: Number(body.page_size) || 100,
        where: str(body.where), orderBy: str(body.order_by) || undefined, desc: body.desc === true,
      }));
    case 'count':
      return reply({ count: await countRows(conn, schema, table, str(body.where)) });
    case 'update-row':
      return reply({ affected: await updateRow(conn, schema, table, obj(body.pk), obj(body.values)) });
    case 'insert-row':
      return reply({ affected: await insertRow(conn, schema, table, obj(body.values)) });
    case 'delete-row':
      return reply({ affected: await deleteRow(conn, schema, table, obj(body.pk)) });
    default:
      return undefined;
  }
}
