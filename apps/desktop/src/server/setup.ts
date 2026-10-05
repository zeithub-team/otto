/**
 * First-run setup handed over by the installer wizard.
 *
 * The NSIS wizard (installer/installer.nsi) lets the user pick a language,
 * color scheme and the tools/runtimes to install, and writes them to
 * `<userData>/setup.json`. On first launch the UI reads it through
 * `GET /api/setup`, applies language + theme, installs the chosen tools and
 * then calls `POST /api/setup/done`, which renames the file so it is applied
 * exactly once.
 *
 * The file is user-writable input — everything is validated here.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TOOLS } from './env';

export interface FirstRunSetup {
  version: 1;
  /** UI language id (ru, en, az, ge, it, sp). */
  locale: string;
  /** Color scheme id; the UI ignores ids it does not know. */
  theme: string;
  /** Tool ids from `TOOLS` (docker, node, python, …). */
  tools: string[];
}

const LOCALES = ['ru', 'en', 'az', 'ge', 'it', 'sp'];
const FILE = 'setup.json';
const APPLIED = 'setup.applied.json';

/** Accepts `tools` as an array or the installer's comma-separated string. */
function parseTools(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const known = new Set(TOOLS.map((t) => t.id));
  const out: string[] = [];
  for (const item of list) {
    const id = String(item).trim().toLowerCase();
    if (known.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Pending setup, or null when there is none (or it is unreadable). */
/**
 * Where a pending setup may be: the app's data folder, and the folder the installer writes to
 * (%APPDATA%\zeithub.otto — named after the product, while the app keeps its data under the package name).
 */
export function setupDirs(dataDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [dataDir];
  // only for the app's real data folder (it lives in %APPDATA% too); tests and portable data folders keep to themselves
  if (env.APPDATA && path.resolve(dataDir).toLowerCase().startsWith(path.resolve(env.APPDATA).toLowerCase() + path.sep)) dirs.push(path.join(env.APPDATA, 'zeithub.otto'));
  return dirs.filter((d, i) => dirs.findIndex((x) => path.resolve(x).toLowerCase() === path.resolve(d).toLowerCase()) === i);
}

const pendingFile = (dataDir: string): string | null => setupDirs(dataDir).map((d) => path.join(d, FILE)).find((f) => fs.existsSync(f)) ?? null;

export function readSetup(dataDir: string): FirstRunSetup | null {
  const file = pendingFile(dataDir);
  if (!file) return null;
  let data: unknown;
  try {
    // strip a UTF-8 BOM: NSIS may write one
    data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const locale = String(obj.locale ?? '').toLowerCase();
  const theme = String(obj.theme ?? '').toLowerCase();
  return {
    version: 1,
    locale: LOCALES.includes(locale) ? locale : 'ru',
    theme: /^[a-z][a-z-]{0,23}$/.test(theme) ? theme : 'emerald',
    tools: parseTools(obj.tools),
  };
}

/** Mark the setup as applied (renames the file). Returns false if none existed. */
export function markSetupDone(dataDir: string): boolean {
  const file = pendingFile(dataDir);
  if (!file) return false;
  try {
    fs.renameSync(file, path.join(path.dirname(file), APPLIED));
  } catch {
    fs.rmSync(file, { force: true });
  }
  return true;
}
