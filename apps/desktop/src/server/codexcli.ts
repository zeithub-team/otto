/**
 * "Codex via subscription": the user's own OpenAI Codex CLI (`codex exec --json`, its headless mode)
 * runs in the project folder under the user's ChatGPT login. Opt-in (Settings → codex.cli).
 * Models: codex-cli/<model id from the account>, e.g. codex-cli/gpt-5.5.
 *
 * Codex runs its commands inside its own sandbox: read-only without the Tools toggle, otherwise
 * "workspace-write" (it may change files and run commands only inside the project folder).
 * Limits and the model list come from `codex app-server` (JSON-RPC over stdio).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CODEX_PREFIX = 'codex-cli/';
export const isCodexModel = (model: string | null | undefined): boolean => Boolean(model && model.startsWith(CODEX_PREFIX));

let cached: { at: number; path: string | null } | null = null;

/**
 * The Codex CLI: the copy the Codex app keeps (with its sandbox helpers next to it) first, then a CLI on PATH
 * (npm i -g @openai/codex). The bare `~/.codex/.sandbox-bin/codex.exe` lacks its helpers, so it is the last resort.
 */
export function findCodex(): string | null {
  if (cached && Date.now() - cached.at < 60_000) return cached.path;
  const candidates: string[] = [];
  const appBin = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  try {
    const dirs = fs.readdirSync(appBin).map((d) => path.join(appBin, d, process.platform === 'win32' ? 'codex.exe' : 'codex'))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    candidates.push(...dirs);
  } catch { /* no Codex app */ }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    if (process.platform === 'win32') candidates.push(path.join(dir, 'codex.cmd'), path.join(dir, 'codex.exe'));
    else candidates.push(path.join(dir, 'codex'));
  }
  candidates.push(path.join(os.homedir(), '.codex', '.sandbox-bin', process.platform === 'win32' ? 'codex.exe' : 'codex'));
  const found = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;
  cached = { at: Date.now(), path: found };
  return found;
}

/** The user's ChatGPT login must be used, not an API key from the environment. */
export function codexEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) if (/^(OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY|CODEX_THREAD_ID|CODEX_SANDBOX.*)$/i.test(key)) delete env[key];
  return env;
}

export function codexArgs(o: { model: string; cwd: string; edits: boolean; systemNote?: string; mcpUrl?: string }): string[] {
  const id = o.model.slice(CODEX_PREFIX.length);
  const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', o.cwd, '--sandbox', o.edits ? 'workspace-write' : 'read-only'];
  if (id && id !== 'default') args.push('-m', id);
  if (o.mcpUrl) {
    // Otto's tools (agentbridge.ts); Otto asks the user itself, so Codex may call them without its own prompt
    args.push(
      '-c', `mcp_servers.otto.url="${o.mcpUrl}"`,
      '-c', 'mcp_servers.otto.tool_timeout_sec=900',
      '-c', 'mcp_servers.otto.default_tools_approval_mode="approve"',
    );
  }
  args.push('-');
  return args;
}

export interface CodexRun {
  events: AsyncGenerator<Record<string, unknown>>;
  stop: () => void;
  stderr: () => string;
  /** Put an Otto event (an approval card) into the stream. */
  inject: (ev: Record<string, unknown>) => void;
}

export function runCodex(binary: string, cwd: string, prompt: string, o: { model: string; edits: boolean; systemNote?: string; mcpUrl?: string }): CodexRun {
  const child: ChildProcess = spawn(binary, codexArgs({ ...o, cwd }), { cwd, env: codexEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: binary.endsWith('.cmd') });
  let errText = '';
  child.stderr?.on('data', (d: Buffer) => { if (errText.length < 8000) errText += d.toString('utf8'); });
  // Otto's rules go first in the prompt (exec has no separate system prompt)
  child.stdin?.end(o.systemNote ? `${o.systemNote}

---

${prompt}` : prompt, 'utf8');
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  const push = (v: Record<string, unknown> | null) => { queue.push(v); wake?.(); wake = null; };
  async function* events(): AsyncGenerator<Record<string, unknown>> {
    let buffer = '';
    child.stdout?.on('data', (d: Buffer) => {
      buffer += d.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) { try { push(JSON.parse(line) as Record<string, unknown>); } catch { /* not an event */ } }
      }
    });
    child.on('close', () => push(null));
    child.on('error', (e) => { errText += e.message; push(null); });
    for (;;) {
      if (queue.length === 0) await new Promise<void>((r) => { wake = r; });
      const next = queue.shift();
      if (next === null || next === undefined) return;
      yield next;
    }
  }
  return {
    events: events(),
    stop: () => {
      if (child.exitCode !== null || child.killed) return;
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill();
    },
    stderr: () => errText,
    inject: (ev) => push(ev),
  };
}

// ---------------------------------------------------------------- app-server --

/** One-shot JSON-RPC calls to `codex app-server` (initialize, then the given methods). */
export function codexRpc(methods: Array<{ method: string; params?: unknown }>, timeoutMs = 15_000): Promise<Array<{ result?: unknown; error?: unknown }>> {
  const binary = findCodex();
  if (!binary) return Promise.resolve(methods.map(() => ({ error: 'not installed' })));
  return new Promise((resolve) => {
    const child = spawn(binary, ['app-server'], { env: codexEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], shell: binary.endsWith('.cmd') });
    const answers = new Map<number, { result?: unknown; error?: unknown }>();
    let buffer = '';
    const finish = () => { clearTimeout(timer); try { child.kill(); } catch { /* gone */ } resolve(methods.map((_, i) => answers.get(i + 2) ?? { error: 'timeout' })); };
    const timer = setTimeout(finish, timeoutMs);
    const send = (o: unknown) => child.stdin?.write(JSON.stringify(o) + '\n');
    child.stdout?.on('data', (d: Buffer) => {
      buffer += d.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const j = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
          if (j.id === 1) {
            send({ jsonrpc: '2.0', method: 'initialized' });
            methods.forEach((m, i) => send({ jsonrpc: '2.0', id: i + 2, method: m.method, params: m.params ?? {} }));
          } else if (typeof j.id === 'number' && j.id >= 2) {
            answers.set(j.id, { result: j.result, error: j.error });
            if (answers.size === methods.length) finish();
          }
        } catch { /* a notification or noise */ }
      }
    });
    child.on('error', finish);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'zeithub.otto', version: '0.1.0' } } });
  });
}

export interface LimitWindow { usedPercent: number; windowMins: number | null; resetsAt: number | null }
export interface CodexStatus {
  installed: boolean;
  loggedIn: boolean;
  plan?: string;
  limits?: { primary: LimitWindow | null; secondary: LimitWindow | null; reached: boolean };
}

const window_ = (w: unknown): LimitWindow | null => {
  if (!w || typeof w !== 'object') return null;
  const o = w as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown };
  return { usedPercent: Number(o.usedPercent) || 0, windowMins: typeof o.windowDurationMins === 'number' ? o.windowDurationMins : null, resetsAt: typeof o.resetsAt === 'number' ? o.resetsAt * 1000 : null };
};

/** Signed in? Plan and usage limits (no e-mail or account ids leave this function). */
export async function codexStatus(): Promise<CodexStatus> {
  if (!findCodex()) return { installed: false, loggedIn: false };
  const [account, limits] = await codexRpc([{ method: 'account/read' }, { method: 'account/rateLimits/read' }]);
  const acc = (account.result as { account?: { type?: string; planType?: string } | null } | undefined)?.account;
  const rl = (limits.result as { rateLimits?: { primary?: unknown; secondary?: unknown; rateLimitReachedType?: unknown; planType?: string } } | undefined)?.rateLimits;
  return {
    installed: true,
    loggedIn: Boolean(acc && acc.type),
    plan: acc?.planType ?? rl?.planType,
    limits: rl ? { primary: window_(rl.primary), secondary: window_(rl.secondary), reached: Boolean(rl.rateLimitReachedType) } : undefined,
  };
}

let modelCache: { at: number; models: string[] } | null = null;

/** The models this account may use, as codex-cli/<id> (cached for 10 minutes). */
export async function codexModels(): Promise<string[]> {
  if (modelCache && Date.now() - modelCache.at < 600_000) return modelCache.models;
  const [list] = await codexRpc([{ method: 'model/list' }]);
  const data = (list.result as { data?: Array<{ id?: string; isDefault?: boolean }> } | undefined)?.data ?? [];
  const ids = data.filter((m) => typeof m.id === 'string').sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault))).map((m) => CODEX_PREFIX + m.id);
  const models = ids.length ? ids : [`${CODEX_PREFIX}default`];
  modelCache = { at: Date.now(), models };
  return models;
}

/** Open a console window with `codex login`: it signs in with ChatGPT in the browser. */
export function openCodexLogin(): boolean {
  const binary = findCodex();
  if (!binary) return false;
  if (process.platform === 'win32') {
    // `start "title" "program" args`: written out by hand — Node's own quoting breaks `start`'s title
    spawn('cmd.exe', ['/d', '/s', '/c', `start "Codex login" "${binary}" login`], { env: codexEnv(), detached: true, windowsHide: false, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  } else if (process.platform === 'darwin') {
    spawn('osascript', ['-e', `tell application "Terminal" to do script "'${binary}' login"`], { env: codexEnv(), detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('x-terminal-emulator', ['-e', binary, 'login'], { env: codexEnv(), detached: true, stdio: 'ignore' }).unref();
  }
  return true;
}

/** Otto's tool name and target for a Codex item, so the chat shows "Running…/Writing…" lines. */
export function codexItemActivity(item: Record<string, unknown>, root: string): Array<{ tool: string; target: string }> {
  const rel = (p: string) => {
    const r = path.relative(root, path.resolve(root, p));
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.replace(/\\/g, '/') : p;
  };
  switch (item.type) {
    case 'command_execution': return [{ tool: 'run_command', target: String(item.command ?? '').replace(/^"[^"]*powershell\.exe"\s+-Command\s+/i, '').replace(/^(['"])(.*)\1$/s, '$2') }];
    case 'file_change': return (Array.isArray(item.changes) ? item.changes : []).map((c) => {
      const ch = c as { path?: string; kind?: string };
      return { tool: ch.kind === 'delete' ? 'delete_file' : 'write_file', target: rel(String(ch.path ?? '')) };
    });
    case 'web_search': return [{ tool: 'web_search', target: String(item.query ?? '') }];
    case 'mcp_tool_call': return [{ tool: String(item.tool ?? 'tool'), target: String(item.server ?? '') }];
    default: return [];
  }
}

// ------------------------------------------------- models the plan can use --

/**
 * The model list does not say which models the plan may use (they all look the same), so each one is tried
 * once a day with a tiny read-only request ("Reply with exactly: ok"); only the ones that answer are listed.
 * Results are kept in <app data>/codex-models.json. A model that answers "no access" later is dropped at once.
 */
interface Access { ok: boolean; at: number }
const PROBE_TTL = 24 * 60 * 60 * 1000;
let accessFile: string | null = null;
let access: Record<string, Access> = {};
let probing: Promise<void> | null = null;

export function configureCodex(opts: { dataDir: string }): void {
  accessFile = path.join(opts.dataDir, 'codex-models.json');
  try { access = JSON.parse(fs.readFileSync(accessFile, 'utf8')) as Record<string, Access>; } catch { access = {}; }
}

function saveAccess(): void {
  if (!accessFile) return;
  try { fs.writeFileSync(accessFile, JSON.stringify(access, null, 2)); } catch { /* best effort */ }
}

export const isNoAccessError = (message: string): boolean => /does not exist or you do not have access|model_not_found|not available on your plan/i.test(message);

export function markCodexUnavailable(model: string): void {
  const id = model.startsWith(CODEX_PREFIX) ? model : CODEX_PREFIX + model;
  access[id] = { ok: false, at: Date.now() };
  saveAccess();
}

/** Try one model with a tiny read-only request. */
async function probe(model: string): Promise<boolean | null> {
  const binary = findCodex();
  if (!binary) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-codex-probe-'));
  const run = runCodex(binary, dir, 'Reply with exactly: ok', { model, edits: false });
  let answered = false;
  let failure = '';
  const timer = setTimeout(() => run.stop(), 90_000);
  try {
    for await (const ev of run.events) {
      const item = (ev.item ?? {}) as { type?: string; message?: string };
      if (ev.type === 'item.completed' && item.type === 'agent_message') answered = true;
      if (ev.type === 'turn.failed') failure = String((ev.error as { message?: string } | undefined)?.message ?? 'failed');
      if (ev.type === 'error') failure = String(ev.message ?? 'error');
    }
  } finally {
    clearTimeout(timer);
    run.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
  if (answered) return true;
  if (isNoAccessError(failure)) return false;
  return null; // limits, network…: unknown, try again next time
}

/** Check the models whose availability is unknown or older than a day, one after another, in the background. */
export function refreshCodexAccess(models: string[]): Promise<void> {
  probing ??= (async () => {
    for (const m of models) {
      const known = access[m];
      if (known && Date.now() - known.at < PROBE_TTL) continue;
      const ok = await probe(m).catch(() => null);
      if (ok !== null) { access[m] = { ok, at: Date.now() }; saveAccess(); }
    }
  })().finally(() => { probing = null; });
  return probing;
}

/** The models to list: the ones known to work; while nothing is checked yet, the account's default model. */
export async function usableCodexModels(): Promise<string[]> {
  const all = await codexModels();
  void refreshCodexAccess(all);
  const ok = all.filter((m) => access[m]?.ok === true);
  return ok.length ? ok : all.slice(0, 1);
}

/** Context windows of the Codex models, from Codex's own model table (~/.codex/models_cache.json). */
function codexWindow(model: string): number {
  const slug = model.startsWith(CODEX_PREFIX) ? model.slice(CODEX_PREFIX.length) : model;
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8')) as { models?: Array<{ slug?: string; context_window?: number; max_context_window?: number }> };
    const m = cache.models?.find((x) => x.slug === slug) ?? cache.models?.[0];
    return m?.context_window ?? m?.max_context_window ?? 0;
  } catch {
    return 0;
  }
}

/** Context / speed figures for the chat's meter from Codex's `turn.completed`. */
export function codexUsage(ev: Record<string, unknown>, model: string, ms: number): { model: string; used: number; ctx: number; generated: number; tps: number; estimated: boolean; compacted: number } | null {
  const u = ev.usage as Record<string, number> | undefined;
  if (!u) return null;
  const generated = (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
  return { model, used: u.input_tokens ?? 0, ctx: codexWindow(model) || 272_000, generated, tps: ms > 0 ? Math.round((generated / ms) * 1000) : 0, estimated: false, compacted: 0 };
}
