#!/usr/bin/env node
/**
 * Local Windows installer that works with Smart App Control on:
 *   1. electron-builder packs the app into release\win-unpacked (nothing unsigned is executed)
 *   2. makensis compiles installer\standalone.nsi around it (compiling runs nothing either)
 * Result: release\v<version>\zeithub-otto-setup-<version>.exe
 *
 * The regular `dist:win` (electron-builder's NSIS target) is still the one for CI.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
const version = pkg.version;
const releaseDir = path.join(desktopDir, 'release');
const unpacked = path.join(releaseDir, 'win-unpacked');
const outDir = path.join(releaseDir, `v${version}`);
const outFile = path.join(outDir, `zeithub-otto-setup-${version}.exe`);

function findMakensis() {
  const cache = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache', 'nsis');
  if (fs.existsSync(cache)) {
    for (const dir of fs.readdirSync(cache).sort().reverse()) {
      const exe = path.join(cache, dir, 'makensis.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  for (const p of ['C:\\Program Files (x86)\\NSIS\\makensis.exe', 'C:\\Program Files\\NSIS\\makensis.exe']) if (fs.existsSync(p)) return p;
  throw new Error('makensis.exe not found: run `npm run dist:win` once (it downloads NSIS) or install NSIS');
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: desktopDir, shell: process.platform === 'win32', ...opts });

console.log('[dist:local] 1/2 packing the app (electron-builder --dir)…');
run('npx', ['electron-builder', '--win', 'dir']);
if (!fs.existsSync(path.join(unpacked, 'zeithub.otto.exe'))) throw new Error('release\\win-unpacked\\zeithub.otto.exe is missing');

console.log('[dist:local] 2/2 building the installer (makensis)…');
fs.mkdirSync(outDir, { recursive: true });
const makensis = findMakensis();
execFileSync(makensis, [
  '/V2', '/INPUTCHARSET', 'UTF8',
  `/DSRC=${unpacked}`,
  `/DOUTFILE=${outFile}`,
  `/DVERSION=${version}`,
  `/DICON=${path.join(desktopDir, 'assets', 'icon.ico')}`,
  `/DBUILD_RESOURCES_DIR=${path.join(desktopDir, 'build')}`,
  path.join(desktopDir, 'installer', 'standalone.nsi'),
], { stdio: 'inherit' });

const mb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
console.log(`[dist:local] done: ${outFile} (${mb} MB)`);
