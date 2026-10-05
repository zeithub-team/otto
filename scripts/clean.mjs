#!/usr/bin/env node
/**
 * Remove generated build output. `--deps` also removes node_modules.
 * Never touches sources, `.env`, `data/` or `workspace/`.
 */
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  'apps/web/.next',
  'apps/web/out',
  'apps/web/tsconfig.tsbuildinfo',
  'apps/desktop/dist',
  'apps/desktop/renderer',
  'apps/desktop/release',
  'apps/desktop/assets/.icon-build',
];
if (process.argv.includes('--deps')) {
  targets.push('node_modules', 'apps/web/node_modules', 'apps/desktop/node_modules');
}

for (const rel of targets) {
  try {
    rmSync(join(root, rel), { recursive: true, force: true });
    console.log(`[clean] ${rel}`);
  } catch (e) {
    console.error(`[clean] ${rel}: ${e.message}`);
    process.exitCode = 1;
  }
}
