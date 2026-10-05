import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkSha256, iniFile, projectPhpEnv, readProjectPhp, versionDir, writeProjectPhp } from '../phpvm';
import { envWithPathFirst } from '../env';

const withLocalAppData = <T>(fn: (dir: string) => T): T => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-phpvm-'));
  const prev = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = prev;
  }
};

test('a PHP branch name is validated (no path tricks)', () => {
  assert.throws(() => versionDir('../evil'), /Invalid PHP version/);
  assert.throws(() => versionDir('8'), /Invalid PHP version/);
  withLocalAppData(() => assert.ok(versionDir('7.3').endsWith(path.join('php', '7.3'))));
});

test('archives are accepted only with the right SHA-256', () => {
  const data = Buffer.from('zip-bytes');
  const sum = crypto.createHash('sha256').update(data).digest('hex');
  assert.ok(checkSha256(data, sum.toUpperCase()));
  assert.ok(!checkSha256(Buffer.from('other'), sum));
});

test('project PHP choice: version + own php.ini are stored in the project and survive a reload', () => {
  withLocalAppData(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-proj-'));
    fs.mkdirSync(versionDir('7.4'), { recursive: true });
    fs.writeFileSync(path.join(versionDir('7.4'), 'php.ini'), 'memory_limit = 128M\n');

    assert.deepEqual(readProjectPhp(root), { version: null, customIni: false });
    assert.deepEqual(writeProjectPhp(root, { version: '7.4', customIni: true }), { version: '7.4', customIni: true });
    // the project's ini starts as a copy of the version's and is independent afterwards
    assert.match(fs.readFileSync(iniFile({ projectRoot: root }), 'utf8'), /memory_limit = 128M/);
    fs.writeFileSync(path.join(versionDir('7.4'), 'php.ini'), 'memory_limit = 999M\n');
    assert.match(fs.readFileSync(iniFile({ projectRoot: root }), 'utf8'), /128M/);
    assert.deepEqual(readProjectPhp(root), { version: '7.4', customIni: true });
    // no version → no custom ini either
    assert.deepEqual(writeProjectPhp(root, { version: null, customIni: true }), { version: null, customIni: false });
    // a bogus version is ignored
    assert.equal(writeProjectPhp(root, { version: '../x', customIni: false }).version, null);
  });
});

test('process environment: the project PHP goes first on PATH, PHPRC points at its ini (Windows only)', { skip: process.platform !== 'win32' }, () => {
  withLocalAppData(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-proj-'));
    fs.mkdirSync(versionDir('7.3'), { recursive: true });
    fs.writeFileSync(path.join(versionDir('7.3'), 'php.exe'), '');
    writeProjectPhp(root, { version: '7.3', customIni: true });
    const env = projectPhpEnv(root, { Path: 'C:\\Windows' });
    assert.ok(String(env.Path).startsWith(versionDir('7.3') + path.delimiter));
    assert.equal(env.PHPRC, path.dirname(iniFile({ projectRoot: root })));
    // without a choice the environment is untouched
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-proj-'));
    assert.deepEqual(projectPhpEnv(other, { Path: 'C:\\Windows' }), { Path: 'C:\\Windows' });
  });
});

test('envWithPathFirst keeps the existing PATH key (Path on Windows) instead of adding a second one', () => {
  const env = envWithPathFirst({ Path: 'C:\\a', OTHER: '1' }, 'C:\\php');
  assert.equal(env.Path, `C:\\php${path.delimiter}C:\\a`);
  assert.equal(Object.keys(env).filter((k) => k.toLowerCase() === 'path').length, 1);
});
