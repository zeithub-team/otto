/**
 * Project index — the "indexing" of an IDE: every file of a project is scanned
 * once, kept in memory (file list, symbols, identifiers) and updated
 * incrementally from a file watcher. Everything that used to walk and parse the
 * whole project on each keystroke (Ctrl+T, go to definition) or that an IDE
 * shows instantly (Ctrl+P quick open, code completion) reads from here.
 *
 * Symbols come from symbols.ts (regex + scope tracking, no native parsers);
 * identifiers give word completion and the fuzzy "words in project" fallback.
 */
import * as fs from 'fs';
import * as path from 'path';
import { projectSkipDirs, relativePosix } from './paths';
import { bufferToText, MAX_TEXT_FILE_SIZE } from './filesearch';
import { isMinified, parseFile, type CodeSymbol } from './symbols';

const GENERATED_DIRS = ['dist', 'build', 'out', 'coverage'];
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'svgz', 'pdf', 'zip', 'gz', 'tgz', '7z', 'rar', 'tar', 'jar', 'war',
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'o', 'a', 'lib', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'avi',
  'webm', 'wav', 'ogg', 'sqlite', 'db', 'lock', 'map', 'phar', 'pyc',
]);
const MAX_WORDS_PER_FILE = 4000;
const YIELD_EVERY = 40;
const WORD_RE = /[\p{L}_$][\p{L}\p{N}_$]{2,}/gu;

export interface IndexedFile {
  path: string;
  size: number;
  mtimeMs: number;
  symbols: CodeSymbol[];
  words: string[];
}

export type CompletionKind = 'class' | 'interface' | 'function' | 'method' | 'type' | 'variable';

export interface Completion {
  label: string;
  kind: CompletionKind;
  /** File of a symbol, or "×N" for a plain word. */
  detail?: string;
  score: number;
}

export interface QuickOpenHit {
  path: string;
  score: number;
  /** Indexes of the matched characters in `path` (for highlighting). */
  positions: number[];
}

/** Distinct identifiers of a text (bounded). */
export function extractWords(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(WORD_RE)) {
    out.add(m[0]);
    if (out.size >= MAX_WORDS_PER_FILE) break;
  }
  return [...out];
}

const isBoundary = (prev: string, ch: string): boolean =>
  prev === '' || '/\\._- $'.includes(prev) || (prev === prev.toLowerCase() && prev !== prev.toUpperCase() && ch === ch.toUpperCase() && ch !== ch.toLowerCase());

/** Subsequence match with IDE-style scoring (word starts, camelCase humps, consecutive runs, file name first). */
export function fuzzyMatch(query: string, target: string): { score: number; positions: number[] } | null {
  const q = query.toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const t = target.toLowerCase();
  const base = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\')) + 1;

  const run = (from: number): { score: number; positions: number[] } | null => {
    const positions: number[] = [];
    let ti = from;
    let score = 0;
    let last = -2;
    for (let qi = 0; qi < q.length; qi++) {
      let found = -1;
      for (let i = ti; i < t.length; i++) {
        if (t[i] === q[qi]) { found = i; break; }
      }
      if (found < 0) return null;
      if (found === last + 1) score += 8; // consecutive
      if (isBoundary(found === 0 ? '' : target[found - 1], target[found])) score += 10;
      if (found === base) score += 15; // first letter of the file name
      score -= (found - (last + 1)) * 0.3; // gaps
      positions.push(found);
      last = found;
      ti = found + 1;
    }
    return { score: score - target.length * 0.05, positions };
  };

  const inName = run(base);
  const anywhere = run(0);
  if (inName && (!anywhere || inName.score + 25 >= anywhere.score)) return { score: inName.score + 25, positions: inName.positions };
  return anywhere;
}

const KIND_BONUS: Record<CompletionKind, number> = { class: 30, interface: 26, type: 22, function: 24, method: 24, variable: 0 };
const SELF_NAMES = new Set(['this', 'self', '$this', 'static']);

export class ProjectIndex {
  readonly root: string;
  private files = new Map<string, IndexedFile>();
  private wordFreq = new Map<string, number>();
  private version = 0;
  private cache: { version: number; symbols?: CodeSymbol[]; list?: string[] } = { version: -1 };
  private skip: Set<string>;
  private watcher: fs.FSWatcher | null = null;
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private buildPromise: Promise<void> | null = null;
  private lastFullCheck = 0;
  ready = false;
  watching = false;

  constructor(root: string) {
    this.root = root;
    this.skip = projectSkipDirs(root);
    GENERATED_DIRS.forEach((d) => this.skip.add(d));
  }

  // ------------------------------------------------------------- building --

  /** Scan the project once; resolves when the index is usable. Safe to call repeatedly. */
  ensure(): Promise<void> {
    if (!this.buildPromise) {
      this.buildPromise = this.build().then(() => {
        this.ready = true;
        this.startWatching();
      });
    }
    return this.buildPromise;
  }

  /** Drop everything and scan again. */
  async rebuild(): Promise<void> {
    this.files.clear();
    this.wordFreq.clear();
    this.version++;
    this.ready = false;
    this.buildPromise = null;
    this.skip = projectSkipDirs(this.root);
    GENERATED_DIRS.forEach((d) => this.skip.add(d));
    await this.ensure();
  }

  private async build(): Promise<void> {
    let counter = 0;
    const walk = async (folder: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(folder, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          if (this.skip.has(entry.name)) continue;
          await walk(full);
        } else if (entry.isFile()) {
          if (entry.name.startsWith('.aider') || /\.(log|bak)$/.test(entry.name)) continue;
          await this.indexFile(full);
          if (++counter % YIELD_EVERY === 0) await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    };
    await walk(this.root);
  }

  private removeWords(file: IndexedFile | undefined): void {
    if (!file) return;
    for (const w of file.words) {
      const n = (this.wordFreq.get(w) ?? 0) - 1;
      if (n > 0) this.wordFreq.set(w, n);
      else this.wordFreq.delete(w);
    }
  }

  /** (Re)read one file into the index. */
  private async indexFile(full: string): Promise<void> {
    const rel = relativePosix(this.root, full);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(full);
    } catch {
      this.removePath(rel);
      return;
    }
    if (!stat.isFile()) return;
    const old = this.files.get(rel);
    if (old && old.mtimeMs === stat.mtimeMs && old.size === stat.size) return; // unchanged

    const ext = rel.split('.').pop()?.toLowerCase() ?? '';
    let symbols: CodeSymbol[] = [];
    let words: string[] = [];
    if (!BINARY_EXT.has(ext) && stat.size <= MAX_TEXT_FILE_SIZE) {
      try {
        const text = bufferToText(await fs.promises.readFile(full));
        if (text !== null && !isMinified(text)) {
          symbols = parseFile(rel, text);
          words = extractWords(text);
        }
      } catch {
        /* unreadable (locked / just deleted): listed without content */
      }
    }
    this.removeWords(old);
    for (const w of words) this.wordFreq.set(w, (this.wordFreq.get(w) ?? 0) + 1);
    this.files.set(rel, { path: rel, size: stat.size, mtimeMs: stat.mtimeMs, symbols, words });
    this.version++;
  }

  private removePath(rel: string): void {
    const drop = (key: string): void => {
      this.removeWords(this.files.get(key));
      this.files.delete(key);
    };
    if (this.files.has(rel)) drop(rel);
    const prefix = `${rel}/`;
    for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) drop(key);
    this.version++;
  }

  /** Re-read the given project-relative paths (files or folders); used by the watcher and by tests. */
  async updatePaths(rels: string[]): Promise<void> {
    for (const rel of rels) {
      const norm = rel.replace(/\\/g, '/');
      if (!norm || norm.split('/').some((seg) => this.skip.has(seg))) continue;
      const full = path.join(this.root, norm);
      let stat: fs.Stats | null = null;
      try {
        stat = await fs.promises.stat(full);
      } catch {
        stat = null;
      }
      if (!stat) this.removePath(norm);
      else if (stat.isDirectory()) await this.rescanDir(full);
      else await this.indexFile(full);
    }
  }

  private async rescanDir(folder: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!this.skip.has(entry.name)) await this.rescanDir(full);
      } else if (entry.isFile()) {
        await this.indexFile(full);
      }
    }
  }

  private startWatching(): void {
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        this.dirty.add(String(filename));
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          const batch = [...this.dirty];
          this.dirty.clear();
          void this.updatePaths(batch);
        }, 150);
      });
      this.watcher.on('error', () => { this.watching = false; });
      this.watching = true;
    } catch {
      this.watching = false; // no recursive watch here: queries revalidate by mtime instead
    }
  }

  /** Without a watcher, cheaply re-check mtimes (throttled) so results never go stale. */
  async freshen(): Promise<void> {
    await this.ensure();
    if (this.watching || Date.now() - this.lastFullCheck < 3000) return;
    this.lastFullCheck = Date.now();
    await this.rescanDir(this.root);
    for (const rel of [...this.files.keys()]) {
      if (!fs.existsSync(path.join(this.root, rel))) this.removePath(rel);
    }
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
  }

  // -------------------------------------------------------------- queries --

  get stats(): { files: number; symbols: number; words: number; ready: boolean; watching: boolean } {
    return { files: this.files.size, symbols: this.allSymbols().length, words: this.wordFreq.size, ready: this.ready, watching: this.watching };
  }

  private fresh(): void {
    if (this.cache.version !== this.version) this.cache = { version: this.version };
  }

  /** Every file of the project, sorted. */
  listFiles(): string[] {
    this.fresh();
    return (this.cache.list ??= [...this.files.keys()].sort());
  }

  allSymbols(): CodeSymbol[] {
    this.fresh();
    return (this.cache.symbols ??= [...this.files.values()].flatMap((f) => f.symbols));
  }

  symbolsOf(rel: string): CodeSymbol[] {
    return this.files.get(rel)?.symbols ?? [];
  }

  /** Ctrl+P: fuzzy file search. */
  quickOpen(query: string, limit = 50): QuickOpenHit[] {
    const q = query.trim();
    const all = this.listFiles();
    if (!q) return all.slice(0, limit).map((p) => ({ path: p, score: 0, positions: [] }));
    const hits: QuickOpenHit[] = [];
    for (const p of all) {
      const m = fuzzyMatch(q, p);
      if (m) hits.push({ path: p, score: m.score, positions: m.positions });
    }
    hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
    return hits.slice(0, limit);
  }

  /** Ctrl+T: symbols by name — substring or camelCase/fuzzy. */
  searchSymbols(query: string, limit = 100): CodeSymbol[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const rank: Record<CodeSymbol['kind'], number> = { class: 0, interface: 1, method: 2, function: 3, type: 4 };
    const scored: Array<{ s: CodeSymbol; rank: number }> = [];
    for (const s of this.allSymbols()) {
      const name = s.name.toLowerCase();
      let r = -1;
      if (name.startsWith(q)) r = 0;
      else if (name.includes(q)) r = 1;
      else if (q.length >= 2 && fuzzyMatch(q, s.name)) r = 2;
      if (r >= 0) scored.push({ s, rank: r });
    }
    scored.sort((a, b) => a.rank - b.rank || rank[a.s.kind] - rank[b.s.kind] || a.s.name.length - b.s.name.length || a.s.path.localeCompare(b.s.path) || a.s.line - b.s.line);
    return scored.slice(0, limit).map((x) => x.s);
  }

  /** Class that encloses `line` of `rel` (nearest class-like symbol above it). */
  private classAt(rel: string, line: number): string | undefined {
    let best: CodeSymbol | undefined;
    for (const s of this.symbolsOf(rel)) {
      if ((s.kind === 'class' || s.kind === 'interface') && s.line <= line && (!best || s.line > best.line)) best = s;
    }
    return best?.name;
  }

  /**
   * Completion candidates. After `obj.` / `$this->` / `Foo::` (`container`) only the members of
   * that class; otherwise symbols and identifiers of the project ranked by how well they
   * match, kind, frequency and whether they live in the current file.
   */
  complete(o: { path?: string; line?: number; prefix: string; container?: string; limit?: number }): Completion[] {
    const limit = Math.min(Math.max(o.limit ?? 40, 1), 200);
    const prefix = o.prefix ?? '';
    const lower = prefix.toLowerCase();

    // ---- member access
    if (o.container) {
      let cls = o.container;
      if (SELF_NAMES.has(cls)) cls = (o.path && o.line ? this.classAt(o.path, o.line) : undefined) ?? '';
      if (cls) {
        const classNames = new Set(this.allSymbols().filter((s) => s.kind === 'class' || s.kind === 'interface').map((s) => s.name));
        // `userService.` → UserService when the variable is named after its class
        const guess = [cls, cls[0].toUpperCase() + cls.slice(1)].find((c) => classNames.has(c));
        const target = guess ?? cls;
        const members = this.allSymbols().filter((s) => s.container === target && (s.kind === 'method' || s.kind === 'function'));
        if (members.length) {
          const seen = new Set<string>();
          const out: Completion[] = [];
          for (const m of members) {
            if (seen.has(m.name)) continue;
            const hit = lower ? (m.name.toLowerCase().startsWith(lower) ? 100 : fuzzyMatch(lower, m.name) ? 50 : -1) : 100;
            if (hit < 0) continue;
            seen.add(m.name);
            out.push({ label: m.name, kind: 'method', detail: `${target} · ${m.path}`, score: hit });
          }
          return out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, limit);
        }
      }
    }
    if (prefix.length === 0) return [];

    // ---- identifiers and symbols
    const own = new Set(o.path ? this.files.get(o.path)?.words : undefined);
    const out = new Map<string, Completion>();
    const consider = (label: string, kind: CompletionKind, detail: string | undefined, freq: number): void => {
      if (label === prefix || label.length < prefix.length) return;
      let base: number;
      if (label.startsWith(prefix)) base = 1000;
      else if (label.toLowerCase().startsWith(lower)) base = 900;
      else if (prefix.length >= 2 && fuzzyMatch(prefix, label)) base = 500;
      else return;
      const score = base + KIND_BONUS[kind] + (own.has(label) ? 60 : 0) + Math.log2(freq + 1) * 5 - label.length * 0.2;
      const prev = out.get(label);
      if (!prev || prev.score < score || (kind !== 'variable' && prev.kind === 'variable')) out.set(label, { label, kind, detail, score });
    };
    for (const s of this.allSymbols()) consider(s.name, s.kind, s.path, this.wordFreq.get(s.name) ?? 1);
    for (const [w, n] of this.wordFreq) consider(w, 'variable', n > 1 ? `×${n}` : undefined, n);
    return [...out.values()].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, limit);
  }
}

// ------------------------------------------------------------- registry ----

const indexes = new Map<string, ProjectIndex>();
const MAX_INDEXES = 6;

/** The (shared, lazily built) index of a project folder. */
export function getIndex(root: string): ProjectIndex {
  const key = path.resolve(root);
  let idx = indexes.get(key);
  if (idx) {
    indexes.delete(key); // refresh LRU order
    indexes.set(key, idx);
    return idx;
  }
  idx = new ProjectIndex(key);
  indexes.set(key, idx);
  while (indexes.size > MAX_INDEXES) {
    const oldest = indexes.keys().next().value as string;
    indexes.get(oldest)?.close();
    indexes.delete(oldest);
  }
  return idx;
}

/** The index of `root` if it is already built (sync callers use it, else fall back to a scan). */
export function readyIndex(root: string): ProjectIndex | null {
  const idx = indexes.get(path.resolve(root));
  return idx && idx.ready ? idx : null;
}

export function closeAllIndexes(): void {
  for (const idx of indexes.values()) idx.close();
  indexes.clear();
}
