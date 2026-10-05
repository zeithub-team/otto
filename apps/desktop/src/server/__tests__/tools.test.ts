import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFakeToolCalls, normalizeToolCall, runTool } from '../ollama';
import { projectSkipDirs } from '../paths';
import { htmlToText, parseBing, parseDdgHtml, parseLite, runWebTool, unwrapBing } from '../web';

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'otto-test-'));
}

test('write_file creates and overwrites files', () => {
  const root = tmpProject();
  assert.match(runTool(root, 'write_file', { path: 'a/b.txt', content: 'one' }), /CREATED/);
  assert.match(runTool(root, 'write_file', { path: 'a/b.txt', content: 'two' }), /overwritten/);
  assert.equal(fs.readFileSync(path.join(root, 'a/b.txt'), 'utf8'), 'two');
});

test('write_file without content never wipes an existing file', () => {
  const root = tmpProject();
  fs.writeFileSync(path.join(root, 'keep.txt'), 'precious');
  const out = runTool(root, 'write_file', { path: 'keep.txt' });
  assert.match(out, /без 'content'/);
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'precious');
});

test('explicit empty content is allowed', () => {
  const root = tmpProject();
  runTool(root, 'write_file', { path: 'empty.txt', content: '' });
  assert.equal(fs.readFileSync(path.join(root, 'empty.txt'), 'utf8'), '');
});

test('tool and argument aliases are understood', () => {
  const root = tmpProject();
  runTool(root, 'create_file', { file_path: 'x.md', text: '# hi' });
  assert.equal(fs.readFileSync(path.join(root, 'x.md'), 'utf8'), '# hi');
  assert.deepEqual(normalizeToolCall('grep', { q: 'foo' }), { name: 'search_files', args: { query: 'foo' } });
});

test('arguments given as a JSON string are parsed', () => {
  const root = tmpProject();
  runTool(root, 'write_file', JSON.stringify({ path: 's.txt', content: 'from string' }));
  assert.equal(fs.readFileSync(path.join(root, 's.txt'), 'utf8'), 'from string');
});

test('non-object arguments return a tool error instead of throwing', () => {
  assert.match(runTool(tmpProject(), 'read_file', 'not json'), /^Tool failed/);
});

test('append_file builds a large file in parts', () => {
  const root = tmpProject();
  runTool(root, 'write_file', { path: 'big.txt', content: 'part1\n' });
  runTool(root, 'append_file', { path: 'big.txt', content: 'part2\n' });
  assert.equal(fs.readFileSync(path.join(root, 'big.txt'), 'utf8'), 'part1\npart2\n');
});

test('paths cannot escape the project root', () => {
  const root = tmpProject();
  assert.throws(() => runTool(root, 'write_file', { path: '../evil.txt', content: 'x' }), /outside/);
  assert.throws(() => runTool(root, 'read_file', { path: '../../etc/passwd' }), /outside/);
});

test('delete_file refuses the project root', () => {
  const root = tmpProject();
  assert.match(runTool(root, 'delete_file', { path: '.' }), /Refusing/);
});

test('fake tool calls: XML and JSON formats are extracted', () => {
  const xml = extractFakeToolCalls(
    'ok <function=write_file><parameter=path>a.txt</parameter><parameter=content>hi</parameter></function> done',
  );
  assert.equal(xml.calls.length, 1);
  assert.deepEqual(xml.calls[0].function?.arguments, { path: 'a.txt', content: 'hi' });
  assert.ok(!xml.cleaned.includes('<function'));

  const json = extractFakeToolCalls('{"name":"write_file","arguments":{"path":"b.txt","content":"x {y}"}}');
  assert.equal(json.calls.length, 1);
  assert.equal((json.calls[0].function?.arguments as { content: string }).content, 'x {y}');
});

test('fake tool calls: truncated call is left alone (not executed half-written)', () => {
  const out = extractFakeToolCalls('<function=write_file><parameter=path>a.txt</parameter><parameter=content>half');
  assert.equal(out.calls.length, 0);
});

test('htmlToText drops scripts/nav and keeps the title', () => {
  const text = htmlToText('<html><title>T</title><nav>menu</nav><script>x()</script><p>Hello &amp; bye</p></html>');
  assert.match(text, /^T/);
  assert.match(text, /Hello & bye/);
  assert.ok(!text.includes('menu') && !text.includes('x()'));
});

test('web tools refuse local addresses', async () => {
  assert.match(await runWebTool('fetch_url', { url: 'http://127.0.0.1:8000/' }), /Refusing/);
  assert.match(await runWebTool('fetch_url', { url: 'http://localhost/' }), /Refusing/);
  assert.match(await runWebTool('fetch_url', { url: 'file:///etc/passwd' }), /Only http/);
});

test('projectSkipDirs follows the project type', () => {
  const node = tmpProject();
  fs.writeFileSync(path.join(node, 'package.json'), '{}');
  assert.ok(projectSkipDirs(node).has('node_modules'));
  assert.ok(projectSkipDirs(node).has('dist'));
  assert.ok(!projectSkipDirs(node).has('vendor'));

  const php = tmpProject();
  fs.writeFileSync(path.join(php, 'composer.json'), '{}');
  assert.ok(projectSkipDirs(php).has('vendor'));
});

test('nested new paths keep their order (a/b/c.txt, not c.txt/b/a)', () => {
  const root = tmpProject();
  runTool(root, 'write_file', { path: 'src/deep/new/file.ts', content: 'x' });
  assert.equal(fs.readFileSync(path.join(root, 'src', 'deep', 'new', 'file.ts'), 'utf8'), 'x');
});

test('search parsers: DuckDuckGo html, lite and Bing (redirect links are unwrapped)', () => {
  const ddg = parseDdgHtml(
    '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=1">Example <b>Docs</b></a>' +
      '<a class="result__snippet" href="x">The &amp; snippet</a>',
  );
  assert.deepEqual(ddg[0], { title: 'Example Docs', href: 'https://example.com/docs', snippet: 'The & snippet' });

  const lite = parseLite(
    "<a rel=\"nofollow\" href=\"//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa\" class='result-link'>Lite title</a>" +
      "<td class='result-snippet'>lite snippet</td>",
  );
  assert.equal(lite[0].href, 'https://example.org/a');
  assert.equal(lite[0].title, 'Lite title');

  const bing = parseBing(
    '<ol><li class="b_algo" data-id><h2 class=""><a target="_blank" href="https://www.bing.com/ck/a?!&amp;&amp;p=1&amp;u=a1aHR0cHM6Ly9leGFtcGxlLm5ldC9wYWdl&amp;ntb=1">Bing hit</a></h2>' +
      '<div class="b_caption"><p class="b_lineclamp2">bing snippet</p></div></li></ol>',
  );
  assert.deepEqual(bing[0], { title: 'Bing hit', href: 'https://example.net/page', snippet: 'bing snippet' });
  assert.equal(unwrapBing('https://plain.example/'), 'https://plain.example/');
});

test('write_file refuses a compaction stub as content (never overwrites a file with it)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-stub-'));
  fs.writeFileSync(path.join(root, 'f.html'), '<p>real</p>');
  const out = runTool(root, 'write_file', { path: 'f.html', content: '[записано 33708 симв., текст убран для экономии контекста]' });
  assert.match(String(out), /служебная пометка/);
  assert.equal(fs.readFileSync(path.join(root, 'f.html'), 'utf8'), '<p>real</p>');
});
