import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectProject, parseCompose } from '../detect';

const project = (files: Record<string, string>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-detect-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
};
const pkg = (o: unknown): string => JSON.stringify(o);

test('compose file: services and published host ports', () => {
  const services = parseCompose(`
version: "3.9"
services:
  web:
    build: .
    ports:
      - "3000:3000"
      - 9229:9229
  db:
    image: postgres:16
    ports:
      - "127.0.0.1:5432:5432"
  worker:
    image: x
volumes:
  data:
`);
  assert.deepEqual(services.map((s) => [s.name, s.ports]), [['web', [3000, 9229]], ['db', [5432]], ['worker', []]]);
});

test('Next.js project: front end, dev command and port', () => {
  const root = project({ 'package.json': pkg({ scripts: { dev: 'next dev' }, dependencies: { next: '14', react: '18' } }) });
  const d = detectProject(root);
  assert.ok(d.frontend);
  assert.ok(d.stacks.includes('Next.js'));
  assert.deepEqual([d.options[0].command, d.options[0].port], ['npm run dev', 3000]);
});

test('workspace monorepo: the root script leads, front-end workspaces are offered separately', () => {
  const root = project({
    'package.json': pkg({ name: 'mono', scripts: { dev: 'concurrently a b' }, workspaces: ['apps/*'] }),
    'apps/web/package.json': pkg({ name: '@m/web', scripts: { dev: 'next dev' }, dependencies: { next: '14' } }),
    'apps/api/package.json': pkg({ name: '@m/api', scripts: { dev: 'node server.js' }, dependencies: { express: '4' } }),
  });
  const d = detectProject(root);
  assert.equal(d.options[0].id, 'root');
  const web = d.options.find((o) => o.command === 'npm run dev -w @m/web');
  const api = d.options.find((o) => o.command === 'npm run dev -w @m/api');
  assert.ok(web?.frontend && web.port === 3000);
  assert.ok(api && !api.frontend);
  assert.ok(d.frontend);
});

test('a separate frontend/ folder next to a back end is found', () => {
  const root = project({
    'composer.json': '{}',
    'artisan': '',
    'frontend/package.json': pkg({ scripts: { dev: 'vite' }, devDependencies: { vite: '5' } }),
  });
  const d = detectProject(root);
  assert.ok(d.options.some((o) => o.command === 'npm run dev --prefix frontend' && o.frontend && o.port === 5173));
  assert.ok(d.options.some((o) => o.command === 'php artisan serve'));
  assert.ok(d.stacks.includes('Laravel'));
});

test('docker compose: option with the front-end service port; containers reported', () => {
  const root = project({
    'docker-compose.yml': 'services:\n  api:\n    image: x\n    ports:\n      - "8080:80"\n  frontend:\n    image: y\n    ports:\n      - "5173:5173"\n',
    'Dockerfile': 'FROM node',
    '.devcontainer/devcontainer.json': '{}',
  });
  const d = detectProject(root);
  assert.equal(d.containers.compose, 'docker-compose.yml');
  assert.ok(d.containers.dockerfile && d.containers.devcontainer);
  const compose = d.options.find((o) => o.kind === 'docker');
  assert.deepEqual([compose?.command, compose?.port], ['docker compose up', 5173]);
  assert.ok(d.stacks.includes('Docker Compose') && d.stacks.includes('Dev Container'));
});

test('back-end only projects are reported without a front end', () => {
  const api = detectProject(project({ 'requirements.txt': 'fastapi\nuvicorn', 'main.py': '' }));
  assert.equal(api.frontend, false);
  assert.equal(api.options[0].command, 'uvicorn main:app --reload');
  const go = detectProject(project({ 'go.mod': 'module x' }));
  assert.equal(go.frontend, false);
  assert.equal(go.options[0].command, 'go run .');
});

test('plain HTML and Django are recognised', () => {
  const site = detectProject(project({ 'index.html': '<h1>x</h1>' }));
  assert.ok(site.frontend && site.hasIndex && site.stacks.includes('Static site') && site.options.length === 0);
  const dj = detectProject(project({ 'manage.py': '' }));
  assert.equal(dj.options[0].command, 'python manage.py runserver');
});
