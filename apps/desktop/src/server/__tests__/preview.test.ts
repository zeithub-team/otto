/** Browser verification tools. Skipped when no Edge/Chrome is installed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findBrowser, previewPage, runInPage } from '../preview';

const skip = findBrowser() ? false : 'no Chromium-based browser installed';

// The classic defect: the success message lives INSIDE the form that gets hidden.
const BUGGY = `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>
<h1>Hello</h1><p>Some visible text so the page is not empty at all.</p>
<form id="f"><input id="e" type="email"><button type="submit">Go</button>
<div id="ok" hidden>Thanks!</div></form>
<script>
document.getElementById('f').addEventListener('submit', function (ev) {
  ev.preventDefault();
  document.getElementById('f').hidden = true;
  document.getElementById('ok').hidden = false;
});
</script></body></html>`;

function page(html: string): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-prev-'));
  const file = path.join(root, 'index.html');
  fs.writeFileSync(file, html);
  return { root, file };
}

test('run_in_page exposes a success message hidden together with its form', { skip }, async () => {
  const { file } = page(BUGGY);
  const out = await runInPage(
    file,
    `$('#e').value = 'a@b.co'; $('#f').requestSubmit(); await wait(100); return { okVisible: visible($('#ok')) };`,
  );
  assert.match(out, /"okVisible":\s*false/);
});

test('preview_page reports console errors and phone overflow', { skip }, async () => {
  const { root, file } = page(
    `<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body>
<h1>Wide</h1><p>Some visible text so the page is not empty at all.</p>
<div style="width:900px;height:10px;background:red"></div>
<script>nope();</script></body></html>`,
  );
  const result = await previewPage(root, file);
  assert.match(result.report, /НАЙДЕНЫ ПРОБЛЕМЫ/);
  assert.match(result.report, /375px/);
  assert.match(result.report, /ошибки консоли/);
  assert.ok(result.screenshot && result.screenshot.length > 100);
});

test('preview_page passes a clean page', { skip }, async () => {
  const { root, file } = page(
    `<!doctype html><html><head><meta charset="utf-8"><title>ok</title></head><body>
<h1>Clean</h1><p>Some visible text so the page is not empty at all, long enough.</p></body></html>`,
  );
  const result = await previewPage(root, file);
  assert.match(result.report, /Проблем не найдено/);
});
