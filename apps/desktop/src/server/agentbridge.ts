/**
 * Otto's tools for agents that run in their own process (Claude CLI, Codex CLI).
 *
 * Each CLI run gets a private MCP endpoint `POST /mcp/<token>` (streamable HTTP, JSON answers) on Otto's
 * local server. Its tools are Otto's own: shell commands, Docker services, the SSH sessions the user has
 * opened. Approvals stay Otto's: a tool that changes something asks through `approve`, which shows the
 * same "Run / Deny" card in the chat as Otto's own agents.
 *
 * The tool set itself (`agentTools`) is shared with Otto's own agent loop, so both see the same tools.
 */

import type * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import * as ssh from './sshclient';

export interface AgentTool {
  name: string;
  description: string;
  /** JSON schema properties; `required` lists the mandatory ones. */
  properties: Record<string, unknown>;
  required: string[];
  /**
   * What the user approves, or null for a read-only call. kind decides which setting applies:
   * shell → Agent → terminal commands, ssh → Permissions → SSH changes.
   */
  approval: (args: Record<string, unknown>) => { kind: 'shell' | 'ssh'; text: string; always?: boolean } | null;
  run: (args: Record<string, unknown>) => Promise<string>;
}

/** Answer for the agent when it is not allowed, or null to go ahead. */
export type Approve = (kind: 'shell' | 'ssh', text: string, always?: boolean) => Promise<string | null>;

// ------------------------------------------------------------------ ssh tools --

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** A session by id or by "user@host" / "host" (the SSH tab's open connections only). */
function sessionOf(ref: unknown): string {
  const want = str(ref).trim();
  const all = ssh.listSessions();
  if (!all.length) throw new Error('No SSH session is open. Ask the user to connect to the server in the SSH tab first.');
  if (!want && all.length === 1) return all[0].id;
  const hit = all.find((s) => s.id === want || `${s.user}@${s.host}` === want || s.host === want || `${s.user}@${s.host}:${s.port}` === want);
  if (!hit) throw new Error(`No open SSH session "${want}". Open sessions: ${all.map((s) => `${s.user}@${s.host}`).join(', ')}`);
  return hit.id;
}

const cut = (s: string, max = 20_000) => (s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters cut)` : s);

export const sshTools: AgentTool[] = [
  {
    name: 'ssh_sessions',
    description: 'List the SSH connections the user has open in Otto’s SSH tab (user@host, port). The ssh_* tools work only on these; if none is open, ask the user to connect first.',
    properties: {},
    required: [],
    approval: () => null,
    run: async () => {
      const all = ssh.listSessions();
      return all.length ? all.map((s) => `${s.user}@${s.host}:${s.port} (id ${s.id})`).join('\n') : 'No SSH session is open.';
    },
  },
  {
    name: 'ssh_exec',
    description: 'Run ONE shell command on a server through an open SSH session (e.g. systemctl status nginx, docker ps, tail -n 100 /var/log/syslog). session: "user@host" from ssh_sessions (may be omitted when only one is open). The user may have to approve it.',
    properties: {
      session: { type: 'string', description: 'user@host of an open session' },
      command: { type: 'string', description: 'The command line to run on the server' },
      timeout_seconds: { type: 'number', description: 'Time limit in seconds (default 60, max 600)' },
    },
    required: ['command'],
    approval: (a) => ({ kind: 'ssh', text: `ssh ${str(a.session) || '(session)'}: ${str(a.command)}` }),
    run: async (a) => {
      const command = str(a.command).trim();
      if (!command) return 'ssh_exec needs a non-empty "command".';
      const timeout = Math.min(600, Math.max(1, Number(a.timeout_seconds) || 60)) * 1000;
      const r = await ssh.exec(sessionOf(a.session), command, timeout);
      return cut(`exit code: ${r.code ?? 'none'} (${r.ms} ms)\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`);
    },
  },
  {
    name: 'ssh_list',
    description: 'List a folder on the server (SFTP) through an open SSH session.',
    properties: { session: { type: 'string', description: 'user@host of an open session' }, path: { type: 'string', description: 'Remote folder, e.g. /var/www' } },
    required: ['path'],
    approval: () => null,
    run: async (a) => {
      const r = await ssh.list(sessionOf(a.session), str(a.path) || '.');
      return cut(`${r.path}\n` + r.entries.map((e) => `${e.type === 'dir' ? 'd' : '-'} ${e.mode} ${String(e.size).padStart(10)} ${e.name}`).join('\n'));
    },
  },
  {
    name: 'ssh_read_file',
    description: 'Read a text file on the server (SFTP) through an open SSH session.',
    properties: { session: { type: 'string', description: 'user@host of an open session' }, path: { type: 'string', description: 'Remote file path' } },
    required: ['path'],
    approval: () => null,
    run: async (a) => {
      const r = await ssh.readText(sessionOf(a.session), str(a.path));
      return r.binary ? `${str(a.path)} is a binary file (${r.size} bytes).` : cut(r.content, 60_000);
    },
  },
  {
    name: 'ssh_write_file',
    description: 'Write (create or overwrite) a text file on the server (SFTP) through an open SSH session. The user may have to approve it.',
    properties: {
      session: { type: 'string', description: 'user@host of an open session' },
      path: { type: 'string', description: 'Remote file path' },
      content: { type: 'string', description: 'The whole new content' },
    },
    required: ['path', 'content'],
    approval: (a) => ({ kind: 'ssh', text: `ssh ${str(a.session) || '(session)'}: write ${str(a.path)} (${str(a.content).length} chars)` }),
    run: async (a) => {
      await ssh.writeText(sessionOf(a.session), str(a.path), str(a.content));
      return `Wrote ${str(a.path)}.`;
    },
  },
];

/** The schema form Otto's own agent loop uses (OpenAI / Ollama function tools). */
export function asFunctionTool(t: AgentTool): Record<string, unknown> {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: { type: 'object', properties: t.properties, required: t.required } } };
}

// ------------------------------------------------------------------ MCP bridge --

interface Bridge { tools: AgentTool[]; approve: Approve }
const bridges = new Map<string, Bridge>();

/** A private endpoint for one CLI run; `close()` when the run ends. */
export function openBridge(tools: AgentTool[], approve: Approve): { url: string | null; close: () => void } {
  const base = process.env.OTTO_INTERNAL_API_URL;
  if (!base) return { url: null, close: () => undefined };
  const token = randomUUID();
  bridges.set(token, { tools, approve });
  return { url: new URL(`/mcp/${token}`, base).toString(), close: () => { bridges.delete(token); } };
}

const PROTOCOL = '2025-03-26';

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

async function answer(b: Bridge, msg: Rpc): Promise<Record<string, unknown> | null> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined || msg.id === null) return null; // notification
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'otto', version: '1' },
        instructions: 'Otto IDE tools: shell commands in the project, Docker services, and the SSH sessions the user opened. Every change is approved by the user in Otto.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: b.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: 'object', properties: t.properties, required: t.required } })) });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const tool = b.tools.find((t) => t.name === name);
      if (!tool) return fail(-32602, `Unknown tool ${name}`);
      try {
        const need = tool.approval(args);
        const refused = need ? await b.approve(need.kind, need.text, need.always) : null;
        const text = refused ?? await tool.run(args);
        return reply({ content: [{ type: 'text', text }], isError: refused !== null });
      } catch (exc) {
        return reply({ content: [{ type: 'text', text: `Tool failed: ${exc instanceof Error ? exc.message : String(exc)}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

/** `/mcp/<token>`; false when the path is not ours. */
export async function handleBridge(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
  const m = /^\/mcp\/([0-9a-f-]{36})$/.exec(pathname);
  if (!m) return false;
  const b = bridges.get(m[1]);
  if (!b) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"unknown or finished session"}'); return true; }
  if (req.method === 'DELETE') { res.writeHead(200).end(); return true; }
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return true; }
  let parsed: Rpc | Rpc[];
  try { parsed = JSON.parse(await readBody(req)) as Rpc | Rpc[]; } catch {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return true;
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out = (await Promise.all(list.map((msg) => answer(b, msg)))).filter((x): x is Record<string, unknown> => x !== null);
  if (!out.length) { res.writeHead(202).end(); return true; }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
  return true;
}
