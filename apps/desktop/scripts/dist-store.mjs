#!/usr/bin/env node
/**
 * Microsoft Store package: release/v<version>/zeithub-otto-<version>.appx
 *
 * The package identity comes from Partner Center (Product management → Product
 * identity) and lives in apps/desktop/store.json:
 *   { "identityName": "...", "publisher": "CN=...", "publisherDisplayName": "..." }
 * The Store signs the package itself on submission, so nothing is signed here.
 * Without store.json a local test package is built with a placeholder identity
 * (it cannot be uploaded).
 *
 * Usage (after `npm run build && npm run build:renderer`): node scripts/dist-store.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
const storeFile = path.join(desktopDir, 'store.json');
const store = fs.existsSync(storeFile)
  ? JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  : { identityName: 'zeithub.otto.dev', publisher: 'CN=zeithub-dev', publisherDisplayName: 'zeithub' };
if (!fs.existsSync(storeFile)) console.warn('[store] store.json not found — building a local test package with a placeholder identity');

if (!fs.existsSync(path.join(desktopDir, 'build', 'appx', 'StoreLogo.png'))) {
  spawnSync(process.execPath, [path.join(desktopDir, 'scripts', 'make-store-assets.mjs')], { stdio: 'inherit' });
}

const out = `release/v${pkg.version}`;
const args = [
  'electron-builder', '--win', 'appx', '--x64',
  `-c.directories.output=${out}`,
  `-c.appx.identityName=${store.identityName}`,
  `-c.appx.publisher=${store.publisher}`,
  `-c.appx.publisherDisplayName=${store.publisherDisplayName}`,
];
const res = spawnSync('npx', args, { cwd: desktopDir, stdio: 'inherit', shell: true });
if (res.status !== 0) process.exit(res.status ?? 1);

// keep only the package next to the installer (electron-builder also leaves win-unpacked there)
fs.rmSync(path.join(desktopDir, out, 'win-unpacked'), { recursive: true, force: true });
for (const f of fs.readdirSync(path.join(desktopDir, out))) {
  if (/\.(yml|yaml|blockmap)$/.test(f) || f === 'builder-debug.yml') fs.rmSync(path.join(desktopDir, out, f), { force: true });
}
console.log(`[store] done: ${path.join(desktopDir, out)}`);
