import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startServer } from '../index';
import { gitignoreContent, gitignoreList, licenseList, renderLicense } from '../templates';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'otto-setup-'));
const json = (url: string, method: string, body?: unknown) =>
  fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('templates: every gitignore ends with the IDE/OS block, MIT is filled in', async () => {
  assert.ok(gitignoreList().length >= 10);
  for (const t of gitignoreList()) assert.match(gitignoreContent(t.id) ?? '', /\.DS_Store/);
  assert.match(gitignoreContent('node') ?? '', /node_modules\//);
  assert.match(gitignoreContent('python') ?? '', /__pycache__\//);
  assert.ok(licenseList().some((l) => l.id === 'apache-2.0'));
  const mit = await renderLicense('mit', 'Jane Doe', 2031);
  assert.match(mit!.text, /^MIT License\n\nCopyright \(c\) 2031 Jane Doe/);
  assert.equal(await renderLicense('nope', 'x'), null);
});

test('creating a project writes .gitignore and LICENSE without overwriting existing files; git init is optional', async () => {
  const d = tmp();
  const server = await startServer({ port: 0, dbPath: path.join(d, 'app.db'), workspaceRoot: path.join(d, 'ws') });
  try {
    const created = await json(`${server.url}/api/projects/`, 'POST', { name: 'demo', gitignore: 'node', license: 'mit', license_holder: 'Acme', git_init: false });
    assert.equal(created.status, 200);
    const root = created.body.path as string;
    assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /node_modules/);
    assert.match(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), /Copyright \(c\) \d{4} Acme/);
    assert.deepEqual([created.body.setup.gitignore, created.body.setup.license], ['created', 'created']);

    // binding an existing folder never replaces what is there
    const existing = path.join(d, 'existing');
    fs.mkdirSync(existing);
    fs.writeFileSync(path.join(existing, '.gitignore'), 'mine\n');
    const bound = await json(`${server.url}/api/projects/`, 'POST', { name: 'old', folder: existing, gitignore: 'python', license: 'isc', license_holder: 'Me' });
    assert.equal(bound.body.setup.gitignore, 'exists');
    assert.equal(fs.readFileSync(path.join(existing, '.gitignore'), 'utf8'), 'mine\n');
    assert.equal(bound.body.setup.license, 'created');
  } finally {
    await server.close();
  }
});

test('the projects root folder can be changed and is used for new projects (and remembered)', async () => {
  const d = tmp();
  const dbPath = path.join(d, 'app.db');
  const server = await startServer({ port: 0, dbPath, workspaceRoot: path.join(d, 'ws') });
  const newRoot = path.join(d, 'my projects');
  try {
    const before = await json(`${server.url}/api/workspace`, 'GET');
    assert.equal(before.body.custom, false);
    const set = await json(`${server.url}/api/workspace`, 'PUT', { path: newRoot });
    assert.equal(set.status, 200);
    assert.ok(fs.statSync(newRoot).isDirectory());
    const created = await json(`${server.url}/api/projects/`, 'POST', { name: 'inside' });
    assert.equal(path.dirname(created.body.path), fs.realpathSync(newRoot));
    assert.equal((await json(`${server.url}/api/workspace`, 'PUT', { path: '' })).status, 400);
    assert.equal((await json(`${server.url}/api/workspace`, 'PUT', { path: 'relative/dir' })).status, 400);
  } finally {
    await server.close();
  }
  // after a restart the saved folder is picked up again
  const again = await startServer({ port: 0, dbPath, workspaceRoot: path.join(d, 'ws') });
  try {
    const now = await json(`${again.url}/api/workspace`, 'GET');
    assert.equal(now.body.path, fs.realpathSync(newRoot));
    assert.equal(now.body.custom, true);
  } finally {
    await again.close();
  }
});
