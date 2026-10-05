/**
 * App runner behind the Preview tab: starts a project's dev server (or serves
 * a static site), learns its URL from the output and keeps a log tail.
 *
 * One run per project. The process tree is killed on stop and on shutdown so
 * dev servers never outlive the app.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { projectPhpEnv } from './phpvm';
import { detectProject, type ContainerInfo, type RunKind, type RunOption } from './detect';

export type RunStatus = 'idle' | 'starting' | 'running' | 'exited';

export interface RunState {
  status: RunStatus;
  command: string;
  /** Address to show in the preview frame (dev server URL or the static-site route). */
  url: string | null;
  pid: number | null;
  exit_code: number | null;
  started_at: number | null;
  /** The command failed because its port is taken; the preview attached to that running server instead. */
  attached: boolean;
  /** Port the command wanted but found busy (EADDRINUSE), if any. */
  busy_port: number | null;
  log: string[];
}

export interface RunDetection {
  kind: RunKind;
  /** Recommended command (first option). */
  command: string;
  /** Port the recommended command is expected to listen on, when known. */
  port: number | null;
  /** The project has an index.html that can be served without a process. */
  hasIndex: boolean;
  label: string;
  stacks: string[];
  /** A UI that can be previewed in a frame. */
  frontend: boolean;
  containers: ContainerInfo;
  options: RunOption[];
}

interface Rec {
  awaitPort?: boolean;
  proc: ChildProcess | null;
  state: RunState;
  probe: ReturnType<typeof setInterval> | null;
}

const runs = new Map<number, Rec>();
const LOG_LINES = 300;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d+[^\s'")\]>]*/i;

const emptyState = (): RunState => ({ status: 'idle', command: '', url: null, pid: null, exit_code: null, started_at: null, attached: false, busy_port: null, log: [] });

const IN_USE = /EADDRINUSE|address already in use|port \d+ is (?:already )?in use|already in use/i;

/** What can be run in this folder, and how (see detect.ts). */
export function detectRun(root: string): RunDetection {
  const project = detectProject(root);
  const primary = project.options[0];
  const kind: RunKind = primary?.kind ?? (project.hasIndex ? 'static' : 'none');
  return {
    kind,
    command: primary?.command ?? '',
    port: primary?.port ?? null,
    hasIndex: project.hasIndex,
    label: project.stacks.join(' \u00b7 '),
    stacks: project.stacks,
    frontend: project.frontend,
    containers: project.containers,
    options: project.options,
  };
}

/** Address of the static-site route for an HTML project. */
export const staticSiteUrl = (projectId: number, file = 'index.html'): string => `/api/site/${projectId}/${file}`;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm', '.xml': 'application/xml',
};
export const mimeFor = (file: string): string => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/** Windows console (OEM) code page → a decoder label, e.g. 866 → ibm866. */
let oemLabel: string | null | undefined;
function oemDecoderLabel(): string | null {
  if (oemLabel !== undefined) return oemLabel;
  oemLabel = null;
  if (process.platform === 'win32') {
    try {
      const out = spawnSync('cmd.exe', ['/d', '/c', 'chcp'], { windowsHide: true, encoding: 'utf8', timeout: 4000 }).stdout ?? '';
      const page = Number(/(\d{3,5})\s*$/.exec(out.trim())?.[1]);
      if (page === 866) oemLabel = 'ibm866';
      else if (page === 1251) oemLabel = 'windows-1251';
      else if (page === 437 || page === 850) oemLabel = 'windows-1252';
    } catch {
      /* keep null */
    }
  }
  return oemLabel;
}

/**
 * Process output as text. Node tools write UTF-8, but `cmd.exe` and old console
 * programs write the OEM code page — decoded as UTF-8 that is unreadable mojibake.
 */
export function decodeOutput(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    const label = oemDecoderLabel();
    if (label) {
      try {
        return new TextDecoder(label).decode(buf);
      } catch {
        /* unsupported label: fall through */
      }
    }
    return buf.toString('utf8');
  }
}

function killTree(proc: ChildProcess | null): void {
  if (!proc?.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function push(rec: Rec, text: string, scanUrl = true): void {
  const clean = text.replace(ANSI, '');
  for (const line of clean.split(/\r?\n/)) {
    if (!line.trim()) continue;
    rec.state.log.push(line.slice(0, 400));
    if (scanUrl && IN_USE.test(line) && !rec.state.busy_port) {
      const num = /(?:in use[^\d]*|:)(\d{2,5})\b/.exec(line) ?? /port\s+(\d{2,5})/i.exec(line);
      if (num) rec.state.busy_port = Number(num[1]);
      else rec.awaitPort = true;
    } else if (scanUrl && rec.awaitPort && !rec.state.busy_port) {
      const num = /^\s*port:\s*(\d{2,5})/i.exec(line);
      if (num) rec.state.busy_port = Number(num[1]);
    }
    if (scanUrl && !rec.state.url) {
      const m = URL_RE.exec(line);
      if (m) {
        rec.state.url = m[0].replace('0.0.0.0', 'localhost').replace(/\[::1?\]/, 'localhost');
        rec.state.status = 'running';
      }
    }
  }
  if (rec.state.log.length > LOG_LINES) rec.state.log.splice(0, rec.state.log.length - LOG_LINES);
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(400);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** The command lost the race for its port: if something already serves it, show that server. */
async function attachIfServed(rec: Rec): Promise<void> {
  const port = rec.state.busy_port;
  if (!port || rec.state.url) return;
  if (await portOpen(port)) {
    rec.state.url = `http://localhost:${port}/`;
    rec.state.attached = true;
    rec.state.status = 'running';
    rec.state.log.push(`[port ${port} is already served by another process — attached to it]`);
  }
}

export function getRun(projectId: number): RunState {
  return runs.get(projectId)?.state ?? emptyState();
}

export function stopRun(projectId: number): RunState {
  const rec = runs.get(projectId);
  if (!rec) return emptyState();
  if (rec.probe) clearInterval(rec.probe);
  killTree(rec.proc);
  rec.proc = null;
  rec.state.status = 'exited';
  rec.state.pid = null;
  return rec.state;
}

/** Start `command` in `root` (replaces a previous run of the same project). */
export function startRun(projectId: number, root: string, command: string, expectedPort: number | null = null): RunState {
  stopRun(projectId);
  const rec: Rec = {
    proc: null,
    probe: null,
    state: { ...emptyState(), status: 'starting', command, started_at: Math.floor(Date.now() / 1000) },
  };
  runs.set(projectId, rec);
  push(rec, `> ${command}`, false); // the echoed command may itself contain a URL

  let proc: ChildProcess;
  try {
    proc = spawn(process.platform === 'win32' ? `chcp 65001>nul & ${command}` : command, {
      cwd: root,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: projectPhpEnv(root, { ...process.env, BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }),
    });
  } catch (exc) {
    rec.state.status = 'exited';
    push(rec, `Failed to start: ${exc instanceof Error ? exc.message : String(exc)}`);
    return rec.state;
  }
  rec.proc = proc;
  rec.state.pid = proc.pid ?? null;
  proc.stdout?.on('data', (buf: Buffer) => push(rec, decodeOutput(buf)));
  proc.stderr?.on('data', (buf: Buffer) => push(rec, decodeOutput(buf)));
  proc.on('error', (exc) => {
    push(rec, `Failed to start: ${exc.message}`);
    rec.state.status = 'exited';
  });
  proc.on('exit', (code) => {
    if (rec.proc !== proc) return; // replaced or stopped on purpose
    if (rec.probe) clearInterval(rec.probe);
    rec.state.status = 'exited';
    rec.state.exit_code = code;
    rec.state.pid = null;
    push(rec, `[exit ${code ?? '?'}]`);
    void attachIfServed(rec);
  });

  // Servers that do not print their address: watch the well-known port instead.
  if (expectedPort) {
    let tries = 0;
    rec.probe = setInterval(() => {
      if (rec.state.url || rec.proc !== proc || ++tries > 120) {
        if (rec.probe) clearInterval(rec.probe);
        return;
      }
      void portOpen(expectedPort).then((open) => {
        if (open && !rec.state.url && rec.proc === proc) {
          rec.state.url = `http://localhost:${expectedPort}/`;
          rec.state.status = 'running';
        }
      });
    }, 750);
  }
  return rec.state;
}

export function killAllRuns(): void {
  for (const id of [...runs.keys()]) stopRun(id);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'vendor', 'target', '.venv', 'venv', 'out', 'coverage', '__pycache__', '.cache']);
const PAGE_EXT = /\.(html?|svg)$/i;
const WATCH_EXT = /\.(html?|css|js|mjs|svg|json|png|jpe?g|gif|webp|avif|woff2?)$/i;

function walk(root: string, visit: (rel: string, full: string, mtimeMs: number) => void, maxDepth = 6, maxFiles = 4000): void {
  let seen = 0;
  const go = (dir: string, depth: number): void => {
    if (depth > maxDepth || seen > maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) go(full, depth + 1);
      } else if (entry.isFile()) {
        seen++;
        try {
          visit(path.relative(root, full).split(path.sep).join('/'), full, fs.statSync(full).mtimeMs);
        } catch {
          /* vanished while scanning */
        }
      }
    }
  };
  go(root, 0);
}

/** HTML/SVG files of the project that can be opened in the preview frame (index.html first). */
export function listPages(root: string): string[] {
  const pages: string[] = [];
  walk(root, (rel) => {
    if (PAGE_EXT.test(rel) && pages.length < 300) pages.push(rel);
  });
  const rank = (p: string): number => (/^index\.html?$/i.test(p) ? 0 : p.includes('/') ? 2 : 1);
  return pages.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Newest modification time among files a static page depends on: changes when the page should reload. */
export function siteStamp(root: string): number {
  let newest = 0;
  walk(root, (rel, _full, mtime) => {
    if (WATCH_EXT.test(rel) && mtime > newest) newest = mtime;
  });
  return Math.round(newest);
}
