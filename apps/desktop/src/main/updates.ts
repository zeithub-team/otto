import { app, BrowserWindow, dialog, net, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * "A new version is available": asks GitHub for the latest release at startup
 * and once a day, and offers the download page. Nothing is installed here —
 * the user runs the new installer themselves.
 */
const LATEST = 'https://api.github.com/repos/zeithub-team/otto/releases/latest';
const DAY = 24 * 60 * 60 * 1000;

/** 1 when a is newer than b, -1 when older, 0 when equal ("v0.1.10" > "0.1.9"). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/i, '').split(/[.-]/).map((p) => parseInt(p, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

const stateFile = () => path.join(app.getPath('userData'), 'update-check.json');

function readSkipped(): string {
  try { return String(JSON.parse(fs.readFileSync(stateFile(), 'utf8')).skipped ?? ''); } catch { return ''; }
}

function writeSkipped(version: string): void {
  try { fs.writeFileSync(stateFile(), JSON.stringify({ skipped: version })); } catch { /* not important */ }
}

async function latestRelease(): Promise<{ version: string; url: string } | null> {
  try {
    const res = await net.fetch(LATEST, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'zeithub-otto' } });
    if (!res.ok) return null;
    const json = (await res.json()) as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean };
    if (!json.tag_name || json.draft || json.prerelease) return null;
    return { version: json.tag_name.replace(/^v/i, ''), url: json.html_url || 'https://github.com/zeithub-team/otto/releases/latest' };
  } catch {
    return null; // offline — try again tomorrow
  }
}

let asking = false;

async function check(getWindow: () => BrowserWindow | null): Promise<void> {
  const latest = await latestRelease();
  if (!latest || asking) return;
  if (compareVersions(latest.version, app.getVersion()) <= 0 || latest.version === readSkipped()) return;
  const ru = app.getLocale().toLowerCase().startsWith('ru');
  const options = {
    type: 'info' as const,
    title: 'zeithub.otto',
    message: ru ? `Доступна новая версия ${latest.version}` : `Version ${latest.version} is available`,
    detail: ru
      ? `Установлена ${app.getVersion()}. Скачайте установщик со страницы релиза и запустите его — настройки и проекты сохранятся.`
      : `You have ${app.getVersion()}. Download the installer from the release page and run it — settings and projects are kept.`,
    buttons: ru ? ['Скачать', 'Позже', 'Пропустить эту версию'] : ['Download', 'Later', 'Skip this version'],
    defaultId: 0,
    cancelId: 1,
  };
  asking = true;
  try {
    const win = getWindow();
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (response === 0) void shell.openExternal(latest.url);
    if (response === 2) writeSkipped(latest.version);
  } finally {
    asking = false;
  }
}

export function startUpdateChecks(getWindow: () => BrowserWindow | null): void {
  // the Store build is updated by the Store itself
  if (process.env.OTTO_UPDATE_CHECK === '0' || process.windowsStore) return;
  setTimeout(() => void check(getWindow), 15_000); // let the app finish starting first
  setInterval(() => void check(getWindow), DAY).unref?.();
}
