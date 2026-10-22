/**
 * Local API guard (review P0-2/3): the server listens on 127.0.0.1, but any web page in the user's
 * browser could still call it. The desktop app sets OTTO_SESSION_TOKEN (random per launch) and gives it
 * to its own window through the preload; every /api request and WebSocket must carry it, and a
 * foreign Origin is refused. Without OTTO_SESSION_TOKEN (standalone `npm run server`, tests) the
 * check is off, as before.
 */
import type * as http from 'node:http';

export const TOKEN_HEADER = 'x-otto-token';

export const sessionToken = (): string => process.env.OTTO_SESSION_TOKEN ?? '';

/** Headers for Otto's own server-side calls to its API. */
export const internalHeaders = (): Record<string, string> => (sessionToken() ? { [TOKEN_HEADER]: sessionToken() } : {});

const LOCAL_ORIGIN = /^(https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?|file:\/\/|null)$/i;

/** null = allowed; otherwise why the request is refused. */
export function checkAccess(req: http.IncomingMessage): string | null {
  const token = sessionToken();
  if (!token) return null;
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGIN.test(origin)) return 'foreign origin';
  const url = req.url ?? '';
  const q = url.indexOf('?');
  const fromQuery = q >= 0 ? new URLSearchParams(url.slice(q + 1)).get('otto_token') : null;
  const given = String(req.headers[TOKEN_HEADER] ?? '') || fromQuery || '';
  return given === token ? null : 'missing or wrong session token';
}
