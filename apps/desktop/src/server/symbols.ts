/**
 * Workspace code symbols — the backend behind "go to definition"
 * (Ctrl+Click in the editor) and the "go to symbol" popup (Ctrl+T).
 *
 * Regex + scope tracking per language family (no tree-sitter: zero native
 * deps, instant startup). Heuristic by design — it resolves the overwhelming
 * majority of class/method/function jumps; ambiguous names fall back to a
 * ranked candidate list instead of a wrong jump.
 */
import * as fs from 'fs';
import * as path from 'path';
import { projectSkipDirs, relativePosix } from './paths';
import { readTextFile } from './filesearch';
import { projectNav } from './nav';

export type SymbolKind = 'class' | 'interface' | 'function' | 'method' | 'type';

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  /** Project-relative posix path. */
  path: string;
  /** 1-based line. */
  line: number;
  /** Enclosing class/interface, for methods. */
  container?: string;
}

/** Build output skipped in searches even when the stack is not detected. */
const GENERATED_DIRS = ['dist', 'build', 'out', 'coverage'];

const MAX_SYMBOLS = 3000;
const MAX_RESULTS = 100;

const IDENT = '[A-Za-z_$][\\w$]*';
const IDENT_PY = '[A-Za-z_][\\w]*';

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

/**
 * Strip `//` line comments (commented-out code like `// class Foo` must not
 * index as a definition). `://` URL prefixes are preserved; full-line `#`
 * comments (PHP) are dropped entirely.
 */
function stripLineComment(line: string): string {
  const noSlash = line.replace(/(^|[^:])\/\/.*$/, '$1');
  if (/^\s*#/.test(noSlash)) return '';
  return noSlash;
}

/** Stateful block-comment stripper: JSDoc one-liners must not index as
 *  definitions, and multi-line comment bodies are skipped line by line. */
function stripBlockComments(line: string, block: { open: boolean }): string {
  let s = line;
  if (block.open) {
    const end = s.indexOf('*/');
    if (end < 0) return '';
    s = s.slice(end + 2);
    block.open = false;
  }
  s = s.replace(/\/\*.*?\*\//g, '');
  const opener = s.indexOf('/*');
  if (opener >= 0) {
    s = s.slice(0, opener);
    block.open = true;
  }
  return s;
}

/** Skip minified/generated blobs (bundler chunks): their word soup pollutes
 *  the index and can eat the symbol budget before real code is scanned. */
export function isMinified(text: string): boolean {
  const probe = text.split('\n', 50);
  if (!probe.length) return false;
  const avg = probe.reduce((sum, l) => sum + l.length, 0) / probe.length;
  return avg > 300;
}

// ---------------------------------------------------------------------------
// Per-file parsers (brace-depth or indent scope tracking)
// ---------------------------------------------------------------------------

interface ScopeEntry {
  name: string;
  minDepth: number;
}

function parseBraced(
  rel: string,
  lines: string[],
  classRes: Array<{ re: RegExp; kind: SymbolKind }>,
  funcRes: RegExp[],
  methodRes: RegExp[],
): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const stack: ScopeEntry[] = [];
  const block = { open: false };
  let depth = 0;
  const KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'typeof',
    'new', 'await', 'yield', 'throw', 'else', 'do', 'case', 'function',
  ]);
  for (let i = 0; i < lines.length; i++) {
    let line = stripBlockComments(lines[i], block);
    line = stripLineComment(line);
    while (stack.length && depth < stack[stack.length - 1].minDepth) stack.pop();
    const container = stack.length ? stack[stack.length - 1].name : undefined;

    let m: RegExpMatchArray | null = null;
    let mKind: SymbolKind = 'class';
    for (const entry of classRes) {
      entry.re.lastIndex = 0;
      const mm = line.match(entry.re);
      if (mm) {
        m = mm;
        mKind = entry.kind;
        break;
      }
    }
    if (m) {
      out.push({ name: m[1], kind: mKind, path: rel, line: i + 1 });
    } else if (container) {
      for (const re of methodRes) {
        re.lastIndex = 0;
        const mm = line.match(re);
        if (mm && !KEYWORDS.has(mm[1])) {
          out.push({ name: mm[1], kind: 'method', path: rel, line: i + 1, container });
          break;
        }
      }
    } else {
      for (const re of funcRes) {
        re.lastIndex = 0;
        const fm = line.match(re);
        if (fm && !KEYWORDS.has(fm[1])) {
          out.push({ name: fm[1], kind: 'function', path: rel, line: i + 1 });
          break;
        }
      }
    }

    const opens = countChar(line, '{');
    const closes = countChar(line, '}');
    const depthAfter = depth + opens - closes;
    // A one-line `interface Item { … }` / `class A {}` opens and closes on its own line: it has no
    // body to attribute the following declarations to (they used to be taken for its methods)
    if (m && !(opens > 0 && depthAfter <= depth)) {
      stack.push({ name: m[1], minDepth: depthAfter + (opens === 0 ? 1 : 0) });
    }
    depth = Math.max(0, depthAfter);
  }
  return out;
}

function parsePython(rel: string, lines: string[]): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const stack: Array<{ name: string; indent: number; isClass: boolean }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ind = line.length - line.trimStart().length;
    const cm = line.match(new RegExp(`^\\s*class\\s+(${IDENT_PY})\\b`));
    const dm = line.match(new RegExp(`^\\s*(?:async\\s+)?def\\s+(${IDENT_PY})\\s*\\(`));
    if (!cm && !dm) continue;
    while (stack.length && ind <= stack[stack.length - 1].indent) stack.pop();
    if (cm) {
      out.push({ name: cm[1], kind: 'class', path: rel, line: i + 1 });
      stack.push({ name: cm[1], indent: ind, isClass: true });
    } else if (dm) {
      const top = stack.length ? stack[stack.length - 1] : undefined;
      if (top && top.isClass && ind > top.indent) {
        out.push({ name: dm[1], kind: 'method', path: rel, line: i + 1, container: top.name });
      } else {
        out.push({ name: dm[1], kind: 'function', path: rel, line: i + 1 });
      }
      stack.push({ name: dm[1], indent: ind, isClass: false });
    }
  }
  return out;
}

const TS_CLASS: Array<{ re: RegExp; kind: SymbolKind }> = [
  { re: new RegExp(`(?:export\\s+)?(?:abstract\\s+)?class\\s+(${IDENT})`), kind: 'class' },
  { re: new RegExp(`(?:export\\s+)?interface\\s+(${IDENT})`), kind: 'interface' },
  { re: new RegExp(`(?:export\\s+)?type\\s+(${IDENT})\\s*=`), kind: 'type' },
  { re: new RegExp(`(?:export\\s+)?enum\\s+(${IDENT})`), kind: 'class' },
];
const TS_FUNC = [
  new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+(${IDENT})\\s*\\(`),
  new RegExp(`(?:export\\s+)?const\\s+(${IDENT})\\s*=\\s*(?:async\\s*)?\\(`),
  new RegExp(`(?:export\\s+)?const\\s+(${IDENT})\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>`),
  new RegExp(`(?:export\\s+)?const\\s+(${IDENT})\\s*=\\s*function\\s*\\(`),
];
const TS_METHOD = [
  new RegExp(`^\\s*(?:public|private|protected|static|async|abstract|override|readonly|\\*|\\s)*(?:get\\s+|set\\s+)?(${IDENT})\\s*\\(`),
  new RegExp(`^\\s*(?:public|private|protected|static|readonly|\\s)*(${IDENT})\\s*=\\s*(?:async\\s*)?\\(`),
];

const GO_FUNC = [
  new RegExp(`^func\\s+(${IDENT})\\s*\\(`),
];
const GO_METHOD_CONTAINER = new RegExp(`^func\\s*\\(\\s*\\w+\\s+\\*?(\\w[\\w\\[\\]]*)\\s*\\)\\s*(\\w[\\w$]*)\\s*\\(`);

function parseGo(rel: string, lines: string[]): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const block = { open: false };
  for (let i = 0; i < lines.length; i++) {
    const line = stripLineComment(stripBlockComments(lines[i], block));
    let m = line.match(GO_METHOD_CONTAINER);
    if (m) {
      out.push({ name: m[2], kind: 'method', path: rel, line: i + 1, container: m[1] });
      continue;
    }
    for (const re of GO_FUNC) {
      re.lastIndex = 0;
      const fm = line.match(re);
      if (fm) {
        out.push({ name: fm[1], kind: 'function', path: rel, line: i + 1 });
        break;
      }
    }
    const tm = line.match(new RegExp(`^type\\s+(${IDENT})\\s+(struct|interface)`));
    if (tm) {
      out.push({
        name: tm[1], kind: tm[2] === 'interface' ? 'interface' : 'class',
        path: rel, line: i + 1,
      });
    }
  }
  return out;
}

export function parseFile(rel: string, text: string): CodeSymbol[] {
  const ext = rel.split('.').pop()?.toLowerCase() ?? '';
  const lines = text.split('\n');
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'].includes(ext)) {
    return parseBraced(rel, lines, TS_CLASS, TS_FUNC, TS_METHOD);
  }
  if (ext === 'py') return parsePython(rel, lines);
  if (ext === 'php') {
    return parseBraced(
      rel,
      lines,
      [
        { re: new RegExp(`\\bclass\\s+(${IDENT})`), kind: 'class' },
        { re: new RegExp(`\\binterface\\s+(${IDENT})`), kind: 'interface' },
        { re: new RegExp(`\\btrait\\s+(${IDENT})`), kind: 'class' },
      ],
      [],
      [new RegExp(`\\bfunction\\s+(${IDENT})\\s*\\(`)],
    );
  }
  if (ext === 'go') return parseGo(rel, lines);
  if (ext === 'rs') {
    return parseBraced(
      rel,
      lines,
      [
        { re: new RegExp(`\\bstruct\\s+(${IDENT})`), kind: 'class' },
        { re: new RegExp(`\\benum\\s+(${IDENT})`), kind: 'class' },
        { re: new RegExp(`\\btrait\\s+(${IDENT})`), kind: 'interface' },
      ],
      [new RegExp(`\\bfn\\s+(${IDENT})\\s*\\(`)],
      [new RegExp(`\\bfn\\s+(${IDENT})\\s*\\(`)],
    );
  }
  if (['java', 'kt', 'cs', 'cpp', 'h', 'hpp', 'c'].includes(ext)) {
    return parseBraced(
      rel,
      lines,
      [
        { re: new RegExp(`\\bclass\\s+(${IDENT})`), kind: 'class' },
        { re: new RegExp(`\\binterface\\s+(${IDENT})`), kind: 'interface' },
        { re: new RegExp(`\\bfun\\s+(${IDENT})\\s*\\(`), kind: 'function' },
      ],
      [new RegExp(`\\b(?:fun\\s+)?(${IDENT})\\s*\\([^;{}]*\\)\\s*(?::\\s*[\\w<>,.?\\s]+)?\\s*\\{`)],
      [new RegExp(`^\\s*(?:[\\w<>,.\\[\\]\\s]+\\s+)?(${IDENT})\\s*\\([^;{}]*\\)\\s*(?:throws\\s+[\\w,\\s]+)?\\s*[{;]`)],
    );
  }
  if (ext === 'rb') {
    return parseBraced(
      rel,
      lines,
      [
        { re: new RegExp(`\\bclass\\s+(${IDENT})`), kind: 'class' },
        { re: new RegExp(`\\bmodule\\s+(${IDENT})`), kind: 'class' },
      ],
      [new RegExp(`\\bdef\\s+(?:self\\.)?(${IDENT})`)],
      [new RegExp(`\\bdef\\s+(?:self\\.)?(${IDENT})`)],
    );
  }
  return [];
}

// ---------------------------------------------------------------------------
// Workspace index
// ---------------------------------------------------------------------------

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

function indexOneFile(root: string, full: string, out: CodeSymbol[]): boolean {
  const text = readTextFile(full);
  if (text === null || isMinified(text)) return true;
  const rel = relativePosix(root, full);
  for (const s of parseFile(rel, text)) {
    out.push(s);
    if (out.length >= MAX_SYMBOLS) return false;
  }
  return true;
}

/** Full workspace symbol index (bounded). Exported for unit tests. */
export function indexSymbols(root: string): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  walkFiles(root, (full) => indexOneFile(root, full, out));
  return out;
}

const KIND_RANK: Record<SymbolKind, number> = {
  class: 0,
  interface: 1,
  method: 2,
  function: 3,
  type: 4,
};

/** Fuzzy symbol search for the Ctrl+T popup. */
export function searchSymbols(root: string, query: string): CodeSymbol[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const all = indexSymbols(root);
  const hits = all.filter((s) => s.name.toLowerCase().includes(q));
  hits.sort((a, b) => {
    const aStart = a.name.toLowerCase().startsWith(q) ? 0 : 1;
    const bStart = b.name.toLowerCase().startsWith(q) ? 0 : 1;
    return (
      aStart - bStart ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      a.path.localeCompare(b.path) ||
      a.line - b.line
    );
  });
  return hits.slice(0, MAX_RESULTS);
}

export interface DefinitionQuery {
  /** Project-relative path of the file containing the cursor. */
  path: string;
  /** 1-based cursor line. */
  line: number;
  /** Identifier under the cursor. */
  symbol: string;
  /** Object part of `obj.method` (a likely class name), if any. */
  container?: string;
}

export interface DefinitionResult {
  path: string;
  line: number;
}

/**
 * Resolve a symbol to its definition: route URIs first (Ctrl+Click on
 * `fetch('/api/…')` jumps to the handler), then same-file definitions
 * (container match wins), then workspace candidates ranked by kind and
 * directory proximity. Null = not found (the UI says so, never guesses).
 */
export function findDefinition(root: string, q: DefinitionQuery, indexed?: CodeSymbol[]): DefinitionResult | null {
  const symbol = (q.symbol ?? '').trim();
  if (!symbol) return null;

  // 1) Route URIs resolve through the framework route index.
  if (symbol.startsWith('/')) {
    try {
      const nav = projectNav(root);
      const hit = nav.routes.find(
        (r) => r.uri === symbol || (symbol.length > 1 && r.uri.endsWith(symbol)),
      );
      if (hit) return { path: hit.file, line: hit.line };
    } catch {
      /* route scan is best-effort */
    }
  }

  // 2) Same-file definitions (container match wins, then kind, then proximity).
  const here = path.resolve(root, q.path);
  const text = readTextFile(here);
  if (text !== null) {
    const rel = relativePosix(root, here);
    const local = parseFile(rel, text).filter((s) => s.name === symbol);
    if (local.length) {
      local.sort((a, b) => {
        const aCont = q.container && a.container === q.container ? 0 : 1;
        const bCont = q.container && b.container === q.container ? 0 : 1;
        return (
          aCont - bCont ||
          KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
          Math.abs(a.line - q.line) - Math.abs(b.line - q.line)
        );
      });
      return { path: local[0].path, line: local[0].line };
    }
  }

  // 3) Workspace fallback, preferring the source file's directory.
  const all = (indexed ?? indexSymbols(root)).filter((s) => s.name === symbol && s.path !== q.path);
  if (!all.length) return null;
  const dir = q.path.includes('/') ? q.path.slice(0, q.path.lastIndexOf('/')) : '';
  all.sort((a, b) => {
    const aCont = q.container && a.container === q.container ? 0 : 1;
    const bCont = q.container && b.container === q.container ? 0 : 1;
    const aDir = dir && (a.path === q.path || a.path.startsWith(dir + '/')) ? 0 : 1;
    const bDir = dir && (b.path === q.path || b.path.startsWith(dir + '/')) ? 0 : 1;
    return (
      aCont - bCont ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      aDir - bDir ||
      a.path.localeCompare(b.path) ||
      a.line - b.line
    );
  });
  return { path: all[0].path, line: all[0].line };
}
