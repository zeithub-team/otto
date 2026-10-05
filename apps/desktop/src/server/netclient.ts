/**
 * Network helpers behind the API tab: a request proxy for local hosts (no CORS
 * from the browser), a scan for local servers, and OpenAPI docs — found on a
 * running server, in the project, or generated from the detected routes.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { projectNav, type RouteEntry } from './nav';

// ---------------------------------------------------------------------------
// Which hosts may be reached
// ---------------------------------------------------------------------------

/** Loopback, `*.localhost` and private-network addresses only: this is a tool for local development. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === 'host.docker.internal') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// ---------------------------------------------------------------------------
// Request proxy
// ---------------------------------------------------------------------------

export interface ProxyRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface ProxyResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  ms: number;
  size: number;
}

const MAX_BODY = 1_000_000;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export async function proxyRequest(req: ProxyRequest): Promise<ProxyResponse> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs can be requested');
  if (!isLocalHost(url.hostname)) throw new Error(`Only local hosts are allowed (localhost, 127.x, 10.x, 172.16–31.x, 192.168.x), not ${url.hostname}`);
  const method = (req.method || 'GET').toUpperCase();
  if (!METHODS.has(method)) throw new Error(`Unsupported method ${method}`);

  const started = Date.now();
  const res = await fetch(url, {
    method,
    headers: req.headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : req.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(Math.min(Math.max(req.timeoutMs ?? 15_000, 500), 60_000)),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => (headers[key] = value));
  return {
    status: res.status,
    statusText: res.statusText,
    headers,
    body: buf.subarray(0, MAX_BODY).toString('utf8'),
    truncated: buf.length > MAX_BODY,
    ms: Date.now() - started,
    size: buf.length,
  };
}

// ---------------------------------------------------------------------------
// Scan for local servers
// ---------------------------------------------------------------------------

export interface LocalServer {
  port: number;
  http: { status: number; server: string } | null;
  /** Paths that answered an HTTP Upgrade with 101. */
  websocket: string[];
}

const SCAN_PORTS = [
  80, 3000, 3001, 3002, 3003, 4000, 4200, 4321, 5000, 5001, 5173, 5174, 6001, 8000, 8001, 8002, 8008,
  8080, 8081, 8082, 8090, 8100, 8443, 8888, 9000, 9001, 1234, 24678,
];
const WS_PATHS = ['/', '/ws', '/websocket', '/socket', '/socket.io/?EIO=4&transport=websocket', '/app', '/cable'];

function portOpen(port: number, host = '127.0.0.1', timeout = 350): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function httpProbe(port: number, path_ = '/'): Promise<{ status: number; server: string } | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: path_, timeout: 800, headers: { accept: 'text/html,*/*' } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, server: String(res.headers['x-powered-by'] ?? res.headers.server ?? '') });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

/** True when `path_` answers a WebSocket upgrade handshake with 101. */
function wsProbe(port: number, path_: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: path_,
      timeout: 800,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('otto-scan-probe!').toString('base64'),
      },
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(true);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(false);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

export async function scanLocalServers(extraPorts: number[] = []): Promise<LocalServer[]> {
  const ports = [...new Set([...SCAN_PORTS, ...extraPorts.filter((p) => p > 0 && p < 65536)])];
  const open = (await Promise.all(ports.map(async (p) => ((await portOpen(p)) ? p : 0)))).filter(Boolean);
  const found = await Promise.all(
    open.map(async (port): Promise<LocalServer> => {
      const httpInfo = await httpProbe(port);
      const results = await Promise.all(WS_PATHS.map(async (p) => ((await wsProbe(port, p)) ? p : '')));
      return { port, http: httpInfo, websocket: results.filter(Boolean) };
    }),
  );
  return found.sort((a, b) => a.port - b.port);
}

// ---------------------------------------------------------------------------
// OpenAPI
// ---------------------------------------------------------------------------

export type OpenApiDoc = Record<string, unknown> & { paths?: Record<string, Record<string, unknown>> };

export interface OpenApiResult {
  source: 'server' | 'file' | 'generated';
  /** URL (server), project-relative file (file) or a note (generated). */
  origin: string;
  spec: OpenApiDoc;
  endpoints: number;
  notes: string[];
}

const SPEC_URLS = ['/openapi.json', '/swagger.json', '/v3/api-docs', '/api/openapi.json', '/api-docs', '/docs/openapi.json', '/swagger/v1/swagger.json', '/api/docs.json', '/docs.json', '/openapi.yaml', '/api/openapi.yaml'];
const SPEC_FILES = ['openapi.json', 'openapi.yaml', 'openapi.yml', 'swagger.json', 'swagger.yaml', 'swagger.yml', 'docs/openapi.json', 'docs/openapi.yaml', 'docs/openapi.yml', 'docs/swagger.json', 'api/openapi.json', 'api/openapi.yaml', 'public/openapi.json', 'public/swagger.json', 'storage/api-docs/api-docs.json', 'openapi.generated.json'];

const isSpec = (value: unknown): value is OpenApiDoc =>
  Boolean(value) && typeof value === 'object' && ('openapi' in (value as object) || 'swagger' in (value as object)) && typeof (value as OpenApiDoc).paths === 'object';

const countEndpoints = (spec: OpenApiDoc): number =>
  Object.values(spec.paths ?? {}).reduce((n, item) => n + Object.keys(item).filter((k) => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(k)).length, 0);

/** A spec served by the running app (FastAPI, NestJS, Spring, Swagger UI setups, …). */
export async function probeSpecServer(base: string): Promise<OpenApiResult | null> {
  let root: URL;
  try {
    root = new URL(base);
  } catch {
    return null;
  }
  if (!isLocalHost(root.hostname)) return null;
  for (const suffix of SPEC_URLS) {
    const url = new URL(suffix, root).toString();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500), headers: { accept: 'application/json, application/yaml, */*' } });
      if (!res.ok) continue;
      const text = await res.text();
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch {
        try {
          doc = parseYaml(text);
        } catch {
          continue;
        }
      }
      if (isSpec(doc)) return { source: 'server', origin: url, spec: doc, endpoints: countEndpoints(doc), notes: [] };
    } catch {
      /* not there */
    }
  }
  return null;
}

/** A spec file kept in the project. */
export function findSpecFile(root: string): OpenApiResult | null {
  for (const rel of SPEC_FILES) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    try {
      const text = fs.readFileSync(file, 'utf8');
      const doc = rel.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
      if (isSpec(doc)) return { source: 'file', origin: rel, spec: doc, endpoints: countEndpoints(doc), notes: [] };
    } catch {
      /* unreadable: try the next candidate */
    }
  }
  return null;
}

/** `/users/:id`, `/users/[id]`, `/users/<int:id>` and Laravel `{id?}` → OpenAPI `{id}`. */
export function normalizePath(uri: string): { path: string; params: string[] } {
  const params: string[] = [];
  let out = uri.trim();
  if (!out.startsWith('/')) out = `/${out}`;
  out = out
    .replace(/<(?:\w+:)?(\w+)>/g, (_m, n: string) => (params.push(n), `{${n}}`))
    .replace(/:([A-Za-z_]\w*)\??/g, (_m, n: string) => (params.push(n), `{${n}}`))
    .replace(/\[\.{3}(\w+)\]/g, (_m, n: string) => (params.push(n), `{${n}}`))
    .replace(/\[(\w+)\]/g, (_m, n: string) => (params.push(n), `{${n}}`))
    .replace(/\{(\w+)\?\}/g, (_m, n: string) => (params.push(n), `{${n}}`));
  for (const m of out.matchAll(/\{(\w+)\}/g)) if (!params.includes(m[1])) params.push(m[1]);
  return { path: out.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1'), params };
}

const camel = (text: string): string =>
  text.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toLowerCase());

function projectTitle(root: string): string {
  for (const file of ['package.json', 'composer.json']) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) as { name?: string };
      if (data.name) return data.name;
    } catch {
      /* next */
    }
  }
  return path.basename(root);
}

/** An OpenAPI 3.0 skeleton from the routes the IDE detected (Laravel, FastAPI, Express, Next.js). */
export function generateOpenApi(root: string, base = 'http://localhost:8000'): OpenApiResult {
  const nav = projectNav(root);
  const notes: string[] = [];
  const paths: Record<string, Record<string, unknown>> = {};
  let skipped = 0;
  for (const route of nav.routes as RouteEntry[]) {
    // Next.js pages are not an API; middleware-style `use` mounts are not endpoints either
    if (/page\.(tsx|jsx)$/.test(route.file) || route.method.toUpperCase() === 'USE') {
      skipped++;
      continue;
    }
    const methods = route.method
      .split('|')
      .map((m) => m.trim().toLowerCase())
      .map((m) => (m === 'any' || m === 'all' ? 'get' : m))
      .filter((m) => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(m) && m !== 'head');
    if (!methods.length) {
      skipped++;
      continue;
    }
    const { path: oaPath, params } = normalizePath(route.uri);
    const item = (paths[oaPath] ??= {});
    for (const method of methods) {
      const handler = route.action && route.controller ? `${route.controller}@${route.action}` : route.controller || route.action || '';
      const op: Record<string, unknown> = {
        summary: handler ? `${method.toUpperCase()} ${oaPath} — ${handler}` : `${method.toUpperCase()} ${oaPath}`,
        operationId: camel(`${method} ${oaPath}`),
        tags: [oaPath.split('/').filter(Boolean)[0]?.replace(/[{}]/g, '') || 'root'],
        responses: { '200': { description: 'OK' }, '4XX': { description: 'Client error' } },
        'x-source': `${route.file}:${route.line}`,
      };
      if (params.length) op.parameters = params.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
      if (method === 'post' || method === 'put' || method === 'patch') {
        op.requestBody = { content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } };
      }
      item[method] = op;
    }
  }
  const spec: OpenApiDoc = {
    openapi: '3.0.3',
    info: { title: projectTitle(root), version: '0.1.0', description: 'Generated by zeithub.otto from the routes found in the source code. Schemas are placeholders.' },
    servers: [{ url: base }],
    paths,
  };
  if (skipped) notes.push(`skipped ${skipped} non-API route(s)`);
  if (!Object.keys(paths).length) notes.push('no API routes were found in the source');
  else notes.push('request/response schemas are placeholders — refine them or serve a real spec (e.g. FastAPI /openapi.json)');
  return { source: 'generated', origin: `${nav.stack} routes`, spec, endpoints: countEndpoints(spec), notes };
}

/** Best spec available: the running server, then a file in the project, then the routes. */
export async function collectOpenApi(root: string, base: string | null): Promise<OpenApiResult> {
  if (base) {
    const served = await probeSpecServer(base);
    if (served) return served;
  }
  const file = findSpecFile(root);
  if (file) return file;
  const generated = generateOpenApi(root, base ?? 'http://localhost:8000');
  if (base) generated.notes.unshift(`no OpenAPI spec was served by ${base}`);
  return generated;
}

/** Write the spec into the project (never over a hand-written file: generated specs get their own name). */
export function saveOpenApi(root: string, spec: OpenApiDoc, format: 'json' | 'yaml' = 'json'): string {
  const rel = `openapi.generated.${format === 'yaml' ? 'yaml' : 'json'}`;
  const body = format === 'yaml' ? stringifyYaml(spec) : `${JSON.stringify(spec, null, 2)}\n`;
  fs.writeFileSync(path.join(root, rel), body, 'utf8');
  return rel;
}
