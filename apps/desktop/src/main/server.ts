import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { startServer, type RunningServer } from '../server/index';
import { configuredPort } from '../server/appconfig';

export type EmbeddedServer = RunningServer;

/**
 * Repository root in a dev checkout (`<repo>/apps/desktop` → `<repo>`); `null`
 * in the packaged app, where nothing ships outside the app bundle.
 */
function repoRoot(): string | null {
  if (app.isPackaged) return null;
  return path.resolve(app.getAppPath(), '..', '..');
}

/** Read `.env` (repo root in dev, then userData). */
function loadEnv(root: string | null): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require('dotenv') as typeof import('dotenv');
  const candidates = [
    ...(root ? [path.join(root, '.env')] : []),
    path.join(app.getPath('userData'), '.env'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) dotenv.config({ path: candidate, quiet: true });
  }
}

/** `OTTO_DB(_PATH)` → `<userData>/app.db`, seeded from `<repo>/data/app.db`. */
function resolveDbPath(root: string | null): string {
  const explicit = process.env.OTTO_DB ?? process.env.OTTO_DB_PATH;
  if (explicit) return path.resolve(explicit);

  const target = path.join(app.getPath('userData'), 'app.db');
  if (!fs.existsSync(target) && root) {
    const seed = path.join(root, 'data', 'app.db');
    if (fs.existsSync(seed)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(seed, target);
    }
  }
  return target;
}

/** `WORKSPACE_ROOT` → `<repo>/workspace` (dev) / `<userData>/workspace`. */
function resolveWorkspaceRoot(root: string | null): string {
  const explicit = process.env.WORKSPACE_ROOT;
  if (explicit) return path.resolve(explicit);
  return root
    ? path.join(root, 'workspace')
    : path.join(app.getPath('userData'), 'workspace');
}

/** Preferred fixed port for the packaged app (keeps the renderer origin stable
 *  across restarts, so localStorage — themes, service configs, starred, chat
 *  cache — survives). Falls back to nearby ports, then to a random one. */
const PREFERRED_PORT = 43117;

/**
 * Local HTTP server for the app: hosts the static frontend, the REST API and
 * the chat WebSocket on one origin so the renderer never needs a port.
 *
 * In dev a caller-provided `port` (8000) is used. In production a stable port
 * is chosen so the origin — and therefore the browser's localStorage — stays
 * the same on every launch instead of resetting with a random ephemeral port.
 */
export async function startEmbeddedServer(
  opts: { port?: number } = {},
): Promise<EmbeddedServer> {
  const root = repoRoot();
  loadEnv(root);

  const base = {
    host: '127.0.0.1',
    dbPath: resolveDbPath(root),
    workspaceRoot: resolveWorkspaceRoot(root),
    // Both modes: the renderer export lives inside the app directory (and is
    // read through asar in the packaged build).
    rendererDir: path.join(app.getAppPath(), 'renderer'),
  };

  // Explicit port (dev) — honour it as-is.
  if (opts.port !== undefined && opts.port !== 0) {
    return startServer({ ...base, port: opts.port });
  }

  // Production: try a stable preferred port, then a few neighbours, so the
  // origin is deterministic across restarts. Random port only as last resort.
  // Settings → Server writes the port to config.json in the user data folder
  const preferred = configuredPort(app.getPath('userData'), { ...process.env, OTTO_PORT: process.env.OTTO_PORT ?? String(PREFERRED_PORT) });
  for (let p = preferred; p <= preferred + 15; p++) {
    try {
      return await startServer({ ...base, port: p });
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw exc;
    }
  }
  return startServer({ ...base, port: 0 });
}
