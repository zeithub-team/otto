import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFakeToolCalls, pastedCode } from '../ollama';

test('a pretty-printed JSON tool call in the text is executed (Qwen coder style)', () => {
  const text = 'Сейчас подключусь.\n```json\n{\n  "name": "ssh_connect",\n  "arguments": {\n    "host": "10.0.0.5",\n    "user": "root"\n  }\n}\n```';
  const { calls } = extractFakeToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function?.name, 'ssh_connect');
  assert.deepEqual(calls[0].function?.arguments, { host: '10.0.0.5', user: 'root' });
});

test('code pasted into the chat is caught; a short command for the user is not', () => {
  assert.equal(pastedCode('Готово:\n```html\n<!doctype html>\n<html>\n<body>\n<h1>Coffee</h1>\n</body>\n</html>\n```'), true);
  assert.equal(pastedCode('Запустите:\n```bash\nnpm run dev\n```'), false);
  assert.equal(pastedCode('Используйте `npm i`.'), false);
  // a cut-off block still counts
  assert.equal(pastedCode('```ts\nexport function a() {\n  return 1;\n}\nexport const b = 2;\n'), true);
});

test('a write that breaks a file is reported to the model right away', async () => {
  const { writeWarnings } = await import('../ollama');
  // a closing brace lost in a CSS edit
  assert.match(writeWarnings('style.css', 'body {\n  color: #111;\n}\n', 'body {\n  color: #fff;\n'), /brackets/);
  // an empty code file
  assert.match(writeWarnings('utils.js', null, '   '), /EMPTY/);
  // most of a file thrown away by a "small" edit
  assert.match(writeWarnings('style.css', 'body {\n margin: 0;\n background: #fff;\n color: #111;\n}\nh1 { font-size: 32px; }\n', 'body { background: #222; }\n'), /most of the file was removed/);
  // a good edit says nothing
  assert.equal(writeWarnings('style.css', 'body {\n  color: #111;\n}\n', 'body {\n  color: #fff;\n}\n'), '');
});

test('files the request names but nobody wrote are noticed', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { missingRequestedFiles } = await import('../ollama');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-missing-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<button>x</button>');
  assert.deepEqual(missingRequestedFiles('Создай index.html с кнопкой и подключи script.js', root), ['script.js']);
  assert.deepEqual(missingRequestedFiles('Что в index.html?', root), [], 'no creation asked');
});

test('a page rewrite that drops finished blocks is reported', async () => {
  const { writeWarnings } = await import('../ollama');
  const before = '<section><h2>Меню</h2><ul><li>Эспрессо 5 ₼</li><li>Латте 6 ₼</li></ul></section><section><form><input></form></section><script src="script.js"></script>';
  const after = '<section class="section"><h2>Меню</h2></section><script src="script.js"></script>';
  const w = writeWarnings('index.html', before, after);
  assert.match(w, /REMOVED/);
  assert.match(w, /form 1→0/);
  assert.match(w, /prices 2→0/);
  // adding a block removes nothing
  assert.equal(writeWarnings('index.html', before, before + '<footer>x</footer>'), '');
});
