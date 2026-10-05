/**
 * Shared HTTP primitives of the embedded otto server.
 *
 * Kept in a leaf module (no local imports) so `paths.ts`, `api.ts` and
 * `extract.ts` can all use it without creating cycles. Bodies, statuses and
 * validation errors mirror FastAPI/Starlette responses byte for byte.
 */
import * as http from 'http';

/** Hard cap for request bodies (the API itself enforces its own limits). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** HTTP error carrying FastAPI's `{"detail": ...}` body. */
export class HttpError extends Error {
  readonly status: number;
  readonly detail: unknown;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    detail: unknown,
    headers?: Record<string, string>,
  ) {
    super(typeof detail === 'string' ? detail : JSON.stringify(detail));
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
    this.headers = headers;
  }
}

/** `str(exc)` — message without the `Error:` prefix. */
export function errorMessage(exc: unknown): string {
  if (exc instanceof Error) return exc.message;
  return String(exc);
}

// --------------------------------------------------------------- CORS parity
//
// FastAPI's CORSMiddleware is configured with
//   allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
//   allow_methods=["*"], allow_headers=["*"], allow_credentials=True,
// max_age=600 (the default). Every response — including redirects and error
// bodies — carries `Vary: Origin`; allowed origins get the origin echoed
// back together with `Access-Control-Allow-Credentials: true`.

export const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

/** Starlette's `ALL_METHODS` (expanded from `allow_methods=["*"]`). */
const ALLOW_METHODS = [
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
  'QUERY',
];

const PREFLIGHT_VARY =
  'Origin, Access-Control-Request-Method, Access-Control-Request-Headers, ' +
  'Access-Control-Request-Private-Network';

function allowedOrigin(req: http.IncomingMessage): string | null {
  const origin = req.headers.origin;
  return typeof origin === 'string' && ALLOWED_ORIGINS.includes(origin)
    ? origin
    : null;
}

/**
 * `CORSMiddleware` for one request.
 * Returns `true` when the request was a CORS preflight that has been answered.
 */
export function handleCors(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const isPreflight =
    req.method === 'OPTIONS' &&
    req.headers['access-control-request-method'] !== undefined;
  const origin = allowedOrigin(req);

  if (isPreflight) {
    res.setHeader('vary', PREFLIGHT_VARY);
    // Starlette keeps these on the failure response too.
    res.setHeader('access-control-allow-methods', ALLOW_METHODS.join(', '));
    res.setHeader('access-control-max-age', '600');
    res.setHeader('access-control-allow-credentials', 'true');
    const requested = req.headers['access-control-request-headers'];
    if (typeof requested === 'string' && requested) {
      res.setHeader('access-control-allow-headers', requested);
    }
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': '2',
      });
      res.end('OK');
      return true;
    }
    const failure = 'Disallowed CORS origin';
    res.writeHead(400, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(Buffer.byteLength(failure)),
    });
    res.end(failure);
    return true;
  }

  res.setHeader('vary', 'Origin');
  // Starlette adds `Access-Control-Allow-Credentials` whenever the request
  // carried an Origin header; the origin itself is only echoed when allowed.
  if (typeof req.headers.origin === 'string') {
    res.setHeader('access-control-allow-credentials', 'true');
  }
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
  }
  return false;
}

/** JSON response using Starlette's exact media type. */
export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  if (res.writableEnded) return;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(payload.length),
    ...(extraHeaders ?? {}),
  });
  res.end(payload);
}

/** `OPTIONS` preflight (FastAPI answered it from the CORS middleware). */
export function sendRedirect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  locationPath: string,
): void {
  const host = req.headers.host ?? 'localhost';
  const location = `http://${host}${locationPath}`;
  res.writeHead(307, { location });
  res.end();
}

/** Read the whole request body (or fail with FastAPI's payload error). */
export function readBody(
  req: http.IncomingMessage,
  limit = MAX_BODY_BYTES,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', fail);
      reject(err);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > limit) {
        fail(new HttpError(413, 'File is larger than 10 MB'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', fail);
  });
}

/** One FastAPI/pydantic validation error entry. */
export interface ValidationIssue {
  type: string;
  loc: (string | number)[];
  msg: string;
  input: unknown;
  ctx?: Record<string, unknown>;
}

export function missingField(
  loc: (string | number)[],
  input: unknown,
): ValidationIssue {
  return { type: 'missing', loc, msg: 'Field required', input };
}

/** Raise FastAPI's 422 with a list of validation issues. */
export function validationError(issues: ValidationIssue[]): never {
  throw new HttpError(422, issues);
}

/** Parse a required integer query parameter (`?project_id=13`). */
export function queryInt(params: URLSearchParams, name: string): number {
  const raw = params.get(name);
  if (raw === null) {
    validationError([missingField(['query', name], null)]);
  }
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    validationError([
      {
        type: 'int_parsing',
        loc: ['query', name],
        msg: 'Input should be a valid integer, unable to parse string as an integer',
        input: raw,
      },
    ]);
  }
  return parseInt(trimmed, 10);
}

/** Optional string query parameter (FastAPI default: `""`). */
export function queryString(
  params: URLSearchParams,
  name: string,
  defaultValue?: string,
): string {
  const raw = params.get(name);
  if (raw === null) {
    if (defaultValue !== undefined) return defaultValue;
    validationError([missingField(['query', name], null)]);
  }
  return raw;
}

export type BodyFieldSpec =
  | { name: string; kind: 'int' }
  | { name: string; kind: 'string' }
  | { name: string; kind: 'optString' };

/**
 * Validate a JSON object body the way pydantic does: every field is checked,
 * all issues are reported at once.
 */
export function validateBody(
  body: unknown,
  specs: BodyFieldSpec[],
): Record<string, string | number | undefined> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    validationError([
      {
        type: 'model_attributes_type',
        loc: ['body'],
        msg: 'Input should be a valid dictionary or object to extract fields from',
        input: body,
      },
    ]);
  }
  const obj = body as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  const out: Record<string, string | number | undefined> = {};

  for (const spec of specs) {
    const value = obj[spec.name];
    if (value === undefined) {
      if (spec.kind === 'optString') continue;
      issues.push(missingField(['body', spec.name], obj));
      continue;
    }
    if (spec.kind === 'optString') {
      if (value === null) continue;
      if (typeof value !== 'string') {
        issues.push({
          type: 'string_type',
          loc: ['body', spec.name],
          msg: 'Input should be a valid string',
          input: value,
        });
        continue;
      }
      out[spec.name] = value;
      continue;
    }
    if (spec.kind === 'string') {
      if (typeof value !== 'string') {
        issues.push({
          type: 'string_type',
          loc: ['body', spec.name],
          msg: 'Input should be a valid string',
          input: value,
        });
        continue;
      }
      out[spec.name] = value;
      continue;
    }
    // int
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) {
        issues.push({
          type: 'int_type',
          loc: ['body', spec.name],
          msg: 'Input should be a valid integer',
          input: value,
        });
        continue;
      }
      out[spec.name] = value;
      continue;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!/^[+-]?\d+$/.test(trimmed)) {
        issues.push({
          type: 'int_parsing',
          loc: ['body', spec.name],
          msg: 'Input should be a valid integer, unable to parse string as an integer',
          input: value,
        });
        continue;
      }
      out[spec.name] = parseInt(trimmed, 10);
      continue;
    }
    issues.push({
      type: 'int_type',
      loc: ['body', spec.name],
      msg: 'Input should be a valid integer',
      input: value,
    });
  }

  if (issues.length) validationError(issues);
  return out;
}

/** Read and parse a JSON body (422 on malformed JSON, like FastAPI). */
export async function readJsonBody(
  req: http.IncomingMessage,
): Promise<unknown> {
  const raw = await readBody(req);
  if (!raw.length) {
    validationError([
      {
        type: 'json_invalid',
        loc: ['body', 0],
        msg: 'JSON decode error',
        input: {},
        ctx: { error: 'Expecting value' },
      },
    ]);
  }
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    validationError([
      {
        type: 'json_invalid',
        loc: ['body', 0],
        msg: 'JSON decode error',
        input: {},
        ctx: { error: 'Expecting value' },
      },
    ]);
  }
}
