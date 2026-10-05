import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { collectOpenApi, findSpecFile, generateOpenApi, isLocalHost, normalizePath, probeSpecServer, proxyRequest, saveOpenApi, scanLocalServers } from '../netclient';

const project = (files: Record<string, string>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-net-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
};

const listen = async (handler: http.RequestListener): Promise<{ server: http.Server; port: number }> => {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port };
};
const close = (server: http.Server) => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });

test('only local hosts are reachable', () => {
  for (const ok of ['localhost', 'api.localhost', '127.0.0.1', '::1', '[::1]', '192.168.1.20', '10.0.0.5', '172.20.1.1', 'host.docker.internal']) assert.ok(isLocalHost(ok), ok);
  for (const bad of ['example.com', '8.8.8.8', '172.32.0.1', '169.254.169.254', '192.169.0.1']) assert.ok(!isLocalHost(bad), bad);
});

test('the proxy forwards a request to a local server and refuses public hosts', async () => {
  const { server, port } = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-echo': String(req.headers['x-test']) });
      res.end(JSON.stringify({ method: req.method, url: req.url, body }));
    });
  });
  try {
    const r = await proxyRequest({ method: 'POST', url: `http://localhost:${port}/items?x=1`, headers: { 'x-test': 'yes' }, body: '{"a":1}' });
    assert.equal(r.status, 201);
    assert.equal(r.headers['x-echo'], 'yes');
    assert.deepEqual(JSON.parse(r.body), { method: 'POST', url: '/items?x=1', body: '{"a":1}' });
    await assert.rejects(proxyRequest({ method: 'GET', url: 'http://example.com/' }), /Only local hosts/);
    await assert.rejects(proxyRequest({ method: 'GET', url: 'file:///etc/passwd' }), /Only http/);
    await assert.rejects(proxyRequest({ method: 'TRACE', url: `http://localhost:${port}/` }), /Unsupported method/);
  } finally {
    await close(server);
  }
});

test('the scan finds a local HTTP server and the paths that upgrade to WebSocket', async () => {
  const { server, port } = await listen((_req, res) => res.end('hi'));
  server.on('upgrade', (req, socket) => {
    if (req.url === '/ws') socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    else socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
  try {
    const found = (await scanLocalServers([port])).find((s) => s.port === port);
    assert.ok(found, 'server found');
    assert.equal(found!.http?.status, 200);
    assert.deepEqual(found!.websocket, ['/ws']);
  } finally {
    await close(server);
  }
});

test('route paths become OpenAPI paths', () => {
  assert.deepEqual(normalizePath('/users/:id/posts/:postId'), { path: '/users/{id}/posts/{postId}', params: ['id', 'postId'] });
  assert.deepEqual(normalizePath('api/users/[id]'), { path: '/api/users/{id}', params: ['id'] });
  assert.deepEqual(normalizePath('/items/{item}/{opt?}'), { path: '/items/{item}/{opt}', params: ['opt', 'item'].sort().reverse() });
  assert.deepEqual(normalizePath('/files/<int:file_id>/'), { path: '/files/{file_id}', params: ['file_id'] });
});

test('a spec is generated from Express routes', () => {
  const root = project({
    'package.json': '{"name":"shop-api"}',
    'server.js': "const app = require('express')();\napp.get('/users', list);\napp.post('/users', create);\napp.get('/users/:id', show);\napp.delete('/users/:id', remove);\napp.use('/static', s);\n",
  });
  const r = generateOpenApi(root, 'http://localhost:4000');
  assert.equal(r.source, 'generated');
  const spec = r.spec as { openapi: string; info: { title: string }; servers: Array<{ url: string }>; paths: Record<string, Record<string, any>> };
  assert.equal(spec.openapi, '3.0.3');
  assert.equal(spec.info.title, 'shop-api');
  assert.equal(spec.servers[0].url, 'http://localhost:4000');
  assert.deepEqual(Object.keys(spec.paths).sort(), ['/users', '/users/{id}']);
  assert.deepEqual(Object.keys(spec.paths['/users']).sort(), ['get', 'post']);
  assert.equal(spec.paths['/users/{id}'].get.parameters[0].name, 'id');
  assert.ok(spec.paths['/users'].post.requestBody);
  assert.equal(r.endpoints, 4);
});

test('a real spec is preferred: served by the app, then a file (json or yaml)', async () => {
  const served = { openapi: '3.1.0', info: { title: 'live', version: '1' }, paths: { '/ping': { get: {} } } };
  const { server, port } = await listen((req, res) => {
    if (req.url === '/openapi.json') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(served));
    else res.writeHead(404).end();
  });
  try {
    const root = project({ 'openapi.yaml': 'openapi: 3.0.0\ninfo:\n  title: file\n  version: "1"\npaths:\n  /a:\n    get: {}\n    post: {}\n' });
    const fromServer = await collectOpenApi(root, `http://localhost:${port}`);
    assert.deepEqual([fromServer.source, fromServer.endpoints], ['server', 1]);
    assert.equal((await probeSpecServer('http://example.com'))?.source, undefined);
    const fromFile = await collectOpenApi(root, null);
    assert.deepEqual([fromFile.source, fromFile.origin, fromFile.endpoints], ['file', 'openapi.yaml', 2]);
    assert.equal(findSpecFile(project({})), null);
  } finally {
    await close(server);
  }
});

test('saving writes a generated file next to the project sources without touching real specs', () => {
  const root = project({ 'openapi.json': '{"openapi":"3.0.0","paths":{}}' });
  const rel = saveOpenApi(root, { openapi: '3.0.3', paths: {} });
  assert.equal(rel, 'openapi.generated.json');
  assert.equal(fs.readFileSync(path.join(root, 'openapi.json'), 'utf8'), '{"openapi":"3.0.0","paths":{}}');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')).openapi, '3.0.3');
  assert.equal(saveOpenApi(root, { openapi: '3.0.3', paths: {} }, 'yaml'), 'openapi.generated.yaml');
});
