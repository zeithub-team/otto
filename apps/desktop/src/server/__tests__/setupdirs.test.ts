import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { markSetupDone, readSetup } from '../setup';

test('the choice the installer saved under %APPDATA%\zeithub.otto is found and applied once', () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-appdata-'));
  const dataDir = path.join(appData, '@otto', 'desktop');
  const installerDir = path.join(appData, 'zeithub.otto');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(installerDir, { recursive: true });
  fs.writeFileSync(path.join(installerDir, 'setup.json'), '\ufeff{"version":1,"locale":"en","theme":"gruvbox","tools":""}');
  const saved = process.env.APPDATA;
  process.env.APPDATA = appData;
  try {
    assert.deepEqual(readSetup(dataDir), { version: 1, locale: 'en', theme: 'gruvbox', tools: [] });
    assert.equal(markSetupDone(dataDir), true);
    assert.equal(readSetup(dataDir), null);
    assert.ok(fs.existsSync(path.join(installerDir, 'setup.applied.json')));
  } finally {
    process.env.APPDATA = saved;
  }
});
