import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guidedSchema, parseGuided, pickGuidedTools, toGuidedMessages } from '../guided';
import { routeAppCommand } from '../apptools';

const ALL = ['list_files', 'read_file', 'search_files', 'write_file', 'append_file', 'run_command', 'otto_docker', 'otto_preview',
  'otto_open', 'otto_appearance', 'otto_settings', 'otto_about', 'otto_tasks', 'ssh_connect', 'ssh_sessions', 'ssh_exec', 'ssh_list',
  'ssh_read_file', 'ssh_write_file', 'ssh_disconnect', 'create_task', 'web_search'];

test('a request gets only the tools it needs', () => {
  assert.deepEqual(pickGuidedTools('Поменяй тему на nord', ALL).sort(), ['otto_about', 'otto_appearance', 'otto_open', 'otto_settings']);
  assert.ok(pickGuidedTools('Запусти сервис postgres', ALL).includes('otto_docker'));
  assert.ok(pickGuidedTools('Подключись по ssh к 10.0.0.1 root', ALL).includes('ssh_connect'));
  assert.deepEqual(pickGuidedTools('Добавь задачу «Сделать логин»', ALL), ['otto_tasks']);
  const page = pickGuidedTools('Сгенерируй HTML-лендинг и открой в превью', ALL);
  for (const t of ['write_file', 'otto_preview']) assert.ok(page.includes(t), t);
  // a question gets read-only tools; never fewer than one group
  assert.ok(!pickGuidedTools('Что такое Docker?', ALL).includes('write_file'));
  assert.ok(pickGuidedTools('сделай красиво', ALL).includes('write_file'));
  // fewer tools than the full set is the point
  assert.ok(page.length <= 10);
});

test('the reply schema allows only the picked actions plus the answer', () => {
  const schema = guidedSchema([{ name: 'write_file', description: '', parameters: { type: 'object', properties: { path: { type: 'string', description: 'x' }, content: { type: 'string' } }, required: ['path', 'content'] } }]) as { anyOf: Array<{ properties: { action: { enum: string[] } } }> };
  assert.deepEqual(schema.anyOf.map((o) => o.properties.action.enum[0]), ['write_file', 'answer']);
});

test('a guided reply is read even with text around it', () => {
  assert.deepEqual(parseGuided('{"action":"otto_open","args":{"view":"services"}}'), { action: 'otto_open', args: { view: 'services' } });
  assert.deepEqual(parseGuided('Sure:\n{\n "action": "answer", "args": {"text": "ok"}\n}'), { action: 'answer', args: { text: 'ok' } });
  assert.equal(parseGuided('no json here'), null);
});

test('models without the tools API see their actions as JSON and the results as messages', () => {
  const out = toGuidedMessages([
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }] },
    { role: 'tool', content: 'hello', tool_name: 'read_file' },
  ]);
  assert.deepEqual(out, [
    { role: 'assistant', content: '{"action":"read_file","args":{"path":"a.txt"}}' },
    { role: 'user', content: 'Result of read_file:\nhello' },
  ]);
});

test('plain app commands are carried out without a model', () => {
  assert.deepEqual(routeAppCommand('Поменяй тему Otto на nord и язык интерфейса на английский.'), [{ tool: 'otto_appearance', args: { theme: 'nord', language: 'en' } }]);
  assert.deepEqual(routeAppCommand('Открой настройки терминала'), [{ tool: 'otto_open', args: { view: 'settings', page: 'terminal' } }]);
  assert.deepEqual(routeAppCommand('открой сервисы'), [{ tool: 'otto_open', args: { view: 'services' } }]);
  assert.deepEqual(routeAppCommand('switch the theme to dracula'), [{ tool: 'otto_appearance', args: { theme: 'dracula' } }]);
  // work goes to the model
  assert.equal(routeAppCommand('Создай страницу настроек'), null);
  assert.equal(routeAppCommand('Запусти проект и открой превью'), null);
  assert.equal(routeAppCommand('Какая сейчас тема?'), null);
  assert.equal(routeAppCommand('поменяй тему'), null, 'no theme named: the model asks');
});

test('replace_in_file: a small edit keeps the rest of the file; loose spacing still matches; a miss shows nearby lines', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { runTool } = await import('../ollama');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-replace-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<body>\n  <h1>Старый   заголовок</h1>\n  <p>Текст</p>\n</body>\n');
  const ok = runTool(root, 'replace_in_file', { path: 'index.html', find: '<h1>Старый заголовок</h1>', replace: '<h1>Кофейня Утро</h1>' });
  assert.match(ok, /^Replaced in index\.html/);
  assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), '<body>\n  <h1>Кофейня Утро</h1>\n  <p>Текст</p>\n</body>\n');
  // the str_replace style many models use
  assert.match(runTool(root, 'str_replace', { file_path: 'index.html', old_str: 'Текст', new_str: 'Добро пожаловать' }), /^Replaced/);
  const miss = runTool(root, 'replace_in_file', { path: 'index.html', find: '<h2>Кофейня</h2>', replace: 'x' });
  assert.match(miss, /NOT changed/);
  assert.match(miss, /Кофейня Утро/, 'shows the line that has the word');
});

test('web search, deleting files and skills are offered in guided mode too', () => {
  const all = [...ALL, 'fetch_url', 'delete_file', 'use_skill', 'read_skill_file'];
  const latest = pickGuidedTools('Какая последняя версия Laravel? Найди в интернете', all);
  assert.ok(latest.includes('web_search') && latest.includes('fetch_url'), latest.join(','));
  assert.ok(pickGuidedTools('Прочитай https://laravel.com/docs и кратко перескажи', all).includes('fetch_url'));
  assert.ok(pickGuidedTools('Удали файл old.css', all).includes('delete_file'));
  assert.ok(pickGuidedTools('Сделай лендинг кофейни', all).includes('use_skill'));
  // Web switched off in the chat: the tools are not available, so they are not offered
  assert.ok(!pickGuidedTools('Найди в интернете курс доллара', ALL.filter((n) => n !== 'web_search')).includes('web_search'));
  // a general question without a web hint still gets no web tools
  assert.ok(!pickGuidedTools('Что такое Docker?', all).includes('web_search'));
});
