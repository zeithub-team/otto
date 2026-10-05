/**
 * Framework-aware navigation for the IDE.
 *
 * Detects the project stack and extracts structured jump targets — currently
 * Laravel routes → controller@method resolved to a file and line, so the UI can
 * offer "go to route / controller / method / file".
 */
import * as fs from 'fs';
import * as path from 'path';
import { isDirectory, isFile, relativePosix, SKIP_DIRS } from './paths';

export type Stack = 'laravel' | 'fastapi' | 'express' | 'node' | 'nextjs' | 'generic';

export interface RouteEntry {
  method: string;
  uri: string;
  /** Controller class short name (or closure). */
  controller: string;
  /** Controller method. */
  action: string;
  /** Project-relative file of the controller (or the route file). */
  file: string;
  /** 1-based line of the method (or 1). */
  line: number;
}

export interface NavInfo {
  stack: Stack;
  routes: RouteEntry[];
}

function readIf(file: string): string | null {
  try {
    return isFile(file) ? fs.readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

/** Common places a Laravel app lives relative to the project root. */
const LARAVEL_SUBDIRS = ['', 'backend', 'backend/src', 'src', 'api', 'server', 'app-backend'];

/** Directory of the Laravel app (has composer.json w/ laravel + routes/), or null. */
export function findLaravelRoot(root: string): string | null {
  for (const sub of LARAVEL_SUBDIRS) {
    const dir = sub ? path.join(root, sub) : root;
    const composer = readIf(path.join(dir, 'composer.json'));
    if (composer && /laravel\/framework/.test(composer) && isDirectory(path.join(dir, 'routes'))) return dir;
  }
  return null;
}

export function detectStack(root: string): Stack {
  if (findLaravelRoot(root)) return 'laravel';
  if (isFile(path.join(root, 'next.config.js')) || isFile(path.join(root, 'next.config.mjs'))) return 'nextjs';
  if (isFile(path.join(root, 'package.json'))) return 'node';
  return 'generic';
}

/** Find `app/Http/Controllers/**` file defining `class <name>` and the method line.
 *  Searches under `appRoot`; returns the path relative to `projectRoot`. */
function resolveController(projectRoot: string, appRoot: string, shortName: string, action: string): { file: string; line: number } | null {
  const base = path.join(appRoot, 'app', 'Http', 'Controllers');
  const searchRoot = isDirectory(base) ? base : path.join(appRoot, 'app');
  if (!isDirectory(searchRoot)) return null;

  const classRe = new RegExp(`class\\s+${shortName}\\b`);
  const methodRe = new RegExp(`function\\s+${action}\\s*\\(`);

  const stack = [searchRoot];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory ? entry.isDirectory() : false) {
        if (!SKIP_DIRS.includes(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.php')) continue;
      const text = readIf(full);
      if (!text || !classRe.test(text)) continue;
      // Found the controller file. Locate the method line.
      const lines = text.split(/\r?\n/);
      let line = 1;
      for (let i = 0; i < lines.length; i++) {
        if (methodRe.test(lines[i])) { line = i + 1; break; }
      }
      return { file: relativePosix(projectRoot, full), line };
    }
  }
  return null;
}

/** Join a group prefix and a route uri into a clean `/a/b` path. */
function joinUri(prefix: string, uri: string): string {
  const joined = `/${prefix}/${uri}`.replace(/\/+/g, '/');
  const trimmed = joined.replace(/\/+$/, '');
  return trimmed || '/';
}

/** Parse Laravel route files into structured entries, honouring group prefixes.
 *  `appRoot` is the Laravel app dir; returned file paths are relative to `projectRoot`. */
export function laravelRoutes(projectRoot: string, appRoot: string): RouteEntry[] {
  const routesDir = path.join(appRoot, 'routes');
  if (!isDirectory(routesDir)) return [];
  const out: RouteEntry[] = [];
  const seen = new Set<string>();

  // Per-line regexes (routes are almost always on a single line).
  const arrayRe = /Route::(get|post|put|patch|delete|any|options)\s*\(\s*(['"])(.*?)\2\s*,\s*\[\s*([\w\\]+)::class\s*,\s*(['"])(\w+)\5\s*\]/g;
  const stringRe = /Route::(get|post|put|patch|delete|any|options)\s*\(\s*(['"])(.*?)\2\s*,\s*(['"])([\w\\]+)@(\w+)\4/g;
  const prefixFluent = /->\s*prefix\(\s*['"]([^'"]+)['"]/;
  const prefixArray = /['"]prefix['"]\s*=>\s*['"]([^'"]+)['"]/;
  const cleanSeg = (s: string) => s.replace(/^\/+|\/+$/g, '');

  let files: string[];
  try { files = fs.readdirSync(routesDir).filter((f) => f.endsWith('.php')); } catch { return []; }

  for (const name of files) {
    const routeFile = path.join(routesDir, name);
    const text = readIf(routeFile);
    if (!text) continue;
    const routeRel = relativePosix(projectRoot, routeFile);

    const add = (method: string, uri: string, classRef: string, action: string, prefix: string) => {
      const shortName = classRef.split('\\').pop() ?? classRef;
      const fullUri = joinUri(prefix, uri);
      const key = `${method} ${fullUri} ${shortName}@${action}`;
      if (seen.has(key)) return;
      seen.add(key);
      const resolved = resolveController(projectRoot, appRoot, shortName, action);
      out.push({
        method: method.toUpperCase(),
        uri: fullUri,
        controller: shortName,
        action,
        file: resolved?.file ?? routeRel,
        line: resolved?.line ?? 1,
      });
    };

    // Track group prefixes by brace depth.
    const stack: { depth: number; prefix: string }[] = [];
    let depth = 0;
    for (const line of text.split(/\r?\n/)) {
      const currentPrefix = stack.map((s) => s.prefix).filter(Boolean).join('/');
      for (const m of line.matchAll(arrayRe)) add(m[1], m[3], m[4], m[6], currentPrefix);
      for (const m of line.matchAll(stringRe)) add(m[1], m[3], m[5], m[6], currentPrefix);

      const opens = (line.match(/\{/g) ?? []).length;
      const closes = (line.match(/\}/g) ?? []).length;
      const pm = line.match(prefixFluent) ?? line.match(prefixArray);
      const newDepth = depth + opens - closes;
      if (pm && newDepth > depth) stack.push({ depth: newDepth, prefix: cleanSeg(pm[1]) });
      depth = Math.max(0, newDepth);
      while (stack.length && depth < stack[stack.length - 1].depth) stack.pop();
    }
  }

  out.sort((a, b) => (a.uri === b.uri ? a.method.localeCompare(b.method) : a.uri.localeCompare(b.uri)));
  return out;
}

export function projectNav(root: string): NavInfo {
  const routes: RouteEntry[] = [];
  const seen = new Set<string>();
  const push = (r: RouteEntry): void => {
    const key = `${r.method} ${r.uri} ${r.file}:${r.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push(r);
  };

  let stack: Stack = detectStack(root);
  const appRoot = findLaravelRoot(root);
  if (appRoot) {
    stack = 'laravel';
    for (const r of laravelRoutes(root, appRoot)) push(r);
  }
  // A repo can host several stacks at once (e.g. FastAPI backend + TS
  // server + Next.js frontend) — collect routes from every detector.
  for (const r of fastApiRoutes(root)) push(r);
  for (const r of expressRoutes(root)) push(r);
  for (const r of nextjsRoutes(root)) push(r);
  if (routes.length && stack !== 'laravel') {
    if (routes.some((r) => r.controller.endsWith('.py'))) stack = 'fastapi';
    else if (routes.some((r) => /route\.ts$|page\.tsx$/.test(r.file))) stack = 'nextjs';
    else if (routes.some((r) => r.file.endsWith('.ts') || r.file.endsWith('.js'))) stack = 'express';
  }
  routes.sort((a, b) => (a.uri === b.uri ? a.method.localeCompare(b.method) : a.uri.localeCompare(b.uri)));
  return { stack, routes };
}

// ---------------------------------------------------------------------------
// Generic framework detectors (FastAPI, Express-style, Next.js app router)
// ---------------------------------------------------------------------------

/** Extra junk dirs for route walks (on top of paths.SKIP_DIRS). */
const ROUTE_SKIP = new Set([
  ...SKIP_DIRS,
  'dist', 'build', 'out', 'coverage', '__pycache__', '.turbo', '.output',
  '.venv', 'venv', '.idea', '.vscode',
]);

const MAX_ROUTE_FILES = 800;
const MAX_ROUTE_FILE_SIZE = 500_000;

function readCapped(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_ROUTE_FILE_SIZE) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function walkExts(root: string, exts: Set<string>, visit: (full: string) => void): void {
  let count = 0;
  const visitDir = (folder: string): void => {
    if (count >= MAX_ROUTE_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= MAX_ROUTE_FILES) return;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!ROUTE_SKIP.has(entry.name)) visitDir(full);
      } else if (entry.isFile()) {
        const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
        if (exts.has(ext)) {
          count++;
          visit(full);
        }
      }
    }
  };
  visitDir(root);
}

/** FastAPI/Starlette: `@app.get("/x")` / `@router.post('/y')` → handler def below. */
export function fastApiRoutes(projectRoot: string): RouteEntry[] {
  const out: RouteEntry[] = [];
  const decoRe = /@(\w+)\.(get|post|put|patch|delete|head|options|trace|websocket|api_route)\(\s*["']([^"']+)["']/g;
  const defRe = /^\s*(?:async\s+)?def\s+(\w+)\s*\(/;
  walkExts(projectRoot, new Set(['py']), (full) => {
    const text = readCapped(full);
    if (!text || !text.includes('@')) return;
    const rel = relativePosix(projectRoot, full);
    const controller = path.basename(full, '.py');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      decoRe.lastIndex = 0;
      for (const m of lines[i].matchAll(decoRe)) {
        let action = 'handler';
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          const dm = lines[j].match(defRe);
          if (dm) {
            action = dm[1];
            break;
          }
        }
        out.push({
          method: m[2].toUpperCase(),
          uri: m[3],
          controller,
          action,
          file: rel,
          line: i + 1,
        });
      }
    }
  });
  return out;
}

/** Express-style + this app's own route table: `router.get('/x', handler)`. */
export function expressRoutes(projectRoot: string): RouteEntry[] {
  const out: RouteEntry[] = [];
  const callRe = /\b(app|router)\.(get|post|put|patch|delete|all|use|options|head)\(\s*['"`]([^'"`]+)['"`]/g;
  const tableRe = /\{\s*path:\s*'([^']+)'[^}]*methods:\s*\[([^\]]*)\]/g;
  const checkRe = /pathname\s*===\s*['"`](\/[^'"`]+)['"`]/g;
  walkExts(projectRoot, new Set(['ts', 'js', 'mjs', 'cjs', 'mts']), (full) => {
    const text = readCapped(full);
    if (!text) return;
    const rel = relativePosix(projectRoot, full);
    const controller = path.basename(full).replace(/\.(ts|js|mjs|cjs|mts)$/, '');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      callRe.lastIndex = 0;
      for (const m of line.matchAll(callRe)) {
        const after = line.slice((m.index ?? 0) + m[0].length);
        const hm = after.match(/^\s*,\s*([A-Za-z_$][\w$]*)\b/);
        out.push({
          method: m[2].toUpperCase(),
          uri: m[3],
          controller,
          action: hm ? hm[1] : 'handler',
          file: rel,
          line: i + 1,
        });
      }
      tableRe.lastIndex = 0;
      for (const m of line.matchAll(tableRe)) {
        const methods = [...m[2].matchAll(/'([A-Z]+)'/g)].map((x) => x[1]);
        for (const method of methods.length ? methods : ['*']) {
          out.push({ method, uri: m[1], controller, action: 'handler', file: rel, line: i + 1 });
        }
      }
      checkRe.lastIndex = 0;
      for (const m of line.matchAll(checkRe)) {
        if (/api|ws|hook|callback|route|path/.test(rel)) {
          out.push({ method: '*', uri: m[1], controller, action: 'handler', file: rel, line: i + 1 });
        }
      }
    }
  });
  return out;
}

/** Next.js app router: page.tsx files under the app dir become URLs, route.ts files become METHOD + URL. */
export function nextjsRoutes(projectRoot: string): RouteEntry[] {
  const out: RouteEntry[] = [];
  const roots: string[] = [];
  const collect = (folder: string, depth: number): void => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || ROUTE_SKIP.has(entry.name)) continue;
      const full = path.join(folder, entry.name);
      if (entry.name === 'app' && isFile(path.join(full, 'layout.tsx'))) roots.push(full);
      else collect(full, depth + 1);
    }
  };
  collect(projectRoot, 0);
  if (!roots.length && isFile(path.join(projectRoot, 'app', 'page.tsx'))) {
    roots.push(path.join(projectRoot, 'app'));
  }
  const handlerRe = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/;
  for (const appDir of roots) {
    const stack: Array<{ dir: string; url: string }> = [{ dir: appDir, url: '' }];
    while (stack.length) {
      const { dir, url } = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (ROUTE_SKIP.has(entry.name)) continue;
          // Route groups (…) and private _… folders are transparent in URLs.
          const seg = entry.name.startsWith('(') && entry.name.endsWith(')')
            ? ''
            : entry.name.startsWith('[')
              ? ':param'
              : entry.name.startsWith('_')
                ? ''
                : entry.name;
          stack.push({ dir: full, url: seg ? `${url}/${seg}` : url });
        } else if (entry.isFile() && (entry.name === 'page.tsx' || entry.name === 'route.ts')) {
          const uri = url || '/';
          const rel = relativePosix(projectRoot, full);
          if (entry.name === 'page.tsx') {
            out.push({ method: 'PAGE', uri, controller: 'page', action: 'default', file: rel, line: 1 });
          } else {
            const text = readCapped(full);
            if (!text) continue;
            const lines = text.split('\n');
            let any = false;
            for (let i = 0; i < lines.length; i++) {
              const hm = lines[i].match(handlerRe);
              if (hm) {
                any = true;
                out.push({ method: hm[1], uri, controller: 'route', action: hm[1], file: rel, line: i + 1 });
              }
            }
            if (!any) out.push({ method: '*', uri, controller: 'route', action: 'handler', file: rel, line: 1 });
          }
        }
      }
    }
  }
  return out;
}
