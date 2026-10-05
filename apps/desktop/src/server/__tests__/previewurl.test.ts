import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localServerUrl, normalizePreviewUrl, wantsPreview } from '../apptools';
import { claimsAction } from '../ollama';

test('the address a dev server printed goes to the Preview', () => {
  assert.equal(localServerUrl('INFO  Server running on [http://127.0.0.1:8080].'), 'http://127.0.0.1:8080/');
  assert.equal(localServerUrl('  ➜  Local:   http://localhost:5173/\n'), 'http://localhost:5173/');
  assert.equal(localServerUrl('listening on http://0.0.0.0:3000'), 'http://127.0.0.1:3000/');
  assert.equal(localServerUrl('see https://laravel.com/docs'), null);
  assert.equal(normalizePreviewUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080/');
  assert.equal(normalizePreviewUrl('file:///C:/x.html'), null);
});

test('"open the preview" is understood in the request', () => {
  assert.ok(wantsPreview('подними весь проект и открой превью'));
  assert.ok(!wantsPreview('сколько таблиц в базе'));
});

test('an answer that reports work is noticed', () => {
  assert.ok(claimsAction('Запускаю Laravel dev-сервер на порту 8080. Превью открыт.'));
  assert.ok(!claimsAction('В проекте две базы: MariaDB и PostgreSQL.'));
});
