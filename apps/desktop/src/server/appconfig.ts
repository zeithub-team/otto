/**
 * Application settings.
 *
 * Two homes:
 *  - `config.json` next to the database: read by the desktop shell BEFORE the
 *    server starts (the port) — changes need a restart;
 *  - the settings table: everything else, applied immediately.
 *
 * `SETTINGS` is the single schema: the API validates against it and the UI is
 * generated from it.
 */
import * as fs from 'fs';
import * as path from 'path';

export type SettingKind = 'number' | 'text' | 'select' | 'bool';

export interface SettingDef {
  key: string;
  page: 'models' | 'agent' | 'terminal' | 'permissions' | 'server';
  kind: SettingKind;
  default: string | number | boolean;
  min?: number;
  max?: number;
  options?: Array<string | number>;
  /** Stored in config.json and only read at startup. */
  restart?: boolean;
  /** Text setting that may be empty. */
  optional?: boolean;
}

/** Port the packaged app prefers (keeps the browser origin — and its localStorage — stable). */
export const DEFAULT_PORT = 43117;

export const SETTINGS: SettingDef[] = [
  { key: 'ollama.url', page: 'models', kind: 'text', default: 'http://localhost:11434' },
  { key: 'agent.effort', page: 'models', kind: 'select', default: 'auto', options: ['auto', 'off', 'low', 'medium', 'high', 'max'] },
  { key: 'agent.numCtx', page: 'models', kind: 'select', default: 32768, options: [8192, 16384, 32768, 65536, 131072] },
  { key: 'agent.maxSteps', page: 'agent', kind: 'number', default: 40, min: 5, max: 100 },
  { key: 'agent.parallelSteps', page: 'agent', kind: 'number', default: 2, min: 1, max: 4 },
  { key: 'agent.web', page: 'agent', kind: 'bool', default: true },
  { key: 'agent.shell', page: 'agent', kind: 'select', default: 'ask', options: ['ask', 'auto', 'off'] },
  // local models: guided = one JSON action per turn (guided.ts); auto = guided for every local model
  { key: 'agent.localMode', page: 'agent', kind: 'select', default: 'auto', options: ['auto', 'guided', 'native'] },
  // a light local model that plans page / code work for the chat's model (planner.ts); empty = off
  { key: 'agent.planner', page: 'agent', kind: 'text', default: '' },
  { key: 'claude.cli', page: 'models', kind: 'bool', default: false },
  { key: 'codex.cli', page: 'models', kind: 'bool', default: false },
  { key: 'terminal.shell', page: 'terminal', kind: 'select', default: 'auto', options: ['auto', 'powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'tabby'] },
  { key: 'permissions.terminal', page: 'permissions', kind: 'select', default: 'ask', options: ['ask', 'allow'] },
  { key: 'permissions.ssh', page: 'permissions', kind: 'select', default: 'ask', options: ['ask', 'allow', 'off'] },
  { key: 'permissions.connectors', page: 'permissions', kind: 'select', default: 'ask', options: ['ask', 'allow', 'off'] },
  { key: 'server.port', page: 'server', kind: 'number', default: DEFAULT_PORT, min: 1024, max: 65535, restart: true },
];

export const settingDef = (key: string): SettingDef | undefined => SETTINGS.find((s) => s.key === key);

// ------------------------------------------------------------------ config.json

export const CONFIG_FILE = 'config.json';

export function readConfig(dir: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function writeConfig(dir: string, patch: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  const next = { ...readConfig(dir), ...patch };
  fs.writeFileSync(path.join(dir, CONFIG_FILE), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

/** The port to start on: config.json, then `OTTO_PORT`, then the default. */
export function configuredPort(dir: string, env = process.env): number {
  const fromFile = Number(readConfig(dir)['server.port']);
  if (Number.isInteger(fromFile) && fromFile >= 1024 && fromFile <= 65535) return fromFile;
  const fromEnv = Number(env.OTTO_PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_PORT;
}

// ------------------------------------------------------------------ values

export interface SettingsStore {
  getSetting(key: string): string;
  setSetting(key: string, value: string): void;
}

/** Current value of a setting (file for restart-settings, database otherwise), typed by its schema. */
export function readSetting(def: SettingDef, dir: string, db: SettingsStore): string | number | boolean {
  const raw = def.restart ? readConfig(dir)[def.key] : db.getSetting(`app.${def.key}`);
  if (raw === undefined || raw === null || raw === '') return def.default;
  return coerce(def, raw) ?? def.default;
}

function coerce(def: SettingDef, raw: unknown): string | number | boolean | null {
  switch (def.kind) {
    case 'bool':
      if (typeof raw === 'boolean') return raw;
      return raw === 'true' || raw === '1' ? true : raw === 'false' || raw === '0' ? false : null;
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
      if (def.min !== undefined && n < def.min) return null;
      if (def.max !== undefined && n > def.max) return null;
      return n;
    }
    case 'select': {
      const match = (def.options ?? []).find((o) => String(o) === String(raw));
      return match ?? null;
    }
    default:
      return typeof raw === 'string' ? raw.trim() : null;
  }
}

export interface SettingsSnapshot {
  values: Record<string, string | number | boolean>;
  defaults: Record<string, string | number | boolean>;
  meta: SettingDef[];
}

export function snapshot(dir: string, db: SettingsStore): SettingsSnapshot {
  const values: SettingsSnapshot['values'] = {};
  const defaults: SettingsSnapshot['defaults'] = {};
  for (const def of SETTINGS) {
    values[def.key] = readSetting(def, dir, db);
    defaults[def.key] = def.default;
  }
  return { values, defaults, meta: SETTINGS };
}

export interface SaveResult {
  saved: string[];
  /** Restart-settings whose new value differs from what the running app uses. */
  restart_required: string[];
  errors: Record<string, string>;
}

/**
 * Validate and store `input`. `running` holds the restart-setting values in
 * effect right now, so the result says whether a restart is really needed.
 */
export function saveSettings(dir: string, db: SettingsStore, input: Record<string, unknown>, running: Record<string, unknown>): SaveResult {
  const result: SaveResult = { saved: [], restart_required: [], errors: {} };
  const filePatch: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    const def = settingDef(key);
    if (!def) {
      result.errors[key] = 'Unknown setting';
      continue;
    }
    const value = coerce(def, raw);
    if (value === null || (def.kind === 'text' && value === '' && !def.optional)) {
      result.errors[key] = def.kind === 'number' ? `Enter a whole number${def.min !== undefined ? ` from ${def.min}` : ''}${def.max !== undefined ? ` to ${def.max}` : ''}` : 'Invalid value';
      continue;
    }
    if (def.kind === 'text' && key === 'ollama.url' && !/^https?:\/\/[^\s]+$/i.test(String(value))) {
      result.errors[key] = 'Use an http:// or https:// address';
      continue;
    }
    if (def.restart) {
      filePatch[key] = value;
      if (running[key] !== value) result.restart_required.push(key);
    } else {
      db.setSetting(`app.${key}`, String(value));
    }
    result.saved.push(key);
  }
  if (Object.keys(filePatch).length) writeConfig(dir, filePatch);
  return result;
}

// ------------------------------------------------------------------ live access

let liveGet: (key: string) => string = () => '';

/** Wire the settings table so agent/terminal code can read live values. */
export function configureAppSettings(get: (key: string) => string): void {
  liveGet = get;
}

/** Typed live value of a non-restart setting. */
export function live<T extends string | number | boolean>(key: string): T {
  const def = settingDef(key);
  if (!def) throw new Error(`Unknown setting ${key}`);
  const raw = liveGet(`app.${key}`);
  if (raw === '') return def.default as T;
  return (coerce(def, raw) ?? def.default) as T;
}

/** Push the Ollama address into the environment the client reads on every request. */
export function applyLiveSettings(db: SettingsStore): void {
  const url = db.getSetting('app.ollama.url').trim();
  if (url) process.env.OLLAMA_URL = url;
}
