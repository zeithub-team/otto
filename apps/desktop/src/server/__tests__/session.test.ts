import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as http from 'node:http';
import { checkAccess } from '../session';

const req = (url: string, headers: Record<string, string> = {}) => ({ url, headers } as unknown as http.IncomingMessage);

test('without OTTO_SESSION_TOKEN the API stays open (standalone server, tests)', () => {
  delete process.env.OTTO_SESSION_TOKEN;
  assert.equal(checkAccess(req('/api/projects/')), null);
});

test('with a session token: header or query token passes, anything else is refused', () => {
  process.env.OTTO_SESSION_TOKEN = 'secret';
  try {
    assert.equal(checkAccess(req('/api/projects/', { 'x-otto-token': 'secret' })), null);
    assert.equal(checkAccess(req('/api/chat/ws/chat?otto_token=secret')), null);
    assert.match(checkAccess(req('/api/projects/')) ?? '', /token/);
    assert.match(checkAccess(req('/api/projects/', { 'x-otto-token': 'wrong' })) ?? '', /token/);
    assert.match(checkAccess(req('/api/projects/', { 'x-otto-token': 'secret', origin: 'https://evil.example' })) ?? '', /origin/);
    assert.equal(checkAccess(req('/api/projects/', { 'x-otto-token': 'secret', origin: 'http://127.0.0.1:8000' })), null);
  } finally { delete process.env.OTTO_SESSION_TOKEN; }
});
