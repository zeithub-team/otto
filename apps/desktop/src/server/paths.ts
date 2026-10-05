/**
 * Path policy of the embedded otto server.
 *
 * Desktop port of `backend/utils/path_utils.py` + the path helpers from
 * `backend/api/files.py`, with the deliberate difference that a project may
 * now live anywhere on disk: the only rule left is that file operations never
 * leave the project root.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Db } from './db';
import { errorMessage, HttpError } from './http';

export { HttpError, errorMessage } from './http';

/** Directories hidden from every listing / search, whatever the project type. */
export const SKIP_DIRS = ['.git', '.next', 'node_modules', '.venv'];

/** Tooling caches and editor state — never project content. */
const COMMON_SKIP = [
  ...SKIP_DIRS, 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.cache', '.turbo', '.output', '.idea', '.vscode', '.gradle', '.dart_tool',
];

/** Generated/dependency folders per project type, detected by marker files. */
const STACK_SKIP: Array<{ markers: string[]; dirs: string[] }> = [
  { markers: ['package.json'], dirs: ['dist', 'build', 'out', 'coverage', '.nuxt', '.svelte-kit'] },
  { markers: ['composer.json'], dirs: ['vendor'] },
  { markers: ['Cargo.toml'], dirs: ['target'] },
  { markers: ['go.mod'], dirs: ['vendor'] },
  { markers: ['pom.xml', 'build.gradle', 'build.gradle.kts'], dirs: ['target', 'build', 'out'] },
  { markers: ['pubspec.yaml'], dirs: ['build'] },
  { markers: ['pyproject.toml', 'requirements.txt', 'setup.py'], dirs: ['dist', 'build', '.tox'] },
];

/**
 * Folders to hide in the explorer and skip in searches for the project at
 * `root`: common junk plus what the detected stack generates
 * (node_modules/dist for Node, vendor for PHP/Go, target for Rust/Java, …).
 */
export function projectSkipDirs(root: string): Set<string> {
  const skip = new Set(COMMON_SKIP);
  for (const { markers, dirs } of STACK_SKIP) {
    if (markers.some((m) => fs.existsSync(path.join(root, m)))) dirs.forEach((d) => skip.add(d));
  }
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    /* unreadable root — the caller reports it */
  }
  if (names.some((n) => /\.(sln|csproj)$/i.test(n))) ['bin', 'obj', 'packages'].forEach((d) => skip.add(d));
  return skip;
}

/**
 * Resolve a path the way `pathlib.Path.resolve()` does: absolute, normalised
 * and with symlinks followed for the existing part of the path (non-existing
 * tails are appended as-is instead of failing).
 */
export function resolvePath(target: string): string {
  let current = path.resolve(target);
  const suffix: string[] = [];
  for (;;) {
    try {
      let base = fs.realpathSync(current);
      // suffix is kept outermost-first (unshift), so append in that order
      for (const part of suffix) base = path.join(base, part);
      return base;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return suffix.length ? path.join(current, ...suffix) : current;
      }
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** `Path.expanduser()` — `~` / `~/…` → the user's home directory. */
export function expandUser(target: string): string {
  if (target === '~') return os.homedir();
  if (target.startsWith('~/') || target.startsWith('~\\')) {
    return path.join(os.homedir(), target.slice(2));
  }
  return target;
}

/**
 * True when `target` is `root` itself or lives inside it.
 * Compared with the platform separator, so `root` + `evil` never matches.
 */
export function isInside(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  if (process.platform === 'win32') {
    const a = normalizedRoot.toLowerCase();
    const b = normalizedTarget.toLowerCase();
    if (a === b) return true;
    const prefix = a.endsWith(path.sep) ? a : a + path.sep;
    return b.startsWith(prefix);
  }
  if (normalizedRoot === normalizedTarget) return true;
  const prefix = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;
  return normalizedTarget.startsWith(prefix);
}

/**
 * Join `relative` onto `root` and make sure the result stays inside `root`.
 * Returns `null` when the path escapes the project (`..`, absolute path, …).
 */
export function resolveInside(root: string, relative: string): string | null {
  const resolved = resolvePath(path.resolve(root, relative));
  return isInside(root, resolved) ? resolved : null;
}

/** Directory check that never throws. */
export function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** File check that never throws. */
export function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** `/`-separated path relative to the project root (Python's `as_posix()`). */
export function relativePosix(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}

/** Fixed drive letters on Windows (`C:\`, `D:\`, …); `/` elsewhere. */
export function listDrives(): string[] {
  if (process.platform !== 'win32') return ['/'];
  const drives: string[] = [];
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\`;
    try {
      fs.readdirSync(root);
      drives.push(root);
    } catch {
      /* drive not present */
    }
  }
  return drives;
}

/**
 * `get_project_root()` from `backend/api/files.py`.
 * Returns the resolved project folder or throws an `HttpError`.
 */
export function resolveProjectRoot(db: Db, projectId: number): string {
  let rowPath: string | null;
  try {
    rowPath = db.getProjectPath(projectId);
  } catch (exc) {
    throw new HttpError(500, `Database error: ${errorMessage(exc)}`);
  }
  if (rowPath === null) {
    throw new HttpError(404, 'Project not found');
  }
  const root = resolvePath(rowPath);
  if (!isDirectory(root)) {
    throw new HttpError(
      400,
      'Project folder must be an existing directory inside /workspace',
    );
  }
  return root;
}

/**
 * `resolve_project_file()` from `backend/api/files.py`.
 * Resolves `relativePath` inside the project root or throws an `HttpError`.
 */
export function resolveProjectFile(
  db: Db,
  projectId: number,
  relativePath = '',
): { root: string; file: string } {
  const root = resolveProjectRoot(db, projectId);
  let candidate: string | null;
  try {
    candidate = resolveInside(root, relativePath);
  } catch {
    throw new HttpError(400, 'Invalid path');
  }
  if (candidate === null) {
    throw new HttpError(400, 'Path is outside the project');
  }
  return { root, file: candidate };
}
