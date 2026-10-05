/**
 * Connectors: outside services (Figma, Miro, GitHub, Jira, Notion, Slack…) for every model and agent.
 *
 * Each connector is an MCP server — a package started with npx (stdio) or a hosted endpoint (HTTP) —
 * authorised with the user's own access token. Otto is the MCP client: it starts the server when a tool
 * is needed, keeps it warm for a while and stops it when idle.
 *
 * The models see two tools only (connector_tools / connector_call) instead of every server's dozens of
 * tools, so small local models keep a short tool list. The same pair goes to Otto's own agent loop and,
 * through agentbridge, to the Claude / Codex CLI runs. Calls that change something ask the user first.
 *
 * Tokens are stored sealed (OS keychain or AES, see sshclient.seal) in <dataDir>/connectors.json.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTool } from './agentbridge';
import { seal, unseal } from './sshclient';

// ------------------------------------------------------------------ catalog --

export type ConnectorGroup = 'design' | 'tasks' | 'docs' | 'dev' | 'custom';

export interface ConnectorField {
  key: string;
  label: string;
  secret?: boolean;
  optional?: boolean;
  placeholder?: string;
}

type Launch =
  | { kind: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { kind: 'http'; url: string; headers: Record<string, string> };

export interface ConnectorDef {
  id: string;
  name: string;
  group: ConnectorGroup;
  /** What the models can do with it (English; the UI translates the group, not this). */
  description: string;
  /** Where the user creates the token. */
  tokenUrl: string;
  fields: ConnectorField[];
  launch: (v: Record<string, string>) => Launch;
}

const npx = (pkg: string, env: Record<string, string>, args: string[] = []): Launch => ({ kind: 'stdio', command: 'npx', args: ['-y', pkg, ...args], env });
const bearer = (url: string, token: string): Launch => ({ kind: 'http', url, headers: { Authorization: `Bearer ${token}` } });
const TOKEN: ConnectorField = { key: 'token', label: 'Access token', secret: true };
const ATLASSIAN: ConnectorField[] = [
  { key: 'site', label: 'Site name', placeholder: 'mycompany (from mycompany.atlassian.net)' },
  { key: 'email', label: 'Email' },
  { key: 'token', label: 'API token', secret: true },
];

export const CONNECTORS: ConnectorDef[] = [
  // design
  {
    id: 'figma', name: 'Figma', group: 'design',
    description: 'Read Figma files and frames: layout, styles, components, images — for turning designs into code.',
    tokenUrl: 'https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens',
    fields: [{ ...TOKEN, label: 'Personal access token' }],
    launch: (v) => npx('figma-developer-mcp', { FIGMA_API_KEY: v.token }, ['--stdio']),
  },
  {
    id: 'miro', name: 'Miro', group: 'design',
    description: 'Read and edit Miro boards: stickies, shapes, frames, connectors, comments.',
    tokenUrl: 'https://developers.miro.com/docs/rest-api-build-your-first-hello-world-app',
    fields: [TOKEN],
    launch: (v) => npx('@k-jarzyna/mcp-miro', { MIRO_ACCESS_TOKEN: v.token }),
  },
  // tasks
  {
    id: 'jira', name: 'Jira', group: 'tasks',
    description: 'Search, read, create and update Jira issues and projects.',
    tokenUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    fields: ATLASSIAN,
    launch: (v) => npx('@aashari/mcp-server-atlassian-jira', { ATLASSIAN_SITE_NAME: v.site, ATLASSIAN_USER_EMAIL: v.email, ATLASSIAN_API_TOKEN: v.token }),
  },
  {
    id: 'linear', name: 'Linear', group: 'tasks',
    description: 'Find, create and update Linear issues, projects and comments.',
    tokenUrl: 'https://linear.app/settings/account/security',
    fields: [{ ...TOKEN, label: 'API key' }],
    launch: (v) => bearer('https://mcp.linear.app/mcp', v.token),
  },
  {
    id: 'asana', name: 'Asana', group: 'tasks',
    description: 'Read and create Asana tasks, projects and comments.',
    tokenUrl: 'https://app.asana.com/0/my-apps',
    fields: [{ ...TOKEN, label: 'Personal access token' }],
    launch: (v) => npx('@roychri/mcp-server-asana', { ASANA_ACCESS_TOKEN: v.token }),
  },
  {
    id: 'trello', name: 'Trello', group: 'tasks',
    description: 'Read and change Trello boards, lists and cards.',
    tokenUrl: 'https://trello.com/power-ups/admin',
    fields: [{ key: 'key', label: 'API key' }, { key: 'token', label: 'Token', secret: true }],
    launch: (v) => npx('@delorenj/mcp-server-trello', { TRELLO_API_KEY: v.key, TRELLO_TOKEN: v.token }),
  },
  // docs and chat
  {
    id: 'notion', name: 'Notion', group: 'docs',
    description: 'Search, read and write Notion pages and databases shared with the integration.',
    tokenUrl: 'https://www.notion.so/profile/integrations',
    fields: [{ ...TOKEN, label: 'Integration secret' }],
    launch: (v) => npx('@notionhq/notion-mcp-server', { NOTION_TOKEN: v.token }),
  },
  {
    id: 'confluence', name: 'Confluence', group: 'docs',
    description: 'Search and read Confluence spaces and pages.',
    tokenUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    fields: ATLASSIAN,
    launch: (v) => npx('@aashari/mcp-server-atlassian-confluence', { ATLASSIAN_SITE_NAME: v.site, ATLASSIAN_USER_EMAIL: v.email, ATLASSIAN_API_TOKEN: v.token }),
  },
  {
    id: 'slack', name: 'Slack', group: 'docs',
    description: 'Read channels and threads, post messages and replies in Slack.',
    tokenUrl: 'https://api.slack.com/apps',
    fields: [{ key: 'token', label: 'Bot token (xoxb-…)', secret: true }, { key: 'team', label: 'Workspace (team) ID', placeholder: 'T01234567' }],
    launch: (v) => npx('@modelcontextprotocol/server-slack', { SLACK_BOT_TOKEN: v.token, SLACK_TEAM_ID: v.team }),
  },
  // development
  {
    id: 'github', name: 'GitHub', group: 'dev',
    description: 'Repositories, issues, pull requests, reviews, Actions runs and code search on GitHub.',
    tokenUrl: 'https://github.com/settings/personal-access-tokens',
    fields: [{ ...TOKEN, label: 'Personal access token' }],
    launch: (v) => bearer('https://api.githubcopilot.com/mcp/', v.token),
  },
  {
    id: 'gitlab', name: 'GitLab', group: 'dev',
    description: 'Projects, issues, merge requests and files on GitLab.',
    tokenUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
    fields: [{ ...TOKEN, label: 'Personal access token' }, { key: 'url', label: 'API URL', optional: true, placeholder: 'https://gitlab.com/api/v4' }],
    launch: (v) => npx('@modelcontextprotocol/server-gitlab', { GITLAB_PERSONAL_ACCESS_TOKEN: v.token, GITLAB_API_URL: v.url || 'https://gitlab.com/api/v4' }),
  },
  {
    id: 'sentry', name: 'Sentry', group: 'dev',
    description: 'Errors, issues, events and releases in Sentry — to find and fix what breaks in production.',
    tokenUrl: 'https://sentry.io/settings/account/api/auth-tokens/',
    fields: [{ ...TOKEN, label: 'User auth token' }, { key: 'host', label: 'Self-hosted host', optional: true, placeholder: 'sentry.example.com' }],
    launch: (v) => npx('@sentry/mcp-server', { SENTRY_ACCESS_TOKEN: v.token }, [`--access-token=${v.token}`, ...(v.host ? [`--host=${v.host}`] : [])]),
  },
  {
    id: 'supabase', name: 'Supabase', group: 'dev',
    description: 'Supabase projects: tables, SQL, migrations, logs, edge functions.',
    tokenUrl: 'https://supabase.com/dashboard/account/tokens',
    fields: [{ ...TOKEN, label: 'Personal access token' }, { key: 'project', label: 'Project ref', optional: true, placeholder: 'abcdefghijklmnop' }],
    launch: (v) => npx('@supabase/mcp-server-supabase', { SUPABASE_ACCESS_TOKEN: v.token }, v.project ? [`--project-ref=${v.project}`] : []),
  },
  // anything else
  {
    id: 'custom', name: 'Custom MCP server', group: 'custom',
    description: 'Any other MCP server: a command (e.g. npx -y some-mcp-server) or an HTTP URL, with an optional token.',
    tokenUrl: 'https://github.com/modelcontextprotocol/servers',
    fields: [
      { key: 'name', label: 'Name', placeholder: 'My server' },
      { key: 'target', label: 'Command or URL', placeholder: 'npx -y @scope/mcp-server   or   https://example.com/mcp' },
      { key: 'token', label: 'Token (sent as Bearer / TOKEN)', secret: true, optional: true },
    ],
    launch: (v): Launch => {
      const target = (v.target ?? '').trim();
      if (/^https?:\/\//i.test(target)) return { kind: 'http', url: target, headers: v.token ? { Authorization: `Bearer ${v.token}` } : {} };
      const parts = target.match(/"[^"]*"|\S+/g)?.map((p) => p.replace(/^"|"$/g, '')) ?? [];
      return { kind: 'stdio', command: parts[0] ?? '', args: parts.slice(1), env: v.token ? { TOKEN: v.token } : {} };
    },
  },
];

// ------------------------------------------------------------------ storage --

let dataDir = '';
export function configureConnectors(opts: { dataDir: string }): void { dataDir = opts.dataDir; }

interface Stored { values: Record<string, string>; tools?: ToolInfo[]; error?: string; checkedAt?: number }
type Book = Record<string, Stored>;

const file = () => path.join(dataDir, 'connectors.json');
function readBook(): Book { try { return JSON.parse(fs.readFileSync(file(), 'utf8')) as Book; } catch { return {}; } }
function writeBook(b: Book): void { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file(), JSON.stringify(b, null, 2), { mode: 0o600 }); }

const defOf = (id: string) => CONNECTORS.find((c) => c.id === id);

function valuesOf(id: string): Record<string, string> | null {
  const s = readBook()[id];
  const def = defOf(id);
  if (!s || !def) return null;
  const out: Record<string, string> = {};
  for (const f of def.fields) {
    const raw = s.values[f.key];
    if (raw === undefined) continue;
    out[f.key] = f.secret ? (unseal(dataDir, raw) ?? '') : raw;
  }
  return out;
}

const displayName = (id: string): string => (id === 'custom' ? (valuesOf(id)?.name || 'Custom') : defOf(id)?.name ?? id);

/** Connected connectors (saved), in catalog order. */
export function connectedIds(): string[] {
  if (!dataDir) return [];
  const b = readBook();
  return CONNECTORS.filter((c) => b[c.id]).map((c) => c.id);
}

export interface ConnectorStatus {
  id: string; name: string; group: ConnectorGroup; description: string; tokenUrl: string;
  fields: Array<ConnectorField & { set: boolean; value?: string }>;
  connected: boolean; tools: number; error?: string;
}

/** The catalog with what is saved (secrets are never sent back, only "set"). */
export function listConnectors(): ConnectorStatus[] {
  const b = readBook();
  return CONNECTORS.map((c) => {
    const s = b[c.id];
    return {
      id: c.id, name: c.id === 'custom' && s?.values.name ? s.values.name : c.name, group: c.group, description: c.description, tokenUrl: c.tokenUrl,
      fields: c.fields.map((f) => ({ ...f, set: Boolean(s?.values[f.key]), value: f.secret ? undefined : s?.values[f.key] })),
      connected: Boolean(s), tools: s?.tools?.length ?? 0, error: s?.error,
    };
  });
}

/** Save the fields (an empty secret keeps the stored one), then start the server and list its tools. */
export async function saveConnector(id: string, input: Record<string, unknown>): Promise<ConnectorStatus> {
  const def = defOf(id);
  if (!def) throw new Error(`Unknown connector ${id}`);
  const b = readBook();
  const old = b[id]?.values ?? {};
  const values: Record<string, string> = {};
  for (const f of def.fields) {
    const v = typeof input[f.key] === 'string' ? (input[f.key] as string).trim() : '';
    if (v) values[f.key] = f.secret ? seal(dataDir, v) : v;
    else if (old[f.key] !== undefined) values[f.key] = old[f.key];
    else if (!f.optional) throw new Error(`${f.label} is required`);
  }
  b[id] = { values };
  writeBook(b);
  await stopClient(id);
  await testConnector(id);
  return listConnectors().find((c) => c.id === id)!;
}

export async function removeConnector(id: string): Promise<void> {
  await stopClient(id);
  const b = readBook();
  delete b[id];
  writeBook(b);
}

/** Start the server and refresh its tool list; the result (or the error) is stored. */
export async function testConnector(id: string): Promise<{ tools: number; error?: string }> {
  const b = readBook();
  if (!b[id]) throw new Error('Not connected');
  try {
    const tools = await (await client(id)).listTools();
    b[id] = { ...b[id], tools, error: undefined, checkedAt: Date.now() };
    writeBook(b);
    return { tools: tools.length };
  } catch (exc) {
    const error = exc instanceof Error ? exc.message : String(exc);
    b[id] = { ...b[id], error, checkedAt: Date.now() };
    writeBook(b);
    await stopClient(id);
    return { tools: 0, error };
  }
}

// --------------------------------------------------------------- MCP client --

export interface ToolInfo { name: string; description?: string; inputSchema?: unknown; readOnly?: boolean }

type Rpc = { jsonrpc: '2.0'; id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
const PROTOCOL = '2025-03-26';
const IDLE_MS = 10 * 60_000;

class McpClient {
  private proc: ChildProcess | null = null;
  private buf = '';
  private stderr = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: Rpc) => void; reject: (e: Error) => void }>();
  private session = '';
  private idle: NodeJS.Timeout | null = null;
  closed = false;

  constructor(private readonly launch: Launch, private readonly onClose: () => void) {}

  async start(): Promise<void> {
    if (this.launch.kind === 'stdio') {
      if (!this.launch.command) throw new Error('No command to start the MCP server');
      // npx is npx.cmd on Windows and needs the shell; a full path to an .exe starts directly
      const viaShell = process.platform === 'win32' && !/[\\/]|\.exe$/i.test(this.launch.command);
      this.proc = spawn(this.launch.command, this.launch.args, {
        env: { ...process.env, ...this.launch.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: viaShell,
        windowsHide: true,
      });
      this.proc.stdout!.setEncoding('utf8').on('data', (d: string) => this.onData(d));
      this.proc.stderr!.setEncoding('utf8').on('data', (d: string) => { this.stderr = (this.stderr + d).slice(-4000); });
      this.proc.on('error', (e) => this.fail(new Error(`Could not start ${this.launch.kind === 'stdio' ? this.launch.command : ''}: ${e.message}. Is Node.js installed?`)));
      this.proc.on('exit', (code) => this.fail(new Error(`The MCP server stopped (exit code ${code}).${this.stderr ? `\n${this.stderr.trim().slice(-800)}` : ''}`)));
    }
    // the first npx run downloads the package: allow time
    await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'zeithub-otto', version: '1' } }, 180_000);
    await this.notify('notifications/initialized');
  }

  async listTools(): Promise<ToolInfo[]> {
    const out: ToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const r = (await this.request('tools/list', cursor ? { cursor } : {})) as { tools?: Array<Record<string, unknown>>; nextCursor?: string };
      for (const t of r.tools ?? []) {
        const ann = (t.annotations ?? {}) as { readOnlyHint?: boolean };
        out.push({ name: String(t.name), description: typeof t.description === 'string' ? t.description : undefined, inputSchema: t.inputSchema, readOnly: ann.readOnlyHint === true });
      }
      cursor = r.nextCursor;
    } while (cursor);
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const r = (await this.request('tools/call', { name, arguments: args }, 300_000)) as { content?: Array<Record<string, unknown>>; isError?: boolean; structuredContent?: unknown };
    const parts = (r.content ?? []).map((c) => {
      if (c.type === 'text') return String(c.text ?? '');
      if (c.type === 'resource') return JSON.stringify(c.resource);
      return `[${String(c.type)}${c.mimeType ? ` ${String(c.mimeType)}` : ''}]`;
    });
    if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
    const text = parts.join('\n') || '(no content)';
    return r.isError ? `The service returned an error: ${text}` : text;
  }

  touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.close(), IDLE_MS);
    this.idle.unref?.();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.idle) clearTimeout(this.idle);
    if (this.proc && this.proc.exitCode === null) {
      if (process.platform === 'win32' && this.proc.pid) spawn('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true });
      else this.proc.kill();
    }
    if (this.launch.kind === 'http' && this.session) {
      void fetch(this.launch.url, { method: 'DELETE', headers: { ...this.launch.headers, 'Mcp-Session-Id': this.session } }).catch(() => undefined);
    }
    this.fail(new Error('Connector closed'));
    this.onClose();
  }

  private fail(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    if (!this.closed && this.proc) { this.closed = true; this.onClose(); }
  }

  private onData(d: string): void {
    this.buf += d;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line.startsWith('{')) continue; // logs printed to stdout
      try { this.onMessage(JSON.parse(line) as Rpc); } catch { /* not JSON-RPC */ }
    }
  }

  private onMessage(m: Rpc): void {
    if (m.id !== undefined && this.pending.has(m.id) && (m.result !== undefined || m.error)) {
      const p = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      p.resolve(m);
    } else if (m.id !== undefined && m.method) {
      // a request from the server (sampling, roots…): we support none of them
      void this.send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Not supported' } } as Rpc);
    }
  }

  private async notify(method: string): Promise<void> { await this.send({ jsonrpc: '2.0', method }); }

  private async request(method: string, params: unknown, timeout = 60_000): Promise<unknown> {
    const id = this.nextId++;
    const answer = new Promise<Rpc>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method}: no answer in ${Math.round(timeout / 1000)} s${this.stderr ? `\n${this.stderr.trim().slice(-800)}` : ''}`)); }, timeout).unref?.();
    });
    try {
      await this.send({ jsonrpc: '2.0', id, method, params });
    } catch (exc) {
      this.pending.delete(id);
      answer.catch(() => undefined);
      throw exc;
    }
    const m = await answer;
    if (m.error) throw new Error(`${method}: ${m.error.message}`);
    return m.result;
  }

  private async send(msg: Rpc): Promise<void> {
    if (this.launch.kind === 'stdio') {
      if (!this.proc?.stdin?.writable) throw new Error('The MCP server is not running');
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
      return;
    }
    const res = await fetch(this.launch.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...this.launch.headers, ...(this.session ? { 'Mcp-Session-Id': this.session } : {}) },
      body: JSON.stringify(msg),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (res.status === 401 || res.status === 403) throw new Error(`The service refused the token (HTTP ${res.status}). Check it in Connectors.`);
    if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    if (res.status === 202 || msg.id === undefined) return;
    const type = res.headers.get('content-type') ?? '';
    const body = await res.text();
    const messages: Rpc[] = [];
    if (type.includes('text/event-stream')) {
      for (const block of body.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (data) try { messages.push(JSON.parse(data) as Rpc); } catch { /* keep-alive */ }
      }
    } else if (body.trim()) {
      const parsed = JSON.parse(body) as Rpc | Rpc[];
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
    for (const m of messages) this.onMessage(m);
  }
}

const clients = new Map<string, Promise<McpClient>>();

async function client(id: string): Promise<McpClient> {
  const existing = clients.get(id);
  if (existing) {
    const c = await existing.catch(() => null);
    if (c && !c.closed) { c.touch(); return c; }
    clients.delete(id);
  }
  const values = valuesOf(id);
  const def = defOf(id);
  if (!values || !def) throw new Error(`${displayName(id)} is not connected. Connect it in Otto → Connectors.`);
  const made = (async () => {
    const c = new McpClient(def.launch(values), () => { if (clients.get(id) === made) clients.delete(id); });
    try { await c.start(); } catch (exc) { await c.close(); throw exc; }
    c.touch();
    return c;
  })();
  clients.set(id, made);
  return made;
}

async function stopClient(id: string): Promise<void> {
  const c = await clients.get(id)?.catch(() => null);
  clients.delete(id);
  await c?.close();
}

export async function stopAllConnectors(): Promise<void> {
  await Promise.all([...clients.keys()].map((id) => stopClient(id)));
}

// -------------------------------------------------------------- agent tools --

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const cut = (s: string, max = 30_000) => (s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters cut)` : s);

function findId(ref: unknown): string {
  const want = str(ref).trim().toLowerCase();
  const ids = connectedIds();
  const hit = ids.find((id) => id === want || displayName(id).toLowerCase() === want);
  if (!hit) throw new Error(want ? `"${str(ref)}" is not connected. Connected: ${ids.map(displayName).join(', ') || 'none'}.` : `Give "connector". Connected: ${ids.map(displayName).join(', ')}.`);
  return hit;
}

const cachedTools = (id: string): ToolInfo[] => readBook()[id]?.tools ?? [];

/** One line per connected service, for the system prompt. Empty when nothing is connected. */
export function connectorsNote(): string {
  const ids = connectedIds();
  if (!ids.length) return '';
  return `Connected services (use connector_tools to see what each can do, then connector_call): ${ids.map((id) => `${id} (${displayName(id)})`).join(', ')}. Use them when the user mentions these services or their links (figma.com, miro.com, github.com, …).`;
}

/** The two tools every model and agent gets while at least one service is connected. */
export function connectorTools(): AgentTool[] {
  const ids = connectedIds();
  if (!ids.length) return [];
  const list = ids.map((id) => `${id} (${displayName(id)})`).join(', ');
  return [
    {
      name: 'connector_tools',
      description: `List what a connected outside service can do: its tools with their arguments. Connected: ${list}. Call it before connector_call.`,
      properties: { connector: { type: 'string', description: `One of: ${ids.join(', ')}` } },
      required: ['connector'],
      approval: () => null,
      run: async (a) => {
        const id = findId(a.connector);
        let tools = cachedTools(id);
        if (!tools.length) { const r = await testConnector(id); if (r.error) return `${displayName(id)} failed to start: ${r.error}`; tools = cachedTools(id); }
        return cut(`${displayName(id)} tools (call with connector_call, connector "${id}"):\n` + tools.map((t) =>
          `- ${t.name}${t.readOnly ? ' [read-only]' : ''}: ${(t.description ?? '').replace(/\s+/g, ' ').slice(0, 300)}\n  args: ${JSON.stringify((t.inputSchema as { properties?: unknown } | undefined)?.properties ?? {}).slice(0, 600)}`).join('\n'));
      },
    },
    {
      name: 'connector_call',
      description: `Call a tool of a connected outside service (${list}). Get tool names and arguments from connector_tools first. Calls that change something are approved by the user.`,
      properties: {
        connector: { type: 'string', description: `One of: ${ids.join(', ')}` },
        tool: { type: 'string', description: 'Tool name from connector_tools' },
        arguments: { type: 'object', description: 'The tool arguments as an object' },
      },
      required: ['connector', 'tool'],
      approval: (a) => {
        let id: string;
        try { id = findId(a.connector); } catch { return null; } // run() reports the error
        const tool = cachedTools(id).find((t) => t.name === str(a.tool));
        if (tool?.readOnly) return null;
        const args = JSON.stringify(a.arguments ?? {});
        return { kind: 'connector', text: `${displayName(id)}: ${str(a.tool)} ${args.length > 300 ? `${args.slice(0, 300)}…` : args}` };
      },
      run: async (a) => {
        const id = findId(a.connector);
        const name = str(a.tool).trim();
        if (!name) return 'connector_call needs "tool" (see connector_tools).';
        let args = a.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return '"arguments" must be a JSON object.'; } }
        const c = await client(id);
        return cut(await c.callTool(name, (args && typeof args === 'object' ? args : {}) as Record<string, unknown>));
      },
    },
  ];
}
