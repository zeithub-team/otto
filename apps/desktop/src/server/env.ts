/**
 * Environment probing + installation for zeithub.otto.
 *
 * Detects whether Ollama and common language runtimes are available on PATH,
 * and installs them via `winget` (Windows) with streamed progress. Detection
 * is cross-platform; installation is Windows-only (the desktop target).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import type * as http from 'http';
import { listModels } from './ollama';

export interface InstallOption { label: string; wingetId: string }

export interface ToolSpec {
  id: string;
  name: string;
  /** Category for the UI. */
  kind: 'ai' | 'runtime' | 'tool' | 'container';
  /** Probe command + args (e.g. `node --version`). */
  probe: string[];
  /** Default winget package id used to install it. */
  wingetId: string;
  /** Selectable install variants (versions / managers). First is the default. */
  options?: InstallOption[];
  /** Short description for the UI. */
  note?: string;
  /** Folders with the tool's executables that its installer does not add to PATH itself (XAMPP). */
  pathDirs?: string[];
  /** Tools winget does not have are installed by Otto itself. */
  installer?: 'composer';
}

/**
 * Tools the app can detect and install via winget. `options` list alternative
 * versions / managers; the chosen one's id is passed back to the install call.
 * IDs are verified winget package identifiers.
 */
export const TOOLS: ToolSpec[] = [
  { id: 'docker', name: 'Docker Desktop', kind: 'container', probe: ['docker', '--version'], wingetId: 'Docker.DockerDesktop', note: 'Нужен для сервисов (БД, брокеры) и dev-контейнеров' },
  { id: 'tabby', name: 'Tabby Terminal', kind: 'tool', probe: ['tabby', '--version'], wingetId: 'Eugeny.Tabby', note: 'Внешний терминал; Otto может открыть его сразу в папке проекта' },
  { id: 'ollama', name: 'Ollama', kind: 'ai', probe: ['ollama', '--version'], wingetId: 'Ollama.Ollama', note: 'Локальные модели: включает Модели и Чат' },
  { id: 'git', name: 'Git', kind: 'tool', probe: ['git', '--version'], wingetId: 'Git.Git', note: 'Контроль версий, ветки, клонирование' },
  { id: 'gh', name: 'GitHub CLI', kind: 'tool', probe: ['gh', '--version'], wingetId: 'GitHub.cli', note: 'Работа с GitHub из консоли' },
  {
    id: 'node', name: 'Node.js', kind: 'runtime', probe: ['node', '--version'], wingetId: 'OpenJS.NodeJS.LTS',
    note: 'JavaScript-рантайм',
    options: [
      { label: 'LTS', wingetId: 'OpenJS.NodeJS.LTS' },
      { label: 'Current', wingetId: 'OpenJS.NodeJS' },
      { label: 'nvm-windows (менеджер версий)', wingetId: 'CoreyButler.NVMforWindows' },
    ],
  },
  {
    id: 'python', name: 'Python', kind: 'runtime', probe: ['python', '--version'], wingetId: 'Python.Python.3.12',
    options: [
      { label: '3.13', wingetId: 'Python.Python.3.13' },
      { label: '3.12', wingetId: 'Python.Python.3.12' },
      { label: '3.11', wingetId: 'Python.Python.3.11' },
    ],
  },
  {
    id: 'php', name: 'PHP', kind: 'runtime', probe: ['php', '--version'], wingetId: 'PHP.PHP.8.4',
    pathDirs: ['C:\\xampp\\php'],
    note: 'Обычный PHP (php.ini с нужными расширениями настроится сам) или XAMPP; для проекта можно и dev-контейнер',
    options: [
      { label: 'PHP 8.5', wingetId: 'PHP.PHP.8.5' },
      { label: 'PHP 8.4', wingetId: 'PHP.PHP.8.4' },
      { label: 'PHP 8.3', wingetId: 'PHP.PHP.8.3' },
      { label: 'PHP 8.2', wingetId: 'PHP.PHP.8.2' },
      { label: 'PHP 8.1', wingetId: 'PHP.PHP.8.1' },
      { label: 'PHP 8.4 NTS (без потоков)', wingetId: 'PHP.PHP.NTS.8.4' },
      { label: 'XAMPP 8.2 (PHP+Apache+MySQL)', wingetId: 'ApacheFriends.Xampp.8.2' },
      { label: 'XAMPP 8.1', wingetId: 'ApacheFriends.Xampp.8.1' },
    ],
  },
  {
    id: 'ruby', name: 'Ruby', kind: 'runtime', probe: ['ruby', '--version'], wingetId: 'RubyInstallerTeam.Ruby.3.4',
    options: [
      { label: '3.4', wingetId: 'RubyInstallerTeam.Ruby.3.4' },
      { label: '3.3', wingetId: 'RubyInstallerTeam.Ruby.3.3' },
      { label: '3.2', wingetId: 'RubyInstallerTeam.Ruby.3.2' },
    ],
  },
  // not in winget: Otto downloads composer.phar itself (see installComposer)
  { id: 'composer', name: 'Composer', kind: 'tool', probe: ['composer', '--version'], wingetId: '', installer: 'composer', note: 'Менеджер пакетов PHP (сначала установите PHP)' },
  { id: 'go', name: 'Go', kind: 'runtime', probe: ['go', 'version'], wingetId: 'GoLang.Go' },
  { id: 'rust', name: 'Rust', kind: 'runtime', probe: ['rustc', '--version'], wingetId: 'Rustlang.Rustup' },
  {
    id: 'java', name: 'Java (JDK)', kind: 'runtime', probe: ['java', '-version'], wingetId: 'Microsoft.OpenJDK.21',
    options: [
      { label: 'OpenJDK 21', wingetId: 'Microsoft.OpenJDK.21' },
      { label: 'OpenJDK 17', wingetId: 'Microsoft.OpenJDK.17' },
      { label: 'Temurin 21', wingetId: 'EclipseAdoptium.Temurin.21.JDK' },
    ],
  },
  {
    id: 'dotnet', name: '.NET SDK', kind: 'runtime', probe: ['dotnet', '--version'], wingetId: 'Microsoft.DotNet.SDK.9',
    options: [
      { label: 'SDK 9', wingetId: 'Microsoft.DotNet.SDK.9' },
      { label: 'SDK 8', wingetId: 'Microsoft.DotNet.SDK.8' },
    ],
  },
];

export interface ToolStatus {
  id: string;
  name: string;
  kind: ToolSpec['kind'];
  installed: boolean;
  version: string;
  wingetId: string;
  options?: InstallOption[];
  note?: string;
  /** Only for Ollama: whether the local server answers. */
  running?: boolean;
}

/** Allowed winget ids for a tool (default + options) — guards the install call. */
export function allowedWingetIds(toolId: string): string[] {
  const tool = TOOLS.find((t) => t.id === toolId);
  if (!tool) return [];
  return [tool.wingetId, ...(tool.options?.map((o) => o.wingetId) ?? [])];
}

// ------------------------------------------------------------------ PATH ----
//
// An installer changes the PATH in the registry, but a running process keeps the
// PATH it was started with — so the tool stays "not found" (and Otto's terminals
// do not see it) until everything is restarted. After an install Otto reads the
// registry PATH itself, and adds the folders of tools whose installers forget to.

const pathKey = (entry: string): string => entry.trim().replace(/[\\/]+$/, '').toLowerCase();

/** `current` plus the entries of `fresh` it does not have yet (case-insensitive, order kept). */
export function mergePath(current: string, fresh: string): string {
  const parts = current.split(';').filter(Boolean);
  const seen = new Set(parts.map(pathKey));
  for (const entry of fresh.split(';')) {
    if (entry.trim() && !seen.has(pathKey(entry))) {
      parts.push(entry.trim());
      seen.add(pathKey(entry));
    }
  }
  return parts.join(';');
}

/** `path` with `dir` appended unless it is already listed. */
export function addPathEntry(path: string, dir: string): string {
  return mergePath(path, dir);
}

function powershell(command: string): string {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  return result.status === 0 ? String(result.stdout ?? '').trim() : '';
}

/** Machine + user PATH as stored in the registry (Windows). */
function registryPath(): string {
  return powershell("[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')");
}

/** Find Docker Desktop's CLI even when the app was launched before Docker was installed. */
export function dockerCliPath(): string | null {
  refreshProcessPath(true);
  if (process.platform !== 'win32') {
    const candidate = process.env.PATH ? 'docker' : '/usr/bin/docker';
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return !probe.error && probe.status === 0 ? candidate : null;
  }
  const candidates = [
    process.env.DOCKER_CLI,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe') : undefined,
    process.env['ProgramW6432'] ? path.join(process.env['ProgramW6432'], 'Docker', 'Docker', 'resources', 'bin', 'docker.exe') : undefined,
    ...((process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).map((dir) => path.join(dir, process.platform === 'win32' ? 'docker.exe' : 'docker'))),
    process.platform === 'win32' ? 'docker.exe' : 'docker',
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true, shell: process.platform === 'win32' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

/** Start Docker Desktop for the current user; Docker itself still applies its normal access controls. */
export function startDockerDesktop(): { started: boolean; message?: string } {
  if (process.platform !== 'win32') return { started: false, message: 'Automatic Docker Desktop start is available only on Windows.' };
  const exe = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Docker', 'Docker', 'Docker Desktop.exe') : undefined,
    process.env['ProgramW6432'] ? path.join(process.env['ProgramW6432'], 'Docker', 'Docker', 'Docker Desktop.exe') : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Docker', 'Docker', 'Docker Desktop.exe') : undefined,
  ].find((candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate)));
  if (!exe) return { started: false, message: 'Docker Desktop is not installed. Install it, then retry.' };
  const result = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true });
  result.unref();
  return { started: true };
}

/** Make this process (and the terminals and probes it starts) see the PATH the installers wrote. */
let lastPathRefresh = 0;
export function refreshProcessPath(force = false): void {
  if (process.platform !== 'win32') return;
  if (!force && Date.now() - lastPathRefresh < 10_000) return; // status is polled: do not spawn PowerShell every time
  lastPathRefresh = Date.now();
  const fresh = registryPath();
  if (fresh) process.env.PATH = mergePath(process.env.PATH ?? '', fresh);
}

/**
 * Put `dir` on the user's PATH (persistent, new windows see it) and on ours.
 * Returns 'added' | 'present' (already there) | 'missing' (the folder does not exist).
 */
export function ensureOnUserPath(dir: string): 'added' | 'present' | 'missing' {
  if (process.platform !== 'win32') return 'missing';
  if (!fs.existsSync(dir)) return 'missing';
  const user = powershell("[Environment]::GetEnvironmentVariable('Path','User')");
  const has = (list: string): boolean => list.split(';').some((entry) => pathKey(entry) === pathKey(dir));
  if (has(user) || has(registryPath())) {
    process.env.PATH = mergePath(process.env.PATH ?? '', dir);
    return 'present';
  }
  const next = addPathEntry(user, dir).replace(/'/g, "''");
  powershell(`[Environment]::SetEnvironmentVariable('Path','${next}','User')`);
  process.env.PATH = mergePath(process.env.PATH ?? '', dir);
  return 'added';
}

/** Strip replacement chars / control bytes so a version line renders cleanly. */
function sanitizeVersion(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/�/g, '').replace(/[\u0000-\u001f]/g, ' ').trim();
}

/**
 * Run a version probe. A tool counts as installed only when the command exits
 * with code 0 — a non-zero exit is the shell's "not recognized" error (which on
 * localized Windows is OEM-encoded and would otherwise show up as mojibake).
 */
function probe(cmd: string[]): { installed: boolean; version: string } {
  try {
    const result = spawnSync(cmd[0], cmd.slice(1), {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      shell: process.platform === 'win32', // resolve .cmd/.bat shims on PATH
    });
    if (result.error || result.status !== 0) return { installed: false, version: '' };
    // Some tools (java) print the version to stderr.
    const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    const first = sanitizeVersion(out.split(/\r?\n/)[0] ?? '');
    return { installed: true, version: first };
  } catch {
    return { installed: false, version: '' };
  }
}

/** Detect every tool; also pings the local Ollama server. */
export async function envStatus(): Promise<ToolStatus[]> {
  // tools installed outside Otto (or since it started) must be found too
  refreshProcessPath();
  const statuses: ToolStatus[] = TOOLS.map((tool) => {
    let { installed, version } = probe(tool.probe);
    // Tabby is commonly installed per-user by winget. Its CLI shim is not
    // always added to the PATH inherited by an already-running Otto process,
    // so recognize the app executable in the standard install locations too.
    if (!installed && tool.id === 'tabby' && process.platform === 'win32') {
      const candidates = [
        ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs', 'Tabby', 'Tabby.exe')] : []),
        ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs', 'Tabby', 'resources', 'app', 'bin', 'tabby.exe')] : []),
        ...(process.env.ProgramFiles ? [path.join(process.env.ProgramFiles, 'Tabby', 'Tabby.exe')] : []),
        ...(process.env['ProgramW6432'] ? [path.join(process.env['ProgramW6432'], 'Tabby', 'Tabby.exe')] : []),
      ];
      const executable = candidates.find((candidate) => fs.existsSync(candidate));
      if (executable) {
        installed = true;
        version = path.basename(path.dirname(executable));
      }
    }
    // installed but not on PATH (XAMPP's php): put it there so the terminal finds it too
    if (!installed && tool.pathDirs?.some((dir) => ensureOnUserPath(dir) === 'added')) ({ installed, version } = probe(tool.probe));
    return { id: tool.id, name: tool.name, kind: tool.kind, installed, version, wingetId: tool.wingetId, options: tool.options, note: tool.note };
  });

  let ollamaRunning = false;
  try {
    await listModels();
    ollamaRunning = true;
  } catch {
    ollamaRunning = false;
  }
  const ollama = statuses.find((s) => s.id === 'ollama');
  if (ollama) ollama.running = ollamaRunning;

  return statuses;
}

export type InstallAction = 'install' | 'reinstall' | 'uninstall';

// ------------------------------------------------------------------- PHP ----

/** Extensions Composer, Laravel and most packages need; a zip-installed PHP ships them all switched off. */
export const PHP_DEFAULT_EXTENSIONS = ['openssl', 'curl', 'mbstring', 'fileinfo', 'pdo_mysql', 'pdo_sqlite', 'pdo_pgsql', 'sqlite3', 'zip', 'gd', 'intl', 'exif', 'sodium'];

/** php.ini-development with `extension_dir` and the given extensions switched on. */
export function enablePhpExtensions(ini: string, extensions: string[] = PHP_DEFAULT_EXTENSIONS): string {
  let out = ini.replace(/^;\s*extension_dir\s*=\s*"ext"\s*$/m, 'extension_dir = "ext"');
  for (const name of extensions) out = out.replace(new RegExp(`^;\\s*extension=${name}\\s*$`, 'm'), `extension=${name}`);
  return out;
}

/** After a zip-style PHP install: create php.ini next to php.exe so Composer & co. work out of the box. */
function preparePhpIni(log: (line: string) => void): void {
  const where = spawnSync('where', ['php'], { encoding: 'utf8', windowsHide: true, shell: true });
  const exe = String(where.stdout ?? '').split(/\r?\n/).find((l) => l.trim().toLowerCase().endsWith('php.exe'));
  if (!exe) return;
  // winget links the command into a shim folder; the real PHP sits where php.exe --ini says
  const info = spawnSync('php', ['--ini'], { encoding: 'utf8', windowsHide: true, shell: true });
  const dir = /Loaded Configuration File:\s*(.*)/i.exec(String(info.stdout))?.[1]?.trim();
  const phpDir = path.dirname(exe.trim());
  const candidates = [phpDir, /Configuration File \(php\.ini\) Path:\s*(.*)/i.exec(String(info.stdout))?.[1]?.trim()].filter((d): d is string => Boolean(d));
  if (dir && dir !== '(none)') return; // already configured
  for (const base of candidates) {
    const dev = path.join(base, 'php.ini-development');
    const target = path.join(base, 'php.ini');
    if (fs.existsSync(dev) && !fs.existsSync(target)) {
      fs.writeFileSync(target, enablePhpExtensions(fs.readFileSync(dev, 'utf8')));
      log(`php.ini создан (${target}): включены расширения ${PHP_DEFAULT_EXTENSIONS.join(', ')}`);
      return;
    }
  }
}

// -------------------------------------------------------------- Composer ----

const COMPOSER_URL = 'https://getcomposer.org/download/latest-stable/composer.phar';

export function composerDir(): string {
  return path.join(process.env.LOCALAPPDATA || os.homedir(), 'zeithub.otto', 'tools', 'composer');
}

/** Does `sumText` (`<sha256>  composer.phar`) match the downloaded file? */
export function matchesSha256(data: Buffer, sumText: string): boolean {
  const expected = /[a-f0-9]{64}/i.exec(sumText)?.[0]?.toLowerCase();
  return Boolean(expected) && crypto.createHash('sha256').update(data).digest('hex') === expected;
}

/** Download composer.phar (checksum verified), add a `composer` shim and put the folder on PATH. */
async function installComposer(log: (line: string) => void): Promise<number> {
  if (!probe(['php', '--version']).installed) {
    log('PHP не найден в PATH — сначала установите PHP (ниже, в «Языках»), затем повторите.');
    return 1;
  }
  const dir = composerDir();
  try {
    log(`Скачиваю ${COMPOSER_URL}`);
    const [pharRes, sumRes] = await Promise.all([fetch(COMPOSER_URL), fetch(`${COMPOSER_URL}.sha256sum`)]);
    if (!pharRes.ok || !sumRes.ok) throw new Error(`HTTP ${pharRes.ok ? sumRes.status : pharRes.status}`);
    const phar = Buffer.from(await pharRes.arrayBuffer());
    if (!matchesSha256(phar, await sumRes.text())) throw new Error('контрольная сумма composer.phar не совпала — файл не установлен');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'composer.phar'), phar);
    fs.writeFileSync(path.join(dir, 'composer.bat'), '@echo off\r\nphp "%~dp0composer.phar" %*\r\n');
    log(`composer.phar (${Math.round(phar.length / 1024)} КБ) сохранён в ${dir}`);
    if (ensureOnUserPath(dir) === 'added') log(`PATH: добавлено ${dir} — новые окна терминала увидят команду composer`);
    refreshProcessPath(true);
    return 0;
  } catch (exc) {
    log(`Не удалось установить Composer: ${exc instanceof Error ? exc.message : String(exc)}`);
    return 1;
  }
}

function uninstallComposer(log: (line: string) => void): number {
  const dir = composerDir();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    removeFromUserPath(dir);
    log(`Composer удалён (${dir})`);
    return 0;
  } catch (exc) {
    log(`Не удалось удалить: ${exc instanceof Error ? exc.message : String(exc)}`);
    return 1;
  }
}

/** winget arguments: install, reinstall (--force) or uninstall of one package id. */
export function wingetArgs(action: InstallAction, id: string): string[] {
  if (action === 'uninstall') return ['uninstall', '--id', id, '-e', '--accept-source-agreements', '--disable-interactivity'];
  const args = ['install', '--id', id, '-e', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'];
  if (action === 'reinstall') args.push('--force');
  return args;
}

/** Which of the tool's winget packages is installed right now (null = none / winget unavailable). */
function installedWingetId(toolId: string): string | null {
  for (const id of allowedWingetIds(toolId)) {
    const result = spawnSync('winget', ['list', '--id', id, '-e', '--accept-source-agreements', '--disable-interactivity'], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true, shell: true,
    });
    if (result.status === 0 && String(result.stdout).toLowerCase().includes(id.toLowerCase())) return id;
  }
  return null;
}

/** Put `dir` FIRST on the user's PATH (so it wins over other installs of the same tool) and on ours. */
export function prependUserPath(dir: string): void {
  if (process.platform !== 'win32') return;
  const others = (list: string): string[] => list.split(';').filter((entry) => entry.trim() && pathKey(entry) !== pathKey(dir));
  const user = powershell("[Environment]::GetEnvironmentVariable('Path','User')");
  const next = [dir, ...others(user)].join(';').replace(/'/g, "''");
  powershell(`[Environment]::SetEnvironmentVariable('Path','${next}','User')`);
  process.env.PATH = [dir, ...others(process.env.PATH ?? '')].join(';');
}

/** `env` with `dir` first on its PATH, whatever the case of the PATH key (Windows has `Path`). */
export function envWithPathFirst(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  return { ...env, [key]: `${dir}${path.delimiter}${env[key] ?? ''}` };
}

/** Take `dir` off the user's PATH (the one we added at install time) and off ours. */
export function removeFromUserPath(dir: string): void {
  if (process.platform !== 'win32') return;
  const user = powershell("[Environment]::GetEnvironmentVariable('Path','User')");
  const kept = user.split(';').filter((entry) => entry.trim() && pathKey(entry) !== pathKey(dir)).join(';').replace(/'/g, "''");
  if (kept !== user.replace(/'/g, "''")) powershell(`[Environment]::SetEnvironmentVariable('Path','${kept}','User')`);
  process.env.PATH = (process.env.PATH ?? '').split(';').filter((entry) => entry.trim() && pathKey(entry) !== pathKey(dir)).join(';');
}

/**
 * `POST /api/env/install` — install a tool via winget, streaming stdout to the
 * client as newline-delimited JSON: `{line}` per output line, then `{done,code}`.
 */
export function handleInstall(
  res: http.ServerResponse,
  toolId: string,
  wingetId?: string,
  action: InstallAction = 'install',
): void {
  const tool = TOOLS.find((t) => t.id === toolId);
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
  });

  if (!tool) {
    res.write(JSON.stringify({ line: `Unknown tool: ${toolId}` }) + '\n');
    res.write(JSON.stringify({ done: true, code: 1 }) + '\n');
    res.end();
    return;
  }
  if (process.platform !== 'win32') {
    res.write(JSON.stringify({ line: 'Автоустановка доступна только в Windows (winget).' }) + '\n');
    res.write(JSON.stringify({ done: true, code: 1 }) + '\n');
    res.end();
    return;
  }

  if (tool.installer === 'composer') {
    const write = (line: string): void => { if (!res.writableEnded) res.write(JSON.stringify({ line }) + '\n'); };
    const run = action === 'uninstall' ? Promise.resolve(uninstallComposer(write)) : installComposer(write);
    void run.then((code) => {
      if (!res.writableEnded) {
        res.write(JSON.stringify({ done: true, code }) + '\n');
        res.end();
      }
    });
    return;
  }

  // Use the chosen variant if it's one of the tool's allowed ids.
  let chosen = wingetId && allowedWingetIds(toolId).includes(wingetId) ? wingetId : tool.wingetId;
  // remove / reinstall what is really installed (a variant other than the default may be)
  if (action !== 'install') chosen = installedWingetId(toolId) ?? chosen;
  const args = wingetArgs(action, chosen);
  res.write(JSON.stringify({ line: `winget ${args.join(' ')}` }) + '\n');

  const child = spawn('winget', args, { windowsHide: true, shell: true });

  const pump = (buf: Buffer): void => {
    const text = buf.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !res.writableEnded) res.write(JSON.stringify({ line: trimmed }) + '\n');
    }
  };
  child.stdout.on('data', pump);
  child.stderr.on('data', pump);
  child.on('error', (exc) => {
    if (!res.writableEnded) {
      const msg = exc.message.includes('ENOENT')
        ? 'winget не найден. Установите App Installer из Microsoft Store.'
        : exc.message;
      res.write(JSON.stringify({ line: msg }) + '\n');
      res.write(JSON.stringify({ done: true, code: 1 }) + '\n');
      res.end();
    }
  });
  child.on('close', (code) => {
    if (!res.writableEnded) {
      if ((code ?? 0) === 0 && action === 'uninstall') {
        // take back the PATH folders we added for this tool
        try {
          for (const dir of tool.pathDirs ?? []) removeFromUserPath(dir);
        } catch {
          /* best-effort */
        }
      } else if ((code ?? 0) === 0) {
        // the installer changed PATH in the registry (or forgot to): make `php`, `node`… work right away
        try {
          for (const dir of tool.pathDirs ?? []) {
            const result = ensureOnUserPath(dir);
            if (result === 'added') res.write(JSON.stringify({ line: `PATH: добавлено ${dir} — новые окна терминала увидят команду ${tool.probe[0]}` }) + '\n');
          }
          refreshProcessPath(true);
          if (tool.id === 'php') preparePhpIni((line) => res.write(JSON.stringify({ line }) + '\n'));
        } catch {
          /* PATH refresh is best-effort */
        }
      }
      res.write(JSON.stringify({ done: true, code: code ?? 0 }) + '\n');
      res.end();
    }
  });
  res.on('close', () => {
    if (child.exitCode === null) child.kill();
  });
}
