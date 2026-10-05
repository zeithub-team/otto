import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BASE_CSS, designGaps, wantsSite } from '../designkit';

test('an unstyled page is caught; the design kit itself passes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-design-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html><head><link rel="stylesheet" href="style.css"></head><body><h1>Кафе</h1><ul><li>Кофе - 5</li></ul><h2>Отзывы</h2><p>Здесь будут отзывы</p><form><input><button>OK</button></form></body></html>');
  fs.writeFileSync(path.join(root, 'style.css'), 'body { font-family: sans-serif; }');
  const gaps = designGaps(root, 'index.html');
  for (const g of ['too thin', 'no layout', 'no cards', 'not responsive', 'unstyled', 'placeholder']) assert.ok(gaps.some((x) => x.includes(g)), g);

  const classes = '<nav class="nav"><div class="container"><a class="logo">Утро</a></div></nav><header class="hero"><div class="container"><h1>Кафе</h1><a class="btn">Меню</a></div></header>' +
    '<section class="section"><div class="container"><div class="grid"><div class="card"><h3>Кофе <span class="price">5 ₼</span></h3></div></div></div></section><form class="form"><div class="field"><input></div><button class="btn">OK</button></form>';
  fs.writeFileSync(path.join(root, 'index.html'), `<html><head><link rel="stylesheet" href="style.css"></head><body>${classes}</body></html>`);
  fs.writeFileSync(path.join(root, 'style.css'), BASE_CSS);
  assert.deepEqual(designGaps(root, 'index.html'), []);
});

test('page work is recognised', () => {
  assert.ok(wantsSite('Создай сайт кофейни'));
  assert.ok(wantsSite('Сделай вёрстку адаптивной'));
  assert.ok(!wantsSite('Запусти сервис postgres'));
});

test('a bare page gets Otto\'s base look without its content being touched', async () => {
  const { applyBaseStyle } = await import('../designkit');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-base-'));
  const page = '<html><head><title>x</title><link rel="stylesheet" href="style.css"></head><body><h1>Кафе</h1><form><input></form></body></html>';
  fs.writeFileSync(path.join(root, 'index.html'), page);
  assert.equal(applyBaseStyle(root, 'index.html'), true);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(fs.existsSync(path.join(root, 'otto-base.css')));
  assert.ok(html.indexOf('otto-base.css') < html.indexOf('style.css'), 'the page\'s own styles load after the base and win');
  assert.ok(html.includes('<h1>Кафе</h1><form><input></form>'), 'content untouched');
  assert.equal(applyBaseStyle(root, 'index.html'), false, 'only once');
});
