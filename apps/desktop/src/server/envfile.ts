/**
 * `.env` handling: patch the values of known keys in place (comments, order and every other
 * line stay as they are), append missing ones, and create `.env` from `.env.example`.
 * Used to keep the project's `.env` in step with the services the project runs.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface EnvChange { key: string; from: string | null; to: string }

const EXAMPLE_NAMES = ['.env.example', 'env.example', '.env.sample', '.env.dist', '.env.template'];
const KEY_LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.]*)(\s*=\s*)(.*)$/;

/** Value as written in a .env file: quoted when it would not survive as a bare word. */
export function formatEnvValue(value: string): string {
  if (value === '') return '';
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
}

/** Value of a `KEY=value` line without quotes and inline comment. */
export function readEnvValue(raw: string): string {
  const v = raw.trim();
  const quoted = /^(["'])(.*)\1\s*(?:#.*)?$/.exec(v);
  if (quoted) return quoted[1] === '"' ? quoted[2].replace(/\\(["\\$])/g, '$1') : quoted[2];
  return v.replace(/\s+#.*$/, '');
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = KEY_LINE.exec(line);
    if (m) out[m[2]] = readEnvValue(m[4]);
  }
  return out;
}

/**
 * Set `updates` in `text`. Existing keys keep their line (only the value changes); keys that
 * are not there are appended. Returns the new text and what actually changed.
 */
export function applyEnvUpdates(text: string, updates: Record<string, string>): { text: string; changed: EnvChange[] } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  const changed: EnvChange[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i])) continue;
    const m = KEY_LINE.exec(lines[i]);
    if (!m || !(m[2] in updates) || seen.has(m[2])) continue;
    seen.add(m[2]);
    const from = readEnvValue(m[4]);
    const to = updates[m[2]];
    if (from === to) continue;
    lines[i] = `${m[1]}${m[2]}${m[3]}${formatEnvValue(to)}`;
    changed.push({ key: m[2], from, to });
  }

  const missing = Object.keys(updates).filter((k) => !seen.has(k));
  if (missing.length) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (lines.length) lines.push('');
    lines.push('# Added by zeithub.otto from the project services');
    for (const key of missing) {
      lines.push(`${key}=${formatEnvValue(updates[key])}`);
      changed.push({ key, from: null, to: updates[key] });
    }
    lines.push('');
  }
  return { text: lines.join(eol), changed };
}

/** The template the project ships (`.env.example` and friends), if any. */
export function findEnvExample(root: string): string | null {
  return EXAMPLE_NAMES.find((n) => fs.existsSync(path.join(root, n))) ?? null;
}

export interface EnvStatus {
  hasEnv: boolean;
  example: string | null;
  /** Keys of the example that `.env` does not have. */
  missing: string[];
}

export function envStatus(root: string): EnvStatus {
  const envPath = path.join(root, '.env');
  const example = findEnvExample(root);
  const hasEnv = fs.existsSync(envPath);
  let missing: string[] = [];
  if (hasEnv && example) {
    const have = parseEnv(fs.readFileSync(envPath, 'utf8'));
    missing = Object.keys(parseEnv(fs.readFileSync(path.join(root, example), 'utf8'))).filter((k) => !(k in have));
  }
  return { hasEnv, example, missing };
}

// ------------------------------------------------ services → .env values --

/** A service of the project as the Services tab stores it. */
export interface ServiceInstance {
  key: string;
  name?: string;
  ports?: Array<{ host: number; container?: number; label?: string }>;
  env?: Record<string, string>;
}

/**
 * `.env` values for the project's services (the first database is the primary connection).
 * Laravel-style keys (DB_*, REDIS_*, PUSHER_*) plus URLs that other stacks read
 * (DATABASE_URL, REDIS_URL, MONGODB_URI, AMQP_URL…). Connects to the published ports on 127.0.0.1.
 */
export function servicesToEnv(instances: ServiceInstance[]): Record<string, string> {
  const out: Record<string, string> = {};
  const host = '127.0.0.1';
  const first = (...keys: string[]): ServiceInstance | undefined => instances.find((i) => keys.includes(i.key));
  const port = (i: ServiceInstance, label?: string): number | undefined => (label ? i.ports?.find((p) => p.label === label) : i.ports?.[0])?.host;
  const enc = encodeURIComponent;

  const db = first('postgres', 'mysql', 'mariadb');
  if (db && port(db)) {
    const e = db.env ?? {};
    const pg = db.key === 'postgres';
    const prefix = db.key === 'mysql' ? 'MYSQL' : 'MARIADB';
    const user = pg ? e.POSTGRES_USER ?? 'postgres' : e[`${prefix}_USER`] ?? 'root';
    const pass = pg ? e.POSTGRES_PASSWORD ?? '' : e[`${prefix}_PASSWORD`] ?? e[`${prefix}_ROOT_PASSWORD`] ?? '';
    const name = pg ? e.POSTGRES_DB ?? '' : e[`${prefix}_DATABASE`] ?? '';
    Object.assign(out, {
      DB_CONNECTION: pg ? 'pgsql' : db.key,
      DB_HOST: host, DB_PORT: String(port(db)), DB_DATABASE: name, DB_USERNAME: user, DB_PASSWORD: pass,
      DATABASE_URL: `${pg ? 'postgresql' : 'mysql'}://${enc(user)}:${enc(pass)}@${host}:${port(db)}/${enc(name)}`,
    });
  }

  const redis = first('redis');
  if (redis && port(redis)) {
    const pass = redis.env?.REDIS_PASSWORD ?? '';
    Object.assign(out, {
      REDIS_HOST: host, REDIS_PORT: String(port(redis)), REDIS_PASSWORD: pass || 'null',
      REDIS_URL: `redis://${pass ? `:${enc(pass)}@` : ''}${host}:${port(redis)}`,
    });
  }

  const mongo = first('mongodb');
  if (mongo && port(mongo)) {
    const user = mongo.env?.MONGO_INITDB_ROOT_USERNAME;
    const pass = mongo.env?.MONGO_INITDB_ROOT_PASSWORD ?? '';
    out.MONGODB_URI = `mongodb://${user ? `${enc(user)}:${enc(pass)}@` : ''}${host}:${port(mongo)}/${user ? '?authSource=admin' : ''}`;
  }

  const rabbit = first('rabbitmq');
  if (rabbit && port(rabbit)) {
    const user = rabbit.env?.RABBITMQ_DEFAULT_USER ?? 'guest';
    const pass = rabbit.env?.RABBITMQ_DEFAULT_PASS ?? 'guest';
    Object.assign(out, {
      RABBITMQ_HOST: host, RABBITMQ_PORT: String(port(rabbit)), RABBITMQ_USER: user, RABBITMQ_PASSWORD: pass,
      AMQP_URL: `amqp://${enc(user)}:${enc(pass)}@${host}:${port(rabbit)}`,
    });
    const management = port(rabbit, 'management');
    if (management) out.RABBITMQ_MANAGEMENT_URL = `http://${host}:${management}`;
  }

  const elastic = first('elasticsearch');
  if (elastic && port(elastic)) {
    out.ELASTICSEARCH_HOST = `http://${host}:${port(elastic)}`;
    out.ELASTICSEARCH_URL = out.ELASTICSEARCH_HOST;
  }

  const soketi = first('soketi');
  if (soketi && port(soketi)) {
    const e = soketi.env ?? {};
    Object.assign(out, {
      PUSHER_APP_ID: e.SOKETI_DEFAULT_APP_ID ?? 'app-id', PUSHER_APP_KEY: e.SOKETI_DEFAULT_APP_KEY ?? 'app-key',
      PUSHER_APP_SECRET: e.SOKETI_DEFAULT_APP_SECRET ?? '', PUSHER_HOST: host, PUSHER_PORT: String(port(soketi)),
      PUSHER_SCHEME: 'http', PUSHER_APP_CLUSTER: 'mt1',
    });
  }

  const centrifugo = first('centrifugo');
  if (centrifugo && port(centrifugo)) {
    const e = centrifugo.env ?? {};
    Object.assign(out, {
      CENTRIFUGO_URL: `ws://${host}:${port(centrifugo)}/connection/websocket`,
      CENTRIFUGO_API_URL: `http://${host}:${port(centrifugo)}/api`,
      CENTRIFUGO_API_KEY: e.CENTRIFUGO_HTTP_API_KEY ?? '',
      CENTRIFUGO_TOKEN_SECRET: e.CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY ?? '',
    });
  }
  return out;
}

export interface EnvSyncResult { path: string; created: boolean; changed: EnvChange[] }

/**
 * Bring `.env` up to date: create it from the example when it does not exist, then apply the
 * service values. Nothing is written when nothing changes.
 */
export function syncEnvFile(root: string, updates: Record<string, string>, opts: { create?: boolean } = {}): EnvSyncResult {
  const envPath = path.join(root, '.env');
  let created = false;
  let text = '';
  if (fs.existsSync(envPath)) {
    text = fs.readFileSync(envPath, 'utf8');
  } else {
    if (opts.create === false) return { path: '.env', created: false, changed: [] };
    const example = findEnvExample(root);
    // a BOM in the copy would glue itself to the first key for most .env parsers
    text = example ? fs.readFileSync(path.join(root, example), 'utf8').replace(/^﻿/, '') : '';
    created = true;
  }
  const result = applyEnvUpdates(text, updates);
  if (created || result.changed.length) fs.writeFileSync(envPath, result.text, 'utf8');
  return { path: '.env', created, changed: result.changed };
}
