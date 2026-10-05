#!/usr/bin/env node
/**
 * Post-build organizer: gathers electron-builder artifacts from `release\`
 * into a version folder `release\v<version>\`, so the release directory
 * always contains one folder per app version (no release2/release3 clutter).
 *
 * Wired after electron-builder in the `dist:win` script:
 *   electron-builder --win nsis && node scripts/release.mjs
 *
 * If a file is locked (e.g. zeithub.otto is running FROM the version folder),
 * the message says exactly what to close and what to re-run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(desktopDir, 'release');
const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
const versionFolder = `v${pkg.version}`;
const target = path.join(releaseDir, versionFolder);

if (!fs.existsSync(releaseDir)) {
  console.error('[release] release\\ не найден — сначала соберите installer.');
  process.exit(1);
}
fs.mkdirSync(target, { recursive: true });

/** Move `name` from release\ into the version folder, replacing an older copy. */
function moveIntoTarget(name) {
  const src = path.join(releaseDir, name);
  const dst = path.join(target, name);
  if (!fs.existsSync(src)) return false;
  // Stage the source FIRST: if it is locked (e.g. the app runs from it), this
  // throws before anything is touched — a failed move can never lose a build.
  const staging = path.join(releaseDir, `.staging-${name}`);
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  fs.renameSync(src, staging);
  try {
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
  } catch (e) {
    fs.renameSync(staging, src); // restore, then report
    throw e;
  }
  fs.renameSync(staging, dst);
  return true;
}

const artifacts = fs.readdirSync(releaseDir).filter((n) => {
  if (n === versionFolder) return false;            // never touch version folders
  return (
    n === 'win-unpacked' ||
    n.endsWith('.exe') ||
    n.endsWith('.blockmap') ||
    n.endsWith('.yml') ||
    n.endsWith('.yaml')
  );
});

const moved = [];
const failed = [];
for (const name of artifacts) {
  try {
    if (moveIntoTarget(name)) moved.push(name);
  } catch (e) {
    failed.push(`${name} — ${e.message}`);
  }
}

if (moved.length) console.log(`[release] release\\${versionFolder}\\ ← ${moved.join(', ')}`);
if (failed.length) {
  console.error('[release] Не переместилось (файл занят — закройте zeithub.otto, запущенный из release\\, и повторите):');
  for (const f of failed) console.error('  - ' + f);
  console.error(`[release] Готово вручную: node ${path.join('scripts', 'release.mjs').replace(/\\/g, '\\\\')}`);
  process.exit(1);
}
console.log(
  moved.length
    ? `[release] Готово: release\\${versionFolder}\\`
    : `[release] Собирать нечего — release\\ уже разложена по версиям.`,
);
