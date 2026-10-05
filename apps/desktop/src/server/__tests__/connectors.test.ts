import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CONNECTORS, configureConnectors, connectedIds, connectorTools, connectorsNote, listConnectors, removeConnector, saveConnector, stopAllConnectors,
} from '../connectors';
import { pickGuidedTools } from '../guided';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-conn-'));
configureConnectors({ dataDir: dir });
after(() => stopAllConnectors());

// a tiny stdio MCP server: two tools, one read-only; it echoes the token it was started with
const fake = path.join(dir, 'fake-mcp.js');
fs.writeFileSync(fake, `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
console.log('a log line that is not JSON-RPC');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [
    { name: 'get_board', description: 'Read a board', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'add_card', description: 'Add a card', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
  ] } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: m.params.name + ' ' + JSON.stringify(m.params.arguments) + ' token=' + process.env.TOKEN }] } });
  else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
});
`);

test('the catalog covers the popular services, each with a token page and fields', () => {
  const ids = CONNECTORS.map((c) => c.id);
  for (const id of ['figma', 'miro', 'jira', 'linear', 'asana', 'trello', 'notion', 'confluence', 'slack', 'github', 'gitlab', 'sentry', 'supabase', 'custom']) assert.ok(ids.includes(id), id);
  for (const c of CONNECTORS) {
    assert.match(c.tokenUrl, /^https:\/\//, c.id);
    assert.ok(c.fields.some((f) => f.secret), `${c.id} has a secret field`);
  }
  // tokens reach the server the way its package expects
  const figma = CONNECTORS.find((c) => c.id === 'figma')!.launch({ token: 'figd_x' });
  assert.deepEqual(figma, { kind: 'stdio', command: 'npx', args: ['-y', 'figma-developer-mcp', '--stdio'], env: { FIGMA_API_KEY: 'figd_x' } });
  const github = CONNECTORS.find((c) => c.id === 'github')!.launch({ token: 'ghp_x' });
  assert.deepEqual(github, { kind: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ghp_x' } });
});

test('nothing connected: no tools, no prompt note', () => {
  assert.deepEqual(connectorTools(), []);
  assert.equal(connectorsNote(), '');
});

test('connect a server: token sealed on disk, tools listed, calls work, changes need approval', async () => {
  const st = await saveConnector('custom', { name: 'Boards', target: `"${process.execPath}" "${fake}"`, token: 'secret-123' });
  assert.equal(st.error, undefined);
  assert.equal(st.tools, 2);
  assert.equal(st.name, 'Boards');
  assert.deepEqual(connectedIds(), ['custom']);

  // the token is never stored or sent back in clear text
  assert.ok(!fs.readFileSync(path.join(dir, 'connectors.json'), 'utf8').includes('secret-123'));
  const field = listConnectors().find((c) => c.id === 'custom')!.fields.find((f) => f.key === 'token')!;
  assert.equal(field.set, true);
  assert.equal(field.value, undefined);

  assert.match(connectorsNote(), /custom \(Boards\)/);
  const tools = Object.fromEntries(connectorTools().map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(tools).sort(), ['connector_call', 'connector_tools']);

  const listed = await tools.connector_tools.run({ connector: 'Boards' });
  assert.match(listed, /get_board \[read-only\]/);
  assert.match(listed, /add_card:/);

  // read-only tools run at once; others ask the user
  assert.equal(tools.connector_call.approval({ connector: 'custom', tool: 'get_board', arguments: { id: '1' } }), null);
  const ask = tools.connector_call.approval({ connector: 'custom', tool: 'add_card', arguments: { title: 'Ship it' } });
  assert.equal(ask?.kind, 'connector');
  assert.match(ask!.text, /Boards: add_card \{"title":"Ship it"\}/);

  const out = await tools.connector_call.run({ connector: 'custom', tool: 'add_card', arguments: '{"title":"Ship it"}' });
  assert.equal(out, 'add_card {"title":"Ship it"} token=secret-123');

  await assert.rejects(tools.connector_call.run({ connector: 'figma', tool: 'x' }), /not connected/);

  // saving again with an empty token keeps the stored one
  const again = await saveConnector('custom', { name: 'Boards', target: `"${process.execPath}" "${fake}"`, token: '' });
  assert.equal(again.tools, 2);
  assert.match(await Object.fromEntries(connectorTools().map((t) => [t.name, t])).connector_call.run({ connector: 'custom', tool: 'get_board', arguments: {} }), /token=secret-123/);

  await removeConnector('custom');
  assert.deepEqual(connectorTools(), []);
});

test('a server that cannot start reports why instead of hanging', async () => {
  const st = await saveConnector('custom', { name: 'Broken', target: `"${process.execPath}" -e "process.exit(3)"`, token: 't' });
  assert.equal(st.tools, 0);
  assert.match(st.error ?? '', /stopped|exit code 3/);
  await removeConnector('custom');
});

test('an HTTP server (streamable HTTP with SSE answers) works with a bearer token', async () => {
  let auth = '';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      auth = String(req.headers.authorization ?? '');
      const m = JSON.parse(body || '{}');
      if (m.id === undefined) { res.writeHead(202).end(); return; }
      const result = m.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'h', version: '1' } }
        : m.method === 'tools/list' ? { tools: [{ name: 'whoami', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
          : { content: [{ type: 'text', text: 'you are ok' }] };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const st = await saveConnector('custom', { name: 'Web', target: `http://127.0.0.1:${port}/mcp`, token: 'tok' });
    assert.equal(st.tools, 1, st.error);
    const call = connectorTools().find((t) => t.name === 'connector_call')!;
    assert.equal(await call.run({ connector: 'custom', tool: 'whoami', arguments: {} }), 'you are ok');
    assert.equal(auth, 'Bearer tok');
    await removeConnector('custom');
  } finally {
    server.close();
  }
});

test('small models get the connector tools when the request names a service', () => {
  const all = ['connector_tools', 'connector_call', 'read_file', 'write_file', 'list_files'];
  assert.ok(pickGuidedTools('сверстай страницу по макету из Figma', all).includes('connector_call'));
  assert.ok(pickGuidedTools('какие задачи в Jira на мне?', all).includes('connector_tools'));
  assert.ok(!pickGuidedTools('исправь ошибку в index.html', all).includes('connector_call'));
});
