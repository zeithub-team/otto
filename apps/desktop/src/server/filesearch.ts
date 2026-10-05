/**
 * Find & replace in project files — the backend behind the Search view
 * (JetBrains "Find in Path / Replace in Path").
 *
 * Search returns matches grouped by file (`path → [{line, col, text}]`);
 * replace applies a query→replacement across the whole project (mass) or a
 * caller-supplied scope (single file / selected lines). Guards mirror
 * `search_files` in ollama.ts: VCS/build dirs, tooling noise, binaries and
 * mojibake are never scanned; unreadable files are skipped, not fatal.
 */
import * as fs from 'fs';
import * as path from 'path';
import { isFile, isInside, projectSkipDirs, relativePosix, resolvePath } from './paths';

export interface SearchOptions {
  query: string;
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  /** Comma-separated masks: `*.{ts,tsx}`, `*.ts`, `src/**`, `*`. Empty = all. */
  mask?: string;
}

export interface SearchMatch {
  line: number;
  col: number;
  text: string;
}

export interface SearchFileResult {
  path: string;
  matches: SearchMatch[];
}

export interface SearchResult {
  files: SearchFileResult[];
  totalMatches: number;
  totalFiles: number;
  truncated: boolean;
}

export interface ReplaceScope {
  path: string;
  /** 1-based lines; omitted = every matching line in the file. */
  lines?: number[];
}

export interface ReplaceOptions extends SearchOptions {
  replacement: string;
  /** Omitted = every file that matches (mass replace). */
  scope?: ReplaceScope[];
}

export interface ReplaceFileResult {
  path: string;
  replaced: number;
}

export interface ReplaceResult {
  files: ReplaceFileResult[];
  totalReplaced: number;
  totalFiles: number;
}

/** Build output skipped in searches even when the stack is not detected. */
const GENERATED_DIRS = ['dist', 'build', 'out', 'coverage'];

const MAX_FILE_SIZE = 1_000_000;
const MAX_RESULT_FILES = 100;
const MAX_RESULT_MATCHES = 1000;
const MAX_MATCHES_PER_FILE = 100;

/** Compile the query once; throws a human-readable RU error on bad regex. */
export function buildSearchRegExp(opts: SearchOptions): RegExp {
  const q = (opts.query ?? '').trim();
  if (!q) throw new Error('Пустой поисковый запрос.');
  let src = q;
  if (!opts.regex) src = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.wholeWord) {
    // \b is ASCII-only — Cyrillic words need explicit boundaries.
    src = `(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])`;
  }
  const flags = opts.caseSensitive ? 'gu' : 'gui';
  try {
    return new RegExp(src, flags);
  } catch {
    throw new Error('Некорректное регулярное выражение.');
  }
}

/** Split a mask list on commas, ignoring commas inside `{…}` groups. */
function splitMasks(mask: string | undefined): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of mask ?? '') {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function maskMatch(rel: string, mask: string | undefined): boolean {
  const pats = splitMasks(mask);
  if (!pats.length) return true;
  const base = rel.split('/').pop() ?? rel;
  const lowerBase = base.toLowerCase();
  const lowerRel = rel.toLowerCase();
  return pats.some((p) => {
    if (p === '*' || p === '*.*') return true;
    const group = /^\*\.\{([^}]+)\}$/.exec(p);
    if (group) {
      const exts = group[1].split(',').map((s) => s.trim().toLowerCase());
      const dot = lowerBase.lastIndexOf('.');
      const ext = dot >= 0 ? lowerBase.slice(dot + 1) : '';
      return exts.includes(ext);
    }
    if (p.startsWith('*.')) return lowerBase.endsWith(p.slice(1).toLowerCase());
    if (p.endsWith('/**') || p.endsWith('/*')) {
      const pre = p.replace(/\/\*\*?$/, '');
      return lowerRel === pre.toLowerCase() || lowerRel.startsWith(pre.toLowerCase() + '/');
    }
    return lowerRel.includes(p.toLowerCase());
  });
}

/** Read a file as UTF-8 text, or null for binary/oversized/unreadable. Shared with symbols.ts. */
export function readTextFile(full: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return null;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(full);
  } catch {
    return null;
  }
  return bufferToText(buf);
}

/** UTF-8 text of a file's bytes, or null for binary / mojibake. */
export function bufferToText(buf: Buffer): string | null {
  if (buf.includes(0)) return null; // binary
  const text = buf.toString('utf8');
  const bad = (text.match(/\uFFFD/g) || []).length;
  if (bad > text.length * 0.01) return null; // mojibake soup
  return text;
}

export const MAX_TEXT_FILE_SIZE = MAX_FILE_SIZE;

/** Depth-first file walk skipping junk for the detected project type. */
function walkFiles(root: string, visit: (full: string) => boolean): void {
  const skip = projectSkipDirs(root);
  GENERATED_DIRS.forEach((d) => skip.add(d));
  const visitDir = (folder: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return true;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        if (!visitDir(full)) return false;
      } else if (entry.isFile()) {
        if (entry.name.startsWith('.aider') || /\.(log|bak)$/.test(entry.name)) continue;
        if (!visit(full)) return false;
      }
    }
    return true;
  };
  visitDir(root);
}

function lineMatches(lineText: string, re: RegExp): Array<{ col: number }> {
  const out: Array<{ col: number }> = [];
  re.lastIndex = 0;
  for (const m of lineText.matchAll(re)) {
    out.push({ col: (m.index ?? 0) + 1 });
    if (out.length >= MAX_MATCHES_PER_FILE) break;
    // Zero-length matches would loop forever — advance manually.
    if (m[0] === '') re.lastIndex += 1;
  }
  re.lastIndex = 0;
  return out;
}

/** Find `query` in every scanned file; results grouped per file. */
export function searchContent(root: string, opts: SearchOptions): SearchResult {
  const re = buildSearchRegExp(opts);
  const files: SearchFileResult[] = [];
  let totalMatches = 0;
  let truncated = false;
  walkFiles(root, (full) => {
    const rel = relativePosix(root, full);
    if (!maskMatch(rel, opts.mask)) return true;
    const text = readTextFile(full);
    if (text === null) return true;
    const matches: SearchMatch[] = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (totalMatches + matches.length >= MAX_RESULT_MATCHES || matches.length >= MAX_MATCHES_PER_FILE) {
        truncated = true;
        break;
      }
      for (const m of lineMatches(lines[i], re)) {
        matches.push({ line: i + 1, col: m.col, text: lines[i].trim().slice(0, 240) });
        totalMatches++;
        if (totalMatches >= MAX_RESULT_MATCHES || matches.length >= MAX_MATCHES_PER_FILE) {
          truncated = true;
          break;
        }
      }
    }
    if (matches.length) {
      files.push({ path: rel, matches });
      if (files.length >= MAX_RESULT_FILES || totalMatches >= MAX_RESULT_MATCHES) {
        truncated = files.length >= MAX_RESULT_FILES || truncated;
        return false;
      }
    }
    return true;
  });
  return { files, totalMatches, totalFiles: files.length, truncated };
}

function safeTarget(root: string, rel: string): string | null {
  if (!rel || rel.includes('\0')) return null;
  const target = resolvePath(path.resolve(root, rel));
  if (!isInside(root, target) || !isFile(target)) return null;
  return target;
}

/**
 * Replace `query` with `replacement` (`$1`-groups supported, like JetBrains).
 * No scope = mass replace over a fresh search; scope entries narrow it to one
 * file or to selected 1-based lines (single replace).
 */
export function replaceInFiles(root: string, opts: ReplaceOptions): ReplaceResult {
  const re = buildSearchRegExp(opts);
  const replacement = opts.replacement ?? '';
  const results: ReplaceFileResult[] = [];
  let totalReplaced = 0;

  const applyToFile = (rel: string, onlyLines?: Set<number>): void => {
    const target = safeTarget(root, rel);
    if (!target) return;
    const text = readTextFile(target);
    if (text === null) return;
    re.lastIndex = 0;
    if (!onlyLines) {
      const count = (text.match(re) ?? []).length;
      re.lastIndex = 0;
      if (!count) return;
      re.lastIndex = 0;
      fs.writeFileSync(target, text.replace(re, replacement), 'utf8');
      results.push({ path: rel, replaced: count });
      totalReplaced += count;
      return;
    }
    const lines = text.split('\n');
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!onlyLines.has(i + 1)) continue;
      re.lastIndex = 0;
      const hits = (lines[i].match(re) ?? []).length;
      re.lastIndex = 0;
      if (!hits) continue;
      re.lastIndex = 0;
      lines[i] = lines[i].replace(re, replacement);
      count += hits;
    }
    if (!count) return;
    fs.writeFileSync(target, lines.join('\n'), 'utf8');
    results.push({ path: rel, replaced: count });
    totalReplaced += count;
  };

  if (opts.scope && opts.scope.length) {
    for (const s of opts.scope) {
      const lines = Array.isArray(s.lines) && s.lines.length
        ? new Set(s.lines.filter((n) => Number.isInteger(n) && n > 0))
        : undefined;
      applyToFile(s.path, lines);
    }
  } else {
    const found = searchContent(root, opts);
    for (const f of found.files) applyToFile(f.path);
  }
  return { files: results, totalReplaced, totalFiles: results.length };
}
