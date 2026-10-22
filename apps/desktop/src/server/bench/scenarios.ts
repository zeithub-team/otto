/**
 * Multi-step reliability scenarios (Phase 13, 17.8): small Node.js workspaces with a task of
 * increasing length and a verifier that checks the RESULT on disk — never the model's own words.
 *
 * Sizes are the number of dependent actions a correct solution needs (read → edit → run …):
 *   1 — a question answered from one file
 *   3 — create a module and check it
 *   5 — find and fix a bug, run the tests
 *   10 — a rename across several files plus a new parameter, with failing tests to drive it
 *   20 — a small feature over several modules with storage, CLI and tests
 *
 * Tests shipped with a scenario are part of the task: a solution that edits them is a failure.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Verdict { ok: boolean; detail: string }

export interface Scenario {
  id: string;
  steps: number;
  prompt: string;
  files: Record<string, string>;
  /** Files the agent must not change (the task's own tests). */
  frozen?: string[];
  verify: (root: string, answer: string) => Verdict;
}

/** `node --test` in the workspace: pass/fail with the tail of the output. */
export function nodeTests(root: string): Verdict {
  const r = spawnSync(process.execPath, ['--test'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // TAP ("# pass 3") or the spec reporter ("ℹ pass 3"), depending on the Node version and the terminal
  const pass = /(?:#|ℹ) pass (\d+)/.exec(out)?.[1] ?? '0';
  const fail = /(?:#|ℹ) fail (\d+)/.exec(out)?.[1] ?? '?';
  return { ok: r.status === 0 && pass !== '0', detail: `tests pass=${pass} fail=${fail}` };
}

const read = (root: string, p: string): string => { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return ''; } };

const PKG = JSON.stringify({ name: 'bench', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2);

export const SCENARIOS: Scenario[] = [
  {
    id: 's01-answer',
    steps: 1,
    prompt: 'Какой порт указан в config.json для сервиса api? Ответь одним числом.',
    files: {
      'config.json': JSON.stringify({ services: { web: { port: 3000 }, api: { port: 4817 }, db: { port: 5432 } } }, null, 2),
    },
    verify: (_root, answer) => ({ ok: /\b4817\b/.test(answer), detail: `answer: ${answer.trim().slice(0, 80)}` }),
  },
  {
    id: 's03-module',
    steps: 3,
    prompt: 'Создай файл src/math.js (CommonJS) с функциями add(a, b) и multiply(a, b) и экспортируй их через module.exports. Проверь, что модуль загружается.',
    files: { 'package.json': PKG },
    verify: (root) => {
      const r = spawnSync(process.execPath, ['-e', "const m=require('./src/math.js');process.exit(m.add(2,3)===5&&m.multiply(4,5)===20?0:1)"], { cwd: root, encoding: 'utf8' });
      return { ok: r.status === 0, detail: r.status === 0 ? 'add/multiply work' : `require failed: ${(r.stderr || '').split('\n')[0]}` };
    },
  },
  {
    id: 's05-bugfix',
    steps: 5,
    prompt: 'Тесты в этом проекте падают. Найди и исправь ошибку в коде (тесты не меняй), затем запусти тесты командой npm test и убедись, что они проходят.',
    files: {
      'package.json': PKG,
      'src/cart.js': [
        'function total(items) {',
        '  let sum = 0;',
        '  for (const item of items) {',
        '    sum += item.price;',
        '  }',
        '  return Math.round(sum * 100) / 100;',
        '}',
        '',
        'function applyDiscount(amount, percent) {',
        '  return Math.round(amount * (1 - percent / 100) * 100) / 100;',
        '}',
        '',
        'module.exports = { total, applyDiscount };',
        '',
      ].join('\n'),
      'test/cart.test.js': [
        "const test = require('node:test');",
        "const assert = require('node:assert/strict');",
        "const { total, applyDiscount } = require('../src/cart');",
        '',
        "test('total counts quantity', () => {",
        '  assert.equal(total([{ price: 2.5, qty: 2 }, { price: 1, qty: 3 }]), 8);',
        '});',
        "test('discount', () => {",
        '  assert.equal(applyDiscount(200, 15), 170);',
        '});',
        '',
      ].join('\n'),
    },
    frozen: ['test/cart.test.js'],
    verify: (root) => nodeTests(root),
  },
  {
    id: 's10-rename',
    steps: 10,
    prompt:
      'Переименуй функцию formatPrice в formatMoney во всём проекте и добавь ей второй параметр currency со значением по умолчанию "USD": ' +
      'formatMoney(12.5) → "12.50 USD", formatMoney(3, "EUR") → "3.00 EUR". Обнови все места, где она используется. ' +
      'Тесты уже написаны под новое поведение — не меняй их. В конце запусти npm test.',
    files: {
      'package.json': PKG,
      'src/format.js': "function formatPrice(value) {\n  return value.toFixed(2) + ' USD';\n}\n\nmodule.exports = { formatPrice };\n",
      'src/invoice.js': [
        "const { formatPrice } = require('./format');",
        '',
        'function invoiceLine(name, value) {',
        '  return `${name}: ${formatPrice(value)}`;',
        '}',
        '',
        'module.exports = { invoiceLine };',
        '',
      ].join('\n'),
      'src/report.js': [
        "const { formatPrice } = require('./format');",
        '',
        'function summary(lines, currency) {',
        '  const sum = lines.reduce((s, l) => s + l.value, 0);',
        "  return 'Total ' + formatPrice(sum);",
        '}',
        '',
        'module.exports = { summary };',
        '',
      ].join('\n'),
      'test/format.test.js': [
        "const test = require('node:test');",
        "const assert = require('node:assert/strict');",
        "const { formatMoney } = require('../src/format');",
        "const { invoiceLine } = require('../src/invoice');",
        "const { summary } = require('../src/report');",
        '',
        "test('default currency', () => assert.equal(formatMoney(12.5), '12.50 USD'));",
        "test('explicit currency', () => assert.equal(formatMoney(3, 'EUR'), '3.00 EUR'));",
        "test('invoice', () => assert.equal(invoiceLine('Tea', 4), 'Tea: 4.00 USD'));",
        "test('report passes the currency', () => assert.equal(summary([{ value: 1 }, { value: 2.5 }], 'EUR'), 'Total 3.50 EUR'));",
        '',
      ].join('\n'),
    },
    frozen: ['test/format.test.js'],
    verify: (root) => {
      const t = nodeTests(root);
      const left = ['src/format.js', 'src/invoice.js', 'src/report.js'].filter((f) => /formatPrice/.test(read(root, f)));
      return { ok: t.ok && left.length === 0, detail: `${t.detail}${left.length ? `; formatPrice still in ${left.join(', ')}` : ''}` };
    },
  },
  {
    id: 's20-todo',
    steps: 20,
    prompt:
      'Сделай консольное приложение для задач на Node.js (CommonJS, без внешних пакетов). ' +
      'src/store.js: load(file) и save(file, items) — список задач в JSON-файле (если файла нет, load возвращает []). ' +
      'src/todo.js: add(items, title) → новый массив с задачей {id, title, done:false} (id = максимальный id + 1, начиная с 1), ' +
      'complete(items, id) → задача помечена done:true, remove(items, id) → без задачи, list(items) → строки вида "[ ] 1 Купить хлеб" и "[x] 2 ...". ' +
      'src/cli.js: команды node src/cli.js add <title> | done <id> | rm <id> | list, файл задач — todos.json в текущей папке. ' +
      'Тесты в test/ уже написаны — сделай так, чтобы они прошли, не меняя их. Добавь в README.md раздел «Использование» с примерами команд. В конце запусти npm test.',
    files: {
      'package.json': PKG,
      'README.md': '# Todo\n\nКонсольный список задач.\n',
      'test/todo.test.js': [
        "const test = require('node:test');",
        "const assert = require('node:assert/strict');",
        "const { add, complete, remove, list } = require('../src/todo');",
        '',
        "test('add assigns ids', () => {",
        "  let items = add([], 'A');",
        "  items = add(items, 'B');",
        "  assert.deepEqual(items.map((i) => i.id), [1, 2]);",
        '  assert.equal(items[1].done, false);',
        '});',
        "test('complete and list', () => {",
        "  const items = complete(add(add([], 'A'), 'B'), 2);",
        "  assert.deepEqual(list(items), ['[ ] 1 A', '[x] 2 B']);",
        '});',
        "test('remove', () => {",
        "  assert.deepEqual(remove(add(add([], 'A'), 'B'), 1).map((i) => i.title), ['B']);",
        '});',
        "test('add after remove keeps ids unique', () => {",
        "  const items = add(remove(add(add([], 'A'), 'B'), 1), 'C');",
        "  assert.deepEqual(items.map((i) => i.id), [2, 3]);",
        '});',
        '',
      ].join('\n'),
      'test/store.test.js': [
        "const test = require('node:test');",
        "const assert = require('node:assert/strict');",
        "const fs = require('node:fs');",
        "const os = require('node:os');",
        "const path = require('node:path');",
        "const { load, save } = require('../src/store');",
        '',
        "test('missing file is empty', () => {",
        "  assert.deepEqual(load(path.join(os.tmpdir(), 'nope-' + Date.now() + '.json')), []);",
        '});',
        "test('save then load', () => {",
        "  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-')), 'todos.json');",
        "  save(f, [{ id: 1, title: 'A', done: false }]);",
        "  assert.deepEqual(load(f), [{ id: 1, title: 'A', done: false }]);",
        '});',
        '',
      ].join('\n'),
      'test/cli.test.js': [
        "const test = require('node:test');",
        "const assert = require('node:assert/strict');",
        "const fs = require('node:fs');",
        "const os = require('node:os');",
        "const path = require('node:path');",
        "const { execFileSync } = require('node:child_process');",
        "const cli = path.join(__dirname, '..', 'src', 'cli.js');",
        '',
        "test('cli add, done, list', () => {",
        "  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-'));",
        "  const run = (...a) => execFileSync(process.execPath, [cli, ...a], { cwd: dir, encoding: 'utf8' });",
        "  run('add', 'Milk');",
        "  run('add', 'Bread');",
        "  run('done', '1');",
        "  const out = run('list');",
        "  assert.match(out, /\\[x\\] 1 Milk/);",
        "  assert.match(out, /\\[ \\] 2 Bread/);",
        "  assert.ok(fs.existsSync(path.join(dir, 'todos.json')));",
        '});',
        '',
      ].join('\n'),
    },
    frozen: ['test/todo.test.js', 'test/store.test.js', 'test/cli.test.js'],
    verify: (root) => {
      const t = nodeTests(root);
      const readme = /Использование/i.test(read(root, 'README.md'));
      return { ok: t.ok && readme, detail: `${t.detail}${readme ? '' : '; README has no «Использование»'}` };
    },
  },
];

/** Write a scenario's files into a fresh folder. */
export function materialize(s: Scenario, root: string): void {
  for (const [rel, text] of Object.entries(s.files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

/** Frozen files the agent changed (a task's own tests must stay as given). */
export function tampered(s: Scenario, root: string): string[] {
  return (s.frozen ?? []).filter((rel) => read(root, rel) !== s.files[rel]);
}
