/**
 * Embedded otto server.
 *
 * One HTTP listener serves
 *   1. the REST API (`api.ts`),
 *   2. the chat WebSocket (`ws.ts`, `/api/chat/ws/chat`),
 *   3. the static renderer export (SPA fallback + path traversal guard).
 *
 * This module must never import `electron`: it is started both by the
 * Electron main process (`../main/server.ts`) and standalone
 * (`node dist/server/index.js`, see the `server` npm script).
 */
import { configureAppTools } from './apptools';
import { configureConnectors, stopAllConnectors } from './connectors';
import { handleBridge } from './agentbridge';
import * as fs from 'fs';
import * as http from 'http';
import { WebSocketServer } from 'ws';
import * as path from 'path';
import type { Socket } from 'net';
import { handleApi, handleApiMiss, type ServerDeps } from './api';
import { Db } from './db';
import { handleCors } from './http';
import { configureProviders, migrateLegacyOpencodeKey } from './providers';
import { applyLiveSettings, configureAppSettings } from './appconfig';
import { configureCodex } from './codexcli';
import { configureSkills } from './skills';
import { killAllRuns } from './runner';
import { killAllTerminals } from './terminal';
import { stopAllBackground } from './shell';
import { subscribePermissionEvents, resolveAllPermissions, resolvePermission, pendingPermissionRequests } from './permissions';
import { attachChatWs, attachTerminalWs } from './ws';

export interface StartServerOptions {
  /** TCP port; `0` (default) picks a free one. */
  port?: number;
  host?: string;
  /** SQLite file (defaults to `OTTO_DB` / `OTTO_DB_PATH` / `<repo>/data/app.db`). */
  dbPath?: string;
  /** Folder the relative project paths resolve against. */
  workspaceRoot?: string;
  /** Static renderer export; omit to run an API-only server. */
  rendererDir?: string | null;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Monorepo root when running from `apps/desktop/dist/server/`. */
export function defaultRepoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..', '..');
}

/** Static frontend export produced by `npm run build:renderer`. */
function defaultRendererDir(): string {
  return path.resolve(__dirname, '..', '..', 'renderer');
}

function sendFile(res: http.ServerResponse, filePath: string, status = 200): void {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(status, { 'content-type': type });
    res.end(data);
  });
}

/** Static renderer: traversal guard → directory index → SPA fallback. */
function serveStatic(
  res: http.ServerResponse,
  pathname: string,
  rendererDir: string,
): void {
  const rel = pathname.replace(/^\/+/, '');
  const candidate = path.join(rendererDir, rel);

  // Path traversal guard: never escape the renderer root
  const root = path.resolve(rendererDir);
  const target = path.resolve(candidate);
  const isInsideRoot =
    target === root || target.startsWith(root + path.sep);

  if (isInsideRoot && fs.existsSync(target) && fs.statSync(target).isFile()) {
    sendFile(res, target);
    return;
  }

  // Directory-style routes (/files → /files/index.html)
  const asIndex = path.join(target, 'index.html');
  if (isInsideRoot && fs.existsSync(asIndex) && fs.statSync(asIndex).isFile()) {
    sendFile(res, asIndex);
    return;
  }

  // SPA fallback
  const fallback = path.join(root, 'index.html');
  if (fs.existsSync(fallback)) {
    sendFile(res, fallback);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Renderer build not found. Run `npm run build:renderer` first.');
}

function isApiZone(pathname: string): boolean {
  return (
    pathname === '/health' ||
    pathname.startsWith('/health/') ||
    pathname === '/v1' ||
    pathname.startsWith('/v1/') ||
    pathname === '/api' ||
    pathname.startsWith('/api/')
  );
}

async function serve(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
  rendererDir: string | null,
): Promise<void> {
  const rawUrl = req.url ?? '/';
  const cut = rawUrl.indexOf('?');
  const rawPath = cut === -1 ? rawUrl : rawUrl.slice(0, cut);
  const search = cut === -1 ? '' : rawUrl.slice(cut + 1);

  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    pathname = rawPath;
  }

  // Otto's tools for the Claude / Codex CLI runs (private per-run MCP endpoints)
  if (await handleBridge(req, res, pathname)) return;

  // FastAPI's CORSMiddleware answers preflights itself.
  if (handleCors(req, res)) return;

  if (isApiZone(pathname)) {
    const params = new URLSearchParams(search);
    const handled = await handleApi(req, res, pathname, params, deps);
    if (!handled) handleApiMiss(req, res, pathname);
    return;
  }

  if (!rendererDir) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  serveStatic(res, pathname, rendererDir);
}

/**
 * Build the single dependency object shared by REST and WebSocket handlers.
 */
export function createDeps(db: Db, workspaceRoot: string, dataDir: string): ServerDeps {
  return { db, workspaceRoot, dataDir };
}

/** Start HTTP + WebSocket (+ optional static renderer) on one port. */
export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const repoRoot = defaultRepoRoot();
  const dbPath = path.resolve(
    opts.dbPath ??
      process.env.OTTO_DB ??
      process.env.OTTO_DB_PATH ??
      path.join(repoRoot, 'data', 'app.db'),
  );
  const workspaceRoot = path.resolve(
    opts.workspaceRoot ??
      process.env.WORKSPACE_ROOT ??
      path.join(repoRoot, 'workspace'),
  );
  const db = new Db(dbPath);
  // a projects folder chosen in Settings wins over the default location
  const savedRoot = db.getSetting('workspace_root');
  const effectiveRoot = savedRoot && path.isAbsolute(savedRoot) ? savedRoot : workspaceRoot;
  try {
    fs.mkdirSync(effectiveRoot, { recursive: true });
  } catch {
    /* unusable saved folder: fall back below */
  }
  const usableRoot = fs.existsSync(effectiveRoot) ? effectiveRoot : workspaceRoot;
  fs.mkdirSync(usableRoot, { recursive: true });
  configureAppSettings((key) => db.getSetting(key));
  applyLiveSettings(db);
  configureProviders({ getSetting: (key) => db.getSetting(key) });
  configureSkills({ getSetting: (key) => db.getSetting(key), userDir: path.dirname(dbPath) });
  configureCodex({ dataDir: path.dirname(dbPath) });
  configureAppTools({ dataDir: path.dirname(dbPath) });
  configureConnectors({ dataDir: path.dirname(dbPath) });
  migrateLegacyOpencodeKey(db);
  const deps = createDeps(db, usableRoot, path.dirname(dbPath));
  const permissionClients = new Set<(item: { id: string; kind: string; action: string; target?: string }) => void>();
  const stopPermissionEvents = subscribePermissionEvents((item) => { for (const client of permissionClients) client(item); });
  const rendererDir = opts.rendererDir ?? null;
  const host = opts.host ?? '127.0.0.1';

  const sockets = new Set<Socket>();
  const permissionWss = new WebSocketServer({ noServer: true });
  permissionWss.on('connection', (ws) => {
    const send = (item: { id: string; kind: string; action: string; target?: string }) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'request', ...item }));
    };
    permissionClients.add(send);
    for (const request of pendingPermissionRequests()) send(request);
    ws.on('close', () => permissionClients.delete(send));
    ws.on('error', () => permissionClients.delete(send));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { id?: string; allow?: boolean };
        if (msg.id) resolvePermission(msg.id, msg.allow === true);
      } catch { /* ignore malformed frame */ }
    });
  });
  const server = http.createServer((req, res) => {
    serve(req, res, deps, rendererDir).catch((exc) => {
      console.error('[server] request failed:', exc);
      if (!res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"detail":"Internal Server Error"}');
      }
    });
  });
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== '/api/permissions/ws') return;
    permissionWss.handleUpgrade(req, socket, head, (ws) => permissionWss.emit('connection', ws, req));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const wss = attachChatWs(server, deps);
  const termWss = attachTerminalWs(server);

  await new Promise<void>((resolve, reject) => {
    const onError = (exc: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      db.close();
      reject(exc);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(opts.port ?? 0, host);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const url = `http://${host}:${port}`;
  // Agent tools that need host capabilities (for example Docker Desktop) call
  // the same local API as the Services UI instead of spawning from a sandboxed
  // model/CLI child process.
  const previousInternalApiUrl = process.env.OTTO_INTERNAL_API_URL;
  process.env.OTTO_INTERNAL_API_URL = `http://127.0.0.1:${port}`;
  deps.running = { 'server.port': port };

  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        void stopAllConnectors(); // the npx servers are child processes
        if (process.env.OTTO_INTERNAL_API_URL === `http://127.0.0.1:${port}`) {
          if (previousInternalApiUrl === undefined) delete process.env.OTTO_INTERNAL_API_URL;
          else process.env.OTTO_INTERNAL_API_URL = previousInternalApiUrl;
        }
        for (const socket of sockets) socket.destroy();
        resolveAllPermissions(false);
        stopPermissionEvents();
        sockets.clear();
        wss.close();
        termWss.close();
        permissionWss.close();
        killAllTerminals();
        killAllRuns();
        stopAllBackground();
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

// ---------------------------------------------------------------- standalone

async function main(): Promise<void> {
  // `.env` from the repo root, cwd second.
  const dotenv = await import('dotenv');
  const repoRoot = defaultRepoRoot();
  dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });
  dotenv.config({ quiet: true });

  const port = Number(process.env.OTTO_PORT ?? 8000);
  const rendererDir = defaultRendererDir();

  const running = await startServer({
    port,
    rendererDir: fs.existsSync(rendererDir) ? rendererDir : null,
  });
  console.log(`[server] otto server listening on ${running.url}`);
  console.log(`[server] db: ${process.env.OTTO_DB ?? path.join(repoRoot, 'data', 'app.db')}`);

  const shutdown = (): void => {
    void running.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((exc) => {
    console.error('[server] failed to start:', exc);
    process.exit(1);
  });
}
