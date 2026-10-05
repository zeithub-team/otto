/**
 * Build the Next.js frontend as a static export and copy it into
 * apps/desktop/renderer, where the packaged embedded server expects it.
 *
 * Usage: node scripts/build-renderer.mjs
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopDir, '..', '..');
const frontendDir = join(repoRoot, 'apps', 'web');
const outDir = join(frontendDir, 'out');
const rendererDir = join(desktopDir, 'renderer');

console.log('[renderer] building Next.js static export...');
const build = spawnSync('npm', ['run', 'build'], {
  cwd: frontendDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (build.status !== 0) {
  console.error('[renderer] next build failed');
  process.exit(build.status ?? 1);
}

if (!existsSync(outDir)) {
  console.error(`[renderer] expected output missing: ${outDir}`);
  process.exit(1);
}

console.log(`[renderer] copying ${outDir} -> ${rendererDir}`);
rmSync(rendererDir, { recursive: true, force: true });
cpSync(outDir, rendererDir, { recursive: true });

console.log('[renderer] done');
