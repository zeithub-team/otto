#!/usr/bin/env node
/**
 * Build a zeithub.otto release — works from PowerShell, cmd and Git Bash.
 *
 *   npm run release -- 0.1.9                     bump, test, build the installer (local only)
 *   npm run release -- 0.1.9 --store             … and the Microsoft Store package (.appx)
 *   npm run release -- 0.1.9 --publish           … then commit, tag, push to main, GitHub release
 *   npm run release -- 0.1.9 --store --publish
 *   npm run release -- 0.1.8 --publish --no-bump publish a version that is already bumped and built
 *
 * Before running: add the version's entry to apps/web/lib/changelog.ts — it becomes the release notes
 * and the "What's new" list in the app. Commit your feature changes first.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'zeithub-team/otto';
const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith('--')) ?? '';
const flags = new Set(args.filter((a) => a.startsWith('--')));
for (const f of flags) if (!['--store', '--publish', '--no-bump'].includes(f)) fail(`Unknown option ${f}`);
if (!/^\d+\.\d+\.\d+$/.test(version)) fail('Usage: npm run release -- <version, e.g. 0.1.9> [--store] [--publish] [--no-bump]');

const tag = `v${version}`;
const desktop = path.join(root, 'apps', 'desktop');
const out = path.join(desktop, 'release', tag);
const exe = path.join(out, `zeithub-otto-setup-${version}.exe`);
const appx = path.join(out, `zeithub-otto-${version}.appx`);

function fail(msg) { console.error(`\n✖ ${msg}`); process.exit(1); }
function step(msg) { console.log(`\n\x1b[1;32m==> ${msg}\x1b[0m`); }
/** Run a command (through the shell so npm/npx/gh .cmd files resolve on Windows); stop on failure. */
function run(cmd, opts = {}) {
  const r = spawnSync(cmd, { cwd: opts.cwd ?? root, stdio: opts.capture ? 'pipe' : 'inherit', shell: true, encoding: 'utf8' });
  if (r.status !== 0 && !opts.allowFail) fail(`Failed: ${cmd}${opts.capture ? `\n${r.stdout ?? ''}${r.stderr ?? ''}` : ''}`);
  return r;
}

// ------------------------------------------------------------------ checks --
step('Checks');
if (run(`git rev-parse -q --verify refs/tags/${tag}`, { capture: true, allowFail: true }).status === 0) fail(`Tag ${tag} already exists.`);
const changelog = fs.readFileSync(path.join(root, 'apps', 'web', 'lib', 'changelog.ts'), 'utf8');
const at = changelog.indexOf(`version: '${version}'`);
if (at < 0) fail(`No entry for ${version} in apps/web/lib/changelog.ts — add it first (version, date, items).`);
const block = changelog.slice(at, changelog.indexOf('],', at));
const items = [...block.matchAll(/^\s*'(.*)',?\s*$/gm)].map((m) => `- ${m[1].replace(/\\'/g, "'")}`);
if (!items.length) fail(`The ${version} entry in changelog.ts has no items.`);
console.log(items.join('\n'));
if (flags.has('--publish') && run('gh auth status', { capture: true, allowFail: true }).status !== 0) fail('gh is not signed in: run gh auth login');

// ----------------------------------------------------------------- version --
const pkgs = ['package.json', 'apps/desktop/package.json', 'apps/web/package.json'].map((p) => path.join(root, p));
if (!flags.has('--no-bump')) {
  step(`Version ${version}`);
  for (const f of pkgs) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/"version": "[^"]+"/, `"version": "${version}"`));
  run('npm install --no-audit --no-fund', { capture: true });
} else {
  const now = JSON.parse(fs.readFileSync(pkgs[1], 'utf8')).version;
  if (now !== version) fail(`--no-bump: apps/desktop/package.json is ${now}, not ${version}.`);
}

// ------------------------------------------------------------------- build --
step('Tests');
run('npm test', { cwd: desktop });

if (!fs.existsSync(exe) || !flags.has('--no-bump')) {
  step('Installer');
  run('npm run dist:local -w @otto/desktop');
}
if (!fs.existsSync(exe)) fail(`Installer not found: ${exe}`);

if (flags.has('--store')) {
  step('Microsoft Store package');
  run('node scripts/dist-store.mjs', { cwd: desktop });
  if (!fs.existsSync(appx)) fail(`Store package not found: ${appx}`);
}

if (!flags.has('--publish')) {
  step('Done (not published)');
  console.log(`Installer: ${exe}`);
  if (flags.has('--store')) console.log(`Store:     ${appx}`);
  console.log(`Publish: npm run release -- ${version} --publish --no-bump`);
  process.exit(0);
}

// ----------------------------------------------------------------- publish --
step('Commit, tag, push');
run(`git add package.json package-lock.json apps/desktop/package.json apps/web/package.json apps/web/lib/changelog.ts`);
if (run('git diff --cached --quiet', { allowFail: true }).status !== 0) run(`git commit -q -m "v${version}"`);
run(`git tag ${tag}`);
run('git push -q origin HEAD:main');
run(`git push -q origin ${tag}`);

step('GitHub release');
const notes = path.join(os.tmpdir(), `otto-notes-${version}.md`);
fs.writeFileSync(notes, [
  "### What's new", ...items, '', '---', '',
  `**Install:** download \`zeithub-otto-setup-${version}.exe\` and run it. The installer isn't code-signed yet — if SmartScreen warns you, choose *More info → Run anyway*.`,
].join('\n'));
run(`gh release create ${tag} "${exe}" --repo ${REPO} --title "zeithub.otto ${version}" --notes-file "${notes}" --latest`);
fs.rmSync(notes, { force: true });

step('Done');
console.log(`Release: https://github.com/${REPO}/releases/tag/${tag}`);
if (flags.has('--store')) console.log(`Store package for Partner Center: ${appx}`);
