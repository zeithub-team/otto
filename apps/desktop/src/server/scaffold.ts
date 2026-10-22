/**
 * Scaffolders that insist on an empty folder (`composer create-project laravel/laravel .`,
 * `npx create-next-app .`, `npm create vite@latest .`) fail when the agent has already written files
 * there (docker-compose.yml, .env, a Dockerfile). Instead of making the model clean up, Otto moves the
 * existing files aside, runs the scaffolder in the empty folder and puts the files back. A file the
 * scaffolder also created keeps the framework's version; the agent's one is saved next to it as
 * `<name>.otto-before` and the result says so.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCAFFOLD = /\b(composer\s+create-project\s+\S+|npx\s+(?:--yes\s+|-y\s+)?create-[\w@.-]+|npm\s+create\s+[\w@.-]+|npm\s+init\s+[\w@.-]+|pnpm\s+create\s+[\w@.-]+|yarn\s+create\s+[\w@.-]+|laravel\s+new)\s+\.(?=\s|$|;|&)/i;
const KEEP_IN_PLACE = new Set(['.git', '.otto', 'node_modules']);

export function isScaffoldIntoHere(command: string): boolean {
  return SCAFFOLD.test(command);
}

function movable(root: string): string[] {
  try { return fs.readdirSync(root).filter((n) => !KEEP_IN_PLACE.has(n)); } catch { return []; }
}

function moveTree(from: string, to: string): void {
  try { fs.renameSync(from, to); } catch {
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/** Run `run()` with the folder emptied for a scaffolder, then restore what was there. */
export async function withScaffoldRoom<T extends { output: string }>(root: string, command: string, run: () => Promise<T>): Promise<T> {
  const names = isScaffoldIntoHere(command) ? movable(root) : [];
  if (!names.length) return run();
  const stash = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-scaffold-'));
  for (const n of names) moveTree(path.join(root, n), path.join(stash, n));
  let note = '';
  let result: T;
  try {
    result = await run();
  } finally {
    const kept: string[] = [];
    for (const n of names) {
      const back = path.join(root, n);
      if (fs.existsSync(back)) { moveTree(path.join(stash, n), `${back}.otto-before`); kept.push(n); }
      else moveTree(path.join(stash, n), back);
    }
    fs.rmSync(stash, { recursive: true, force: true });
    note = kept.length
      ? `Otto moved the existing files aside for the scaffolder and put them back. These were also created by it — the framework's version is kept, yours is saved as <name>.otto-before: ${kept.join(', ')}. Merge what you need from them.`
      : 'Otto moved the existing files aside for the scaffolder and put them back unchanged.';
  }
  return { ...result, output: `${result.output}\n\n[${note}]` };
}
