/**
 * Checkpoints: what every file looked like before an agent run first touched it, so the whole run can
 * be undone from the "files changed" card.
 *
 * Kept in the project at `.otto/checkpoints/<run>.json` ({ path: old text, or null for a file the run
 * created }). Only the newest checkpoints are kept; binary and very large files are not saved, and a
 * run that touched one of them can be undone only partly (the restore says which files it skipped).
 */
import * as fs from 'fs';
import * as path from 'path';
import { isInside, relativePosix, resolvePath } from './paths';

const KEEP = 30;
const MAX_FILE = 1_000_000;
const MAX_TOTAL = 20_000_000;

interface Saved {
  run: string;
  created: number;
  /** Old content of each file; null = the file did not exist. */
  files: Record<string, string | null>;
  /** Files that changed but could not be saved (binary, too big, a whole folder). */
  skipped: string[];
}

const dirOf = (root: string): string => path.join(root, '.otto', 'checkpoints');
const safeRun = (run: string): string => run.replace(/[^\w.-]/g, '_').slice(0, 120);

export class Checkpoint {
  private readonly data: Saved;
  private total = 0;
  private dirty = false;

  constructor(private readonly root: string, run: string) {
    this.data = { run: safeRun(run), created: Date.now(), files: {}, skipped: [] };
  }

  get run(): string {
    return this.data.run;
  }

  /** Whether anything was saved (a run that changed nothing has no checkpoint). */
  get empty(): boolean {
    return Object.keys(this.data.files).length === 0 && this.data.skipped.length === 0;
  }

  /** Remember `rel` as it is now, before the first change of this run. Call before every write. */
  remember(rel: string): void {
    const target = resolvePath(path.resolve(this.root, rel));
    if (!isInside(this.root, target)) return;
    const key = relativePosix(this.root, target);
    if (key in this.data.files || this.data.skipped.includes(key) || key.startsWith('.otto/')) return;
    let stat: fs.Stats | null = null;
    try { stat = fs.statSync(target); } catch { stat = null; }
    if (!stat) {
      this.data.files[key] = null;
    } else if (stat.isFile() && stat.size <= MAX_FILE && this.total + stat.size <= MAX_TOTAL) {
      const buf = fs.readFileSync(target);
      if (buf.includes(0)) this.data.skipped.push(key);
      else {
        this.data.files[key] = buf.toString('utf8');
        this.total += stat.size;
      }
    } else if (stat.isDirectory()) {
      // a folder about to be deleted: save its text files one by one
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) this.remember(path.join(key, entry.name));
    } else {
      this.data.skipped.push(key);
    }
    this.dirty = true;
  }

  /** Drop `rel` again when the call did not change it after all (a refused or failed write). */
  settle(rel: string): void {
    const target = resolvePath(path.resolve(this.root, rel));
    if (!isInside(this.root, target)) return;
    const key = relativePosix(this.root, target);
    if (!(key in this.data.files)) return;
    const saved = this.data.files[key];
    let now: string | null = null;
    try { now = fs.statSync(target).isFile() ? fs.readFileSync(target, 'utf8') : null; } catch { now = null; }
    if (now === saved) {
      delete this.data.files[key];
      if (saved !== null) this.total -= Buffer.byteLength(saved);
    }
  }

  /** Write the checkpoint to disk (and drop the oldest ones). */
  save(): void {
    if (!this.dirty || this.empty) return;
    this.dirty = false;
    const dir = dirOf(this.root);
    fs.mkdirSync(dir, { recursive: true });
    // old copies of the project's files are not for git
    if (!fs.existsSync(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', 'utf8');
    fs.writeFileSync(path.join(dir, `${this.data.run}.json`), JSON.stringify(this.data), 'utf8');
    const old = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(KEEP);
    for (const { f } of old) fs.rmSync(path.join(dir, f), { force: true });
  }
}

export interface RestoreResult {
  restored: string[];
  removed: string[];
  skipped: string[];
}

/** Put every file of a run back as it was before the run; the checkpoint is used up. Null = none saved. */
export function restoreCheckpoint(root: string, run: string): RestoreResult | null {
  const file = path.join(dirOf(root), `${safeRun(run)}.json`);
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Saved;
  const result: RestoreResult = { restored: [], removed: [], skipped: [...(data.skipped ?? [])] };
  for (const [rel, content] of Object.entries(data.files)) {
    const target = resolvePath(path.resolve(root, rel));
    if (!isInside(root, target) || target === resolvePath(root)) continue;
    if (content === null) {
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        fs.rmSync(target, { force: true });
        result.removed.push(rel);
        // folders the run created for it go too, while they are empty
        let dir = path.dirname(target);
        while (isInside(root, dir) && resolvePath(dir) !== resolvePath(root)) {
          try { fs.rmdirSync(dir); } catch { break; }
          dir = path.dirname(dir);
        }
      }
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
      result.restored.push(rel);
    }
  }
  fs.rmSync(file, { force: true });
  return result;
}

/** Whether a run can still be undone. */
export function hasCheckpoint(root: string, run: string): boolean {
  return fs.existsSync(path.join(dirOf(root), `${safeRun(run)}.json`));
}
