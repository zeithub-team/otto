import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { detectLanguage, languageRule } from '../language';
import { generateResponse } from '../ollama';

test('detectLanguage: scripts and Latin languages', () => {
  const code = (t: string) => detectLanguage(t)?.code;
  assert.equal(code('Сделай карточку котёнка с градиентом'), 'ru');
  assert.equal(code('Зроби картку кошеня, будь ласка, і додай кнопку'), 'uk');
  assert.equal(code('Create a landing page with a subscribe form and check that it works'), 'en');
  assert.equal(code('Crea una página de aterrizaje y comprueba que el formulario funciona, por favor'), 'es');
  assert.equal(code('Crea una pagina con il modulo di iscrizione e controlla che funzioni per favore'), 'it');
  assert.equal(code('Erstelle bitte eine Seite mit einem Formular und prüfe, ob sie funktioniert'), 'de');
  assert.equal(code('Abonə formu olan bir səhifə yarat və işlədiyini yoxla'), 'az');
  assert.equal(code('შექმენი გვერდი გამოწერის ფორმით'), 'ka');
  assert.equal(code('ok'), undefined);
  assert.equal(code('```js\nconst a = 1;\n```'), undefined);
});

test('languageRule names the language and falls back to earlier messages', () => {
  assert.match(languageRule('Add a dark mode toggle please'), /английский/);
  assert.match(languageRule('да', ['Сделай форму подписки']), /русский/);
  assert.match(languageRule('ok'), /на том же языке/);
});

test('the system prompt tells the model to answer in the language of the message', async () => {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push(body.messages[0].content);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'Done.' }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.OLLAMA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-lang-'));
    for await (const _ of generateResponse({ prompt: 'Please explain what this project does', messageId: 'm', projectId: 1, projectPath: root, model: 'fake:1b', useTools: true })) void _;
    assert.match(seen[0], /Язык сообщения пользователя: английский/);
    assert.ok(!/Отвечай по-русски/.test(seen[0]), 'no hard-coded Russian reply rule left');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('system notices follow the language of the message', async () => {
  const { notice } = await import('../language');
  assert.match(notice('stepLimit', 'Сделай страницу'), /^Готово/);
  assert.match(notice('stepLimit', 'Make a landing page please'), /^Done/);
  assert.match(notice('noProject', 'Crea una pagina con il modulo per favore'), /Seleziona/);
  assert.match(notice('switched', 'Make a page', { from: 'a/b', model: 'x/y' }), /^🔄 Model switch: a\/b → x\/y$/);
  assert.match(notice('emptyAnswer', ''), /Модель не вернула/); // nothing to detect: the old Russian default
});
