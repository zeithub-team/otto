import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleBridge, openBridge, sshTools, type AgentTool } from '../agentbridge';
import { cliArgs, ottoToolName } from '../claudecli';

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = http.createServer((req, res) => {
    void handleBridge(req, res, (req.url ?? '/').split('?')[0]).then((ok) => { if (!ok) res.writeHead(404).end(); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const saved = process.env.OTTO_INTERNAL_API_URL;
  process.env.OTTO_INTERNAL_API_URL = base;
  try { return await fn(base); } finally {
    process.env.OTTO_INTERNAL_API_URL = saved;
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const rpc = async (url: string, body: unknown) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
  return { status: res.status, json: res.status === 200 ? await res.json() as Record<string, any> : null };
};

const echo: AgentTool = {
  name: 'echo', description: 'echo', properties: { text: { type: 'string' } }, required: ['text'],
  approval: (a) => (a.text === 'safe' ? null : { kind: 'shell', text: `echo ${String(a.text)}` }),
  run: async (a) => `said ${String(a.text)}`,
};

test('the MCP bridge answers initialize, lists the tools and asks Otto before a change', async () => {
  await withServer(async () => {
    const asked: string[] = [];
    const bridge = openBridge([echo], async (_kind, what) => { asked.push(what); return what.includes('no') ? 'declined' : null; });
    assert.ok(bridge.url);
    const init = await rpc(bridge.url!, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(init.json?.result.protocolVersion, '2025-06-18');
    assert.equal((await rpc(bridge.url!, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const list = await rpc(bridge.url!, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(list.json?.result.tools.map((t: { name: string }) => t.name), ['echo']);

    const safe = await rpc(bridge.url!, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'safe' } } });
    assert.equal(safe.json?.result.content[0].text, 'said safe');
    assert.deepEqual(asked, [], 'read-only calls are not asked');

    const ok = await rpc(bridge.url!, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } });
    assert.equal(ok.json?.result.content[0].text, 'said hi');
    const no = await rpc(bridge.url!, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { text: 'no' } } });
    assert.equal(no.json?.result.isError, true);
    assert.equal(no.json?.result.content[0].text, 'declined');
    assert.deepEqual(asked, ['echo hi', 'echo no']);

    // a finished run's endpoint is gone
    bridge.close();
    assert.equal((await rpc(bridge.url!, { jsonrpc: '2.0', id: 6, method: 'tools/list' })).status, 404);
  });
});

test('SSH tools: reads are free, changes are approved, and a missing session is explained', async () => {
  const exec = sshTools.find((t) => t.name === 'ssh_exec')!;
  assert.equal(sshTools.find((t) => t.name === 'ssh_read_file')!.approval({ path: '/etc/hosts' }), null);
  assert.deepEqual(exec.approval({ session: 'root@db', command: 'systemctl restart postgresql' }), { kind: 'ssh', text: 'ssh root@db: systemctl restart postgresql' });
  await assert.rejects(exec.run({ command: 'uptime' }), /No SSH session is open/);
});

test('Claude CLI with the bridge: Bash is replaced by Otto’s tools', () => {
  const args = cliArgs({ model: 'claude-cli/sonnet', edits: true, shell: true, mcpUrl: 'http://127.0.0.1:1/mcp/x' });
  const cfg = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
  assert.equal(cfg.mcpServers.otto.url, 'http://127.0.0.1:1/mcp/x');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__otto');
  assert.ok(args.slice(args.indexOf('--disallowedTools')).includes('Bash'));
  assert.equal(ottoToolName('mcp__otto__run_command'), 'run_command');
  // read-only chat: no bridge, no tools that change things
  assert.ok(!cliArgs({ model: 'claude-cli/sonnet', edits: false, shell: false }).includes('--mcp-config'));
});
