import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isScaffoldIntoHere, withScaffoldRoom } from '../scaffold';

test('scaffold commands into the current folder are recognised', () => {
  assert.ok(isScaffoldIntoHere('composer create-project laravel/laravel .'));
  assert.ok(isScaffoldIntoHere('composer create-project laravel/laravel . --prefer-dist'));
  assert.ok(isScaffoldIntoHere('npx create-next-app@latest .'));
  assert.ok(isScaffoldIntoHere('npm create vite@latest . -- --template react'));
  assert.ok(!isScaffoldIntoHere('composer create-project laravel/laravel shop'));
  assert.ok(!isScaffoldIntoHere('composer require stripe/stripe-php'));
});

test('existing files are moved aside for the scaffolder and come back; clashes are kept as .otto-before', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-scaf-'));
  fs.writeFileSync(path.join(root, 'docker-compose.yml'), 'mine');
  fs.writeFileSync(path.join(root, '.env'), 'MY=1');
  fs.mkdirSync(path.join(root, '.git'));
  const r = await withScaffoldRoom(root, 'composer create-project laravel/laravel .', async () => {
    assert.deepEqual(fs.readdirSync(root), ['.git'], 'the scaffolder sees an empty folder');
    fs.writeFileSync(path.join(root, '.env'), 'APP_KEY=x');
    fs.writeFileSync(path.join(root, 'artisan'), '');
    return { output: 'Application ready' };
  });
  assert.equal(fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8'), 'mine');
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'APP_KEY=x');
  assert.equal(fs.readFileSync(path.join(root, '.env.otto-before'), 'utf8'), 'MY=1');
  assert.ok(fs.existsSync(path.join(root, 'artisan')));
  assert.match(r.output, /\.otto-before: \.env/);
});
