import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import { addPathEntry, enablePhpExtensions, matchesSha256, mergePath, TOOLS, wingetArgs } from '../env';

test('mergePath appends only entries the process PATH does not have (case and trailing slash ignored)', () => {
  const merged = mergePath('C:\\Windows;C:\\Tools\\', 'c:\\windows;C:\\tools;C:\\xampp\\php;;');
  assert.equal(merged, 'C:\\Windows;C:\\Tools\\;C:\\xampp\\php');
});

test('addPathEntry is idempotent', () => {
  const once = addPathEntry('C:\\a;C:\\b', 'C:\\xampp\\php');
  assert.equal(once, 'C:\\a;C:\\b;C:\\xampp\\php');
  assert.equal(addPathEntry(once, 'c:\\XAMPP\\php\\'), once);
  assert.equal(addPathEntry('', 'C:\\x'), 'C:\\x');
});

test('winget arguments: reinstall forces, uninstall needs no package agreements', () => {
  assert.deepEqual(wingetArgs('uninstall', 'X.Y'), ['uninstall', '--id', 'X.Y', '-e', '--accept-source-agreements', '--disable-interactivity']);
  assert.ok(wingetArgs('reinstall', 'X.Y').includes('--force'));
  assert.ok(!wingetArgs('install', 'X.Y').includes('--force'));
  assert.equal(TOOLS.find((t) => t.id === 'composer')?.installer, 'composer'); // not a winget package
});

test('php.ini: extension_dir and the needed extensions are switched on, others stay off', () => {
  const ini = ';extension_dir = "ext"\n;extension=curl\n;extension=openssl\n;extension=ftp\nextension=mbstring\n';
  const out = enablePhpExtensions(ini, ['curl', 'openssl', 'mbstring']);
  assert.ok(out.includes('\nextension_dir = "ext"') || out.startsWith('extension_dir = "ext"'));
  assert.match(out, /^extension=curl$/m);
  assert.match(out, /^extension=openssl$/m);
  assert.match(out, /^;extension=ftp$/m);
  assert.equal((out.match(/^extension=mbstring$/gm) ?? []).length, 1);
  assert.equal(TOOLS.find((t) => t.id === 'php')?.wingetId, 'PHP.PHP.8.4');
  assert.ok(TOOLS.some((t) => t.id === 'ruby'));
});

test('composer.phar is accepted only with a matching SHA-256', () => {
  const data = Buffer.from('phar-bytes');
  const sum = crypto.createHash('sha256').update(data).digest('hex');
  assert.ok(matchesSha256(data, `${sum}  composer.phar\n`));
  assert.ok(!matchesSha256(Buffer.from('tampered'), `${sum}  composer.phar`));
  assert.ok(!matchesSha256(data, 'not a checksum'));
});

test('PHP from XAMPP gets its folder added to PATH after install', () => {
  assert.deepEqual(TOOLS.find((t) => t.id === 'php')?.pathDirs, ['C:\\xampp\\php']);
});
