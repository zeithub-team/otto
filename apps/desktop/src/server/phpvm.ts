/**
 * PHP version manager (Windows): several PHP versions side by side, one of them
 * the global `php`, and a version + php.ini per project.
 *
 *   %LOCALAPPDATA%\zeithub.otto\tools\php\<branch>\   php.exe + php.ini of that version
 *   %LOCALAPPDATA%\zeithub.otto\tools\php\bin\php.bat the global `php` (points at the active version)
 *   <project>\.otto\php.json                           { "version": "7.4", "customIni": true }
 *   <project>\.otto\php\php.ini                        the project's own php.ini (PHPRC points there)
 *
 * Builds come from windows.php.net over HTTPS; supported branches are verified
 * against the SHA-256 in releases.json, the two archived ones against a pinned hash.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { enablePhpExtensions, envWithPathFirst, prependUserPath, removeFromUserPath } from './env';

const RELEASES_URL = 'https://windows.php.net/downloads/releases/';

export interface PhpBuild {
  /** "8.4" */
  branch: string;
  /** "8.4.26" */
  version: string;
  url: string;
  sha256: string;
  archived: boolean;
}

/** Branches that left releases.json: hashes pinned from a verified download. */
const ARCHIVED: PhpBuild[] = [
  { branch: '7.3', version: '7.3.33', url: `${RELEASES_URL}archives/php-7.3.33-nts-Win32-VC15-x64.zip`, sha256: '5eaf3cad80e678623f222a42c99bcefcc60eea359d407fb51e805afdb3b13e5e', archived: true },
  { branch: '7.2', version: '7.2.34', url: `${RELEASES_URL}archives/php-7.2.34-nts-Win32-VC15-x64.zip`, sha256: '3c673eab656e26fd6bc3ad27fe71169ad888b04e21d63d3c6b3151d5ed216563', archived: true },
];

export function phpRoot(): string {
  return path.join(process.env.LOCALAPPDATA || os.homedir(), 'zeithub.otto', 'tools', 'php');
}
const binDir = (): string => path.join(phpRoot(), 'bin');
const validBranch = (v: string): boolean => /^\d+\.\d+$/.test(v);

export function versionDir(branch: string): string {
  if (!validBranch(branch)) throw new Error(`Invalid PHP version: ${branch}`);
  return path.join(phpRoot(), branch);
}

/** Builds that can be installed: the current releases (verified by releases.json) + the archived ones. */
export async function availableBuilds(): Promise<PhpBuild[]> {
  const builds: PhpBuild[] = [];
  try {
    const res = await fetch(`${RELEASES_URL}releases.json`, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      const data = (await res.json()) as Record<string, Record<string, { zip?: { path?: string; sha256?: string } } & { version?: string }>>;
      for (const [branch, entry] of Object.entries(data)) {
        if (!validBranch(branch)) continue;
        const key = Object.keys(entry).find((k) => /^nts-.*x64$/.test(k));
        const zip = key ? (entry[key] as { zip?: { path?: string; sha256?: string } }).zip : undefined;
        if (zip?.path && zip.sha256) builds.push({ branch, version: String(entry.version), url: `${RELEASES_URL}${zip.path}`, sha256: zip.sha256.toLowerCase(), archived: false });
      }
    }
  } catch {
    /* offline: only the archived builds are offered */
  }
  for (const old of ARCHIVED) if (!builds.some((b) => b.branch === old.branch)) builds.push(old);
  return builds.sort((a, b) => b.branch.localeCompare(a.branch, undefined, { numeric: true }));
}

export interface InstalledPhp { branch: string; version: string; dir: string }

function readVersion(dir: string): string {
  const result = spawnSync(path.join(dir, 'php.exe'), ['-r', 'echo PHP_VERSION;'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return result.status === 0 ? String(result.stdout).trim() : '';
}

export function listInstalled(): InstalledPhp[] {
  const root = phpRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && validBranch(d.name) && fs.existsSync(path.join(root, d.name, 'php.exe')))
    .map((d) => ({ branch: d.name, version: readVersion(path.join(root, d.name)) || d.name, dir: path.join(root, d.name) }))
    .sort((a, b) => b.branch.localeCompare(a.branch, undefined, { numeric: true }));
}

export function activeBranch(): string | null {
  try {
    const value = fs.readFileSync(path.join(binDir(), 'active.txt'), 'utf8').trim();
    return validBranch(value) ? value : null;
  } catch {
    return null;
  }
}

export function checkSha256(data: Buffer, expected: string): boolean {
  return crypto.createHash('sha256').update(data).digest('hex') === expected.toLowerCase();
}

/** Download, verify, unpack and configure one PHP branch. Returns 0 on success. */
export async function installPhp(branch: string, log: (line: string) => void): Promise<number> {
  try {
    const build = (await availableBuilds()).find((b) => b.branch === branch);
    if (!build) throw new Error(`PHP ${branch} is not available`);
    log(`Скачиваю PHP ${build.version} (${build.url})`);
    const res = await fetch(build.url, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const zip = Buffer.from(await res.arrayBuffer());
    if (!checkSha256(zip, build.sha256)) throw new Error('контрольная сумма архива не совпала — ничего не установлено');
    log(`Архив ${Math.round(zip.length / 1048576)} МБ, SHA-256 совпал`);

    const dir = versionDir(branch);
    const tmp = path.join(os.tmpdir(), `otto-php-${branch}-${Date.now()}.zip`);
    fs.writeFileSync(tmp, zip);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const unpack = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${tmp.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
      if (unpack.status !== 0) throw new Error(`не удалось распаковать: ${String(unpack.stderr).trim().slice(0, 200)}`);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    if (!fs.existsSync(path.join(dir, 'php.exe'))) throw new Error('в архиве нет php.exe');

    const dev = path.join(dir, 'php.ini-development');
    if (fs.existsSync(dev)) {
      fs.writeFileSync(path.join(dir, 'php.ini'), enablePhpExtensions(fs.readFileSync(dev, 'utf8')));
      log('php.ini создан: включены openssl, curl, mbstring, pdo_mysql, zip, gd, intl и др.');
    }
    if (Number(branch.split('.')[0]) < 8 || branch === '8.0') log('Сборки 7.x/8.0 требуют Microsoft Visual C++ Redistributable 2015–2022 (x64); если php.exe не запускается — установите его.');
    if (!activeBranch()) {
      activatePhp(branch);
      log(`PHP ${branch} назначен глобальным: команда php работает в новых окнах терминала`);
    }
    log(`Готово: PHP ${build.version} → ${dir}`);
    return 0;
  } catch (exc) {
    log(`Не удалось установить PHP ${branch}: ${exc instanceof Error ? exc.message : String(exc)}`);
    return 1;
  }
}

export function removePhp(branch: string): void {
  const wasActive = activeBranch() === branch;
  fs.rmSync(versionDir(branch), { recursive: true, force: true });
  if (wasActive) {
    fs.rmSync(path.join(binDir(), 'php.bat'), { force: true });
    fs.rmSync(path.join(binDir(), 'active.txt'), { force: true });
    removeFromUserPath(binDir());
  }
}

/** Make `branch` the global `php` (a shim first on the user PATH). */
export function activatePhp(branch: string): void {
  const dir = versionDir(branch);
  if (!fs.existsSync(path.join(dir, 'php.exe'))) throw new Error(`PHP ${branch} is not installed`);
  fs.mkdirSync(binDir(), { recursive: true });
  fs.writeFileSync(path.join(binDir(), 'php.bat'), `@echo off\r\n"${path.join(dir, 'php.exe')}" %*\r\n`);
  fs.writeFileSync(path.join(binDir(), 'active.txt'), branch);
  prependUserPath(binDir());
}

// ------------------------------------------------------------ php.ini ------

/** php.ini of an installed version, or of a project that has its own. */
export function iniFile(target: { branch: string } | { projectRoot: string }): string {
  return 'branch' in target ? path.join(versionDir(target.branch), 'php.ini') : path.join(target.projectRoot, '.otto', 'php', 'php.ini');
}

export function readIni(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

export function writeIni(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content.replace(/\r?\n/g, '\r\n'));
}

// ------------------------------------------------------------ per project --

export interface ProjectPhp { version: string | null; customIni: boolean }

const projectFile = (root: string): string => path.join(root, '.otto', 'php.json');

export function readProjectPhp(root: string): ProjectPhp {
  try {
    const raw = JSON.parse(fs.readFileSync(projectFile(root), 'utf8')) as { version?: unknown; customIni?: unknown };
    const version = typeof raw.version === 'string' && validBranch(raw.version) ? raw.version : null;
    return { version, customIni: Boolean(raw.customIni) && fs.existsSync(iniFile({ projectRoot: root })) };
  } catch {
    return { version: null, customIni: false };
  }
}

/** Save the project's choice; `customIni: true` copies the version's php.ini into the project on first use. */
export function writeProjectPhp(root: string, next: ProjectPhp): ProjectPhp {
  const version = next.version && validBranch(next.version) ? next.version : null;
  let customIni = next.customIni && version !== null;
  if (customIni) {
    const own = iniFile({ projectRoot: root });
    if (!fs.existsSync(own)) writeIni(own, readIni(iniFile({ branch: version! })) || '; php.ini of this project\r\n');
  }
  if (!version) customIni = false;
  fs.mkdirSync(path.dirname(projectFile(root)), { recursive: true });
  fs.writeFileSync(projectFile(root), JSON.stringify({ version, customIni }, null, 2));
  return { version, customIni };
}

/** Environment for a process running in a project: its PHP first on PATH, its php.ini via PHPRC. */
export function projectPhpEnv(root: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return env;
  const choice = readProjectPhp(root);
  if (!choice.version) return env;
  const dir = versionDir(choice.version);
  if (!fs.existsSync(path.join(dir, 'php.exe'))) return env;
  const withPath = envWithPathFirst(env, dir);
  return choice.customIni ? { ...withPath, PHPRC: path.dirname(iniFile({ projectRoot: root })) } : { ...withPath, PHPRC: dir };
}
