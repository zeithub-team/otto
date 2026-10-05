/**
 * Finds the database a project talks to, so the Data tab connects by itself:
 * reads `.env` (and `.env.local`) and understands DATABASE_URL, Laravel-style DB_*,
 * and the POSTGRES_* / MYSQL_* / MARIADB_* names docker images use.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from './envfile';
import type { DbConn, DbKind } from './dbclient';

export interface DetectedConn {
  label: string;
  /** Which variables it came from, for the UI to show. */
  source: string;
  conn: DbConn;
}

const DEFAULT_PORT: Record<DbKind, number> = { postgres: 5432, mysql: 3306 };

function kindOf(name: string): DbKind | null {
  const n = name.toLowerCase();
  if (/^(postgres|postgresql|pgsql|pg)$/.test(n) || n.startsWith('postgres')) return 'postgres';
  if (/^(mysql|mariadb)$/.test(n) || n.startsWith('mysql') || n.startsWith('maria')) return 'mysql';
  return null;
}

/** Container names ("db", "mysql") mean nothing on the host: the published port is on localhost. */
function hostFor(raw: string | undefined): string {
  const h = (raw ?? '').trim();
  return !h || !/^(localhost|127\.|\[?::1\]?$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) ? '127.0.0.1' : h;
}

export function fromUrl(url: string): DbConn | null {
  const m = /^(postgres(?:ql)?|mysql|mariadb):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?#]*)(?::(\d+))?(?:\/([^?#]*))?/i.exec(url.trim());
  if (!m) return null;
  const kind = kindOf(m[1])!;
  const dec = (s?: string): string => { try { return decodeURIComponent(s ?? ''); } catch { return s ?? ''; } };
  return {
    kind,
    host: hostFor(m[4]),
    port: m[5] ? Number(m[5]) : DEFAULT_PORT[kind],
    user: dec(m[2]),
    password: dec(m[3]),
    database: dec(m[6]),
  };
}

export function detectFromEnv(env: Record<string, string>): DetectedConn[] {
  const out: DetectedConn[] = [];
  const add = (source: string, conn: DbConn | null): void => {
    if (!conn || !conn.user) return;
    if (out.some((x) => x.conn.kind === conn.kind && x.conn.port === conn.port && x.conn.user === conn.user && x.conn.database === conn.database)) return;
    out.push({ label: conn.database ? `${conn.database} (${conn.kind === 'postgres' ? 'PostgreSQL' : 'MySQL'} :${conn.port})` : `${conn.kind} :${conn.port}`, source, conn });
  };

  for (const key of ['DATABASE_URL', 'DB_URL', 'DATABASE_URI', 'SQLALCHEMY_DATABASE_URI']) {
    if (env[key]) add(key, fromUrl(env[key].replace(/^(\w+)\+\w+:\/\//, '$1://')));
  }

  // Laravel / Symfony-ish: DB_CONNECTION + DB_HOST …
  if (env.DB_HOST || env.DB_DATABASE || env.DB_USERNAME) {
    const kind = kindOf(env.DB_CONNECTION ?? env.DB_TYPE ?? env.DB_DRIVER ?? '') ?? (env.DB_PORT === '5432' ? 'postgres' : 'mysql');
    add('DB_*', {
      kind,
      host: hostFor(env.DB_HOST),
      port: Number(env.DB_PORT) || DEFAULT_PORT[kind],
      user: env.DB_USERNAME ?? env.DB_USER ?? '',
      password: env.DB_PASSWORD ?? env.DB_PASS ?? '',
      database: env.DB_DATABASE ?? env.DB_NAME ?? '',
    });
  }

  if (env.POSTGRES_USER || env.POSTGRES_DB) {
    add('POSTGRES_*', { kind: 'postgres', host: hostFor(env.POSTGRES_HOST), port: Number(env.POSTGRES_PORT) || 5432, user: env.POSTGRES_USER ?? 'postgres', password: env.POSTGRES_PASSWORD ?? '', database: env.POSTGRES_DB ?? '' });
  }
  for (const p of ['MYSQL', 'MARIADB']) {
    if (env[`${p}_USER`] || env[`${p}_DATABASE`] || env[`${p}_ROOT_PASSWORD`]) {
      const user = env[`${p}_USER`] ?? 'root';
      add(`${p}_*`, {
        kind: 'mysql',
        host: hostFor(env[`${p}_HOST`]),
        port: Number(env[`${p}_PORT`]) || 3306,
        user,
        password: env[`${p}_PASSWORD`] ?? (user === 'root' ? env[`${p}_ROOT_PASSWORD`] : '') ?? '',
        database: env[`${p}_DATABASE`] ?? '',
      });
    }
  }
  return out;
}

/** Everything the project's env files say about databases. */
export function detectProjectDatabases(root: string): DetectedConn[] {
  const merged: Record<string, string> = {};
  for (const name of ['.env.example', '.env', '.env.local']) {
    try {
      Object.assign(merged, parseEnv(fs.readFileSync(path.join(root, name), 'utf8')));
    } catch {
      /* the file does not exist */
    }
  }
  return detectFromEnv(merged);
}
