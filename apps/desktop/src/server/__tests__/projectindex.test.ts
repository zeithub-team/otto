import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectIndex, extractWords, fuzzyMatch } from '../projectindex';

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-index-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const SAMPLE = {
  'src/UserService.ts': 'export class UserService {\n  findUser(id: number) { return this.repository.load(id); }\n  deleteUser(id: number) {}\n}\n',
  'src/OrderService.ts': 'import { UserService } from "./UserService";\nexport class OrderService {\n  placeOrder() {}\n  cancelOrder() {}\n}\nconst userCount = 3;\n',
  'src/util/strings.ts': 'export function capitalizeWords(s: string) { return s; }\n',
  'README.md': '# Readme\nUserService is documented here\n',
  'node_modules/dep/index.js': 'class Hidden {}\n',
  'logo.png': '\u0000PNG',
};

test('index lists project files (skipping node_modules) and finds symbols without rescanning', async () => {
  const idx = new ProjectIndex(project(SAMPLE));
  await idx.ensure();
  try {
    assert.deepEqual(idx.listFiles(), ['README.md', 'logo.png', 'src/OrderService.ts', 'src/UserService.ts', 'src/util/strings.ts']);
    assert.ok(idx.searchSymbols('userserv').some((s) => s.name === 'UserService' && s.path === 'src/UserService.ts'));
    assert.equal(idx.searchSymbols('Hidden').length, 0);
    // camelCase humps: "cw" → capitalizeWords
    assert.ok(idx.searchSymbols('cw').some((s) => s.name === 'capitalizeWords'));
    assert.ok(idx.stats.symbols >= 6 && idx.stats.words > 10);
  } finally { idx.close(); }
});

test('quick open: fuzzy on the path, file name matches first', async () => {
  const idx = new ProjectIndex(project(SAMPLE));
  await idx.ensure();
  try {
    assert.equal(idx.quickOpen('usrsrv')[0].path, 'src/UserService.ts');
    assert.equal(idx.quickOpen('str')[0].path, 'src/util/strings.ts');
    assert.equal(idx.quickOpen('ordserv')[0].path, 'src/OrderService.ts');
    assert.equal(idx.quickOpen('zzzz').length, 0);
    const hit = idx.quickOpen('uServ')[0];
    assert.ok(hit.positions.length === 5 && hit.positions.every((p, i) => i === 0 || p > hit.positions[i - 1]));
    assert.equal(idx.quickOpen('', 3).length, 3); // empty query lists files
  } finally { idx.close(); }
});

test('the index follows edits, new files and deletions incrementally', async () => {
  const root = project(SAMPLE);
  const idx = new ProjectIndex(root);
  await idx.ensure();
  try {
    fs.writeFileSync(path.join(root, 'src/OrderService.ts'), 'export class OrderService {\n  refundOrder() {}\n}\n');
    fs.writeFileSync(path.join(root, 'src/NewThing.ts'), 'export function brandNewFunction() {}\n');
    fs.rmSync(path.join(root, 'src/util'), { recursive: true });
    await idx.updatePaths(['src/OrderService.ts', 'src/NewThing.ts', 'src/util']);
    assert.ok(idx.searchSymbols('refundOrder').length === 1);
    assert.equal(idx.searchSymbols('placeOrder').length, 0, 'stale symbols are dropped');
    assert.ok(idx.searchSymbols('brandNewFunction').length === 1);
    assert.equal(idx.searchSymbols('capitalizeWords').length, 0);
    assert.ok(!idx.listFiles().includes('src/util/strings.ts'));
    // words are counted per file and released with it
    assert.equal(idx.complete({ prefix: 'capitalizeW' }).length, 0);
  } finally { idx.close(); }
});

test('completion: prefix, camelCase humps, kinds and same-file boost', async () => {
  const idx = new ProjectIndex(project(SAMPLE));
  await idx.ensure();
  try {
    const byPrefix = idx.complete({ prefix: 'User', path: 'src/OrderService.ts' });
    assert.equal(byPrefix[0].label, 'UserService');
    assert.equal(byPrefix[0].kind, 'class');
    // "uc" is not a prefix of anything but hump-matches userCount
    assert.ok(idx.complete({ prefix: 'uCo' }).some((c) => c.label === 'userCount'));
    // the word already typed is not offered back
    assert.ok(!idx.complete({ prefix: 'placeOrder' }).some((c) => c.label === 'placeOrder'));
    assert.deepEqual(idx.complete({ prefix: '' }), []);
  } finally { idx.close(); }
});

test('completion after a dot lists only the members of that class (this / variable named like the class)', async () => {
  const idx = new ProjectIndex(project(SAMPLE));
  await idx.ensure();
  try {
    const viaVar = idx.complete({ prefix: '', container: 'userService' }).map((c) => c.label).sort();
    assert.deepEqual(viaVar, ['deleteUser', 'findUser']);
    assert.deepEqual(idx.complete({ prefix: 'del', container: 'UserService' }).map((c) => c.label), ['deleteUser']);
    // this. inside OrderService (line 3) → its own methods
    const self = idx.complete({ prefix: '', container: 'this', path: 'src/OrderService.ts', line: 3 }).map((c) => c.label).sort();
    assert.deepEqual(self, ['cancelOrder', 'placeOrder']);
  } finally { idx.close(); }
});

test('a one-line interface does not swallow the declarations after it', async () => {
  const idx = new ProjectIndex(project({
    'src/main.ts': 'export interface Item { id: number }\nexport function makeItem(id: number) { return { id }; }\nclass Box {\n  open() {}\n}\nexport function afterBox() {}\n',
  }));
  await idx.ensure();
  try {
    const kinds = Object.fromEntries(idx.allSymbols().map((s) => [s.name, `${s.kind}${s.container ? `@${s.container}` : ''}`]));
    assert.equal(kinds.makeItem, 'function');
    assert.equal(kinds.open, 'method@Box');
    assert.equal(kinds.afterBox, 'function', 'the class body ends at its closing brace');
  } finally { idx.close(); }
});

test('fuzzyMatch and extractWords', () => {
  assert.ok(fuzzyMatch('gus', 'getUserService'));
  assert.equal(fuzzyMatch('xyz', 'getUserService'), null);
  assert.ok(fuzzyMatch('us', 'UserService')!.score > fuzzyMatch('us', 'housekeeping')!.score, 'word start beats the middle of a word');
  assert.deepEqual(extractWords('const fooBar = foo_bar + fooBar; a b').sort(), ['const', 'fooBar', 'foo_bar'].sort());
  assert.ok(extractWords('переменная = 1').includes('переменная'));
});
