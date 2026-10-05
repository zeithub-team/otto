import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPluginName, readPlugin, writePlugin } from '../pluginstore';

test('plugin documents are stored per plugin and read back; unknown names are refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-plugin-'));
  assert.equal(readPlugin(dir, 'alertas'), null);
  writePlugin(dir, 'alertas', { reminders: [{ id: 'a', title: 'x', when: 1 }] });
  assert.deepEqual(readPlugin(dir, 'alertas'), { reminders: [{ id: 'a', title: 'x', when: 1 }] });
  assert.equal(readPlugin(dir, 'coverty'), null, 'plugins do not share documents');
  assert.equal(isPluginName('coverty'), true);
  assert.equal(isPluginName('../etc/passwd'), false);
  assert.ok(!fs.existsSync(path.join(dir, 'plugins', 'alertas.json.tmp')), 'no temp file is left behind');
});
