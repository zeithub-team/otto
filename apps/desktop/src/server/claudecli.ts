/**
 * "Claude via subscription": runs the user's own installed Claude Code CLI (`claude -p`, its
 * headless mode) in the project folder, under the user's own login, and streams its events.
 * Opt-in (Settings → claude.cli). Models: claude-cli/sonnet | opus | haiku.
 *
 * The CLI is an agent itself (reads/edits files, can run commands). Otto keeps its rules:
 *  - file edits only with the Tools toggle on (otherwise read-only),
 *  - shell commands only in the "auto" terminal mode (the CLI cannot show Otto's approval card).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLI_PREFIX = 'claude-cli/';
/**
 * The latest of each line (aliases the CLI resolves itself) and exact versions, so a specific one can be chosen.
 * More exact ids come from the Claude API model list when a key is set (see providers.ts).
 */
export const CLI_MODELS = ['sonnet', 'opus', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001'].map((m) => CLI_PREFIX + m);

/** The plan cannot use this model: the run falls back to the Sonnet alias. */
export const isCliNoAccess = (message: string): boolean => /not available|does not have access|don't have access|invalid model|model .*not found|not_found_error|model_not_found/i.test(message);
export const isCliModel = (model: string | null | undefined): boolean => Boolean(model && model.startsWith(CLI_PREFIX));

let cached: { at: number; path: string | null } | null = null;

/** Where `claude` is installed (null when it is not). Looked up once a minute. */
export function findClaude(): string | null {
  if (cached && Date.now() - cached.at < 60_000) return cached.path;
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [path.join(home, '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA ?? '', 'npm', 'claude.cmd'), path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'claude', 'claude.exe')]
    : [path.join(home, '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude'));
    if (process.platform === 'win32') candidates.push(path.join(dir, 'claude.cmd'));
  }
  const found = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;
  cached = { at: Date.now(), path: found };
  return found;
}

/** Environment for the CLI: the user's own login must be used, never an API key or a parent session's settings. */
export function cliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    // keys/proxies would bill the API instead of the plan; a parent Claude Code session's variables hijack its auth
    if (/^(ANTHROPIC_.*|CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_.*)$/i.test(key)) delete env[key];
  }
  // an Otto approval may wait for the user for minutes
  env.MCP_TOOL_TIMEOUT = '900000';
  return env;
}

export interface CliOptions {
  model: string;
  /** Tools toggle: false = read-only (no edits, no commands). */
  edits: boolean;
  /** Terminal mode "auto": the CLI may run shell commands. */
  shell: boolean;
  /** Otto's tools over MCP (agentbridge.ts): commands, Docker, SSH go through Otto's approvals instead of Bash. */
  mcpUrl?: string;
  systemNote?: string;
}

export function cliArgs(o: CliOptions): string[] {
  const alias = o.model.slice(CLI_PREFIX.length) || 'sonnet';
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', alias];
  const blocked = ['Task', 'Artifact', 'ArtifactComments', 'ArtifactData', 'CronCreate', 'CronDelete', 'CronList', 'EnterWorktree', 'ExitWorktree', 'RemoteTrigger', 'PushNotification'];
  if (!o.edits) blocked.push('Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash');
  else if (!o.shell || o.mcpUrl) blocked.push('Bash');
  args.push('--permission-mode', o.edits ? 'acceptEdits' : 'default');
  if (o.edits && o.mcpUrl) {
    // only Otto's server: the user's own MCP servers (Slack, Gmail…) would slow every run down
    args.push('--mcp-config', JSON.stringify({ mcpServers: { otto: { type: 'http', url: o.mcpUrl } } }), '--strict-mcp-config');
    // Otto asks the user itself (approval cards), so the CLI may call its tools
    args.push('--allowedTools', 'mcp__otto');
  } else if (o.edits && o.shell) args.push('--allowedTools', 'Bash');
  args.push('--disallowedTools', ...blocked);
  if (o.systemNote) args.push('--append-system-prompt', o.systemNote);
  return args;
}

export interface CliRun {
  events: AsyncGenerator<Record<string, unknown>>;
  stop: () => void;
  stderr: () => string;
  /** Put an Otto event (an approval card) into the stream, between the CLI's own events. */
  inject: (ev: Record<string, unknown>) => void;
}

/** Start the CLI with the prompt on stdin; events are its stream-json lines. */
export function runClaudeCli(binary: string, cwd: string, prompt: string, o: CliOptions): CliRun {
  const child: ChildProcess = spawn(binary, cliArgs(o), { cwd, env: cliEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: binary.endsWith('.cmd') });
  let errText = '';
  child.stderr?.on('data', (d: Buffer) => { if (errText.length < 8000) errText += d.toString('utf8'); });
  child.stdin?.end(prompt, 'utf8');
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
        if (!line) continue;
        try { push(JSON.parse(line) as Record<string, unknown>); } catch { /* not an event */ }
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

/** Otto's tool names for the CLI's, so the chat shows the familiar "Reading…/Writing…" lines. */
export function ottoToolName(cliTool: string): string {
  if (cliTool.startsWith('mcp__otto__')) return cliTool.slice('mcp__otto__'.length);
  switch (cliTool) {
    case 'Read': return 'read_file';
    case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return 'write_file';
    case 'Glob': case 'Grep': return 'search_files';
    case 'LS': return 'list_files';
    case 'Bash': return 'run_command';
    case 'WebFetch': return 'fetch_url';
    case 'WebSearch': return 'web_search';
    case 'TodoWrite': return 'plan_task';
    default: return cliTool;
  }
}

/** The file / command / pattern a CLI tool call is about (relative to the project when inside it). */
export function cliToolTarget(input: Record<string, unknown>, root: string): string {
  const raw = input.file_path ?? input.notebook_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.query;
  if (typeof raw !== 'string') return '';
  if (input.command !== undefined) return raw;
  const rel = path.relative(root, path.resolve(root, raw));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : raw;
}

/** Earlier turns of the chat, so a fresh CLI session knows the context. */
export function withHistory(prompt: string, history: unknown): string {
  const turns = (Array.isArray(history) ? history : [])
    .filter((h): h is { role: string; content: string } => Boolean(h) && typeof h === 'object' && typeof (h as { content?: unknown }).content === 'string' && ['user', 'assistant'].includes(String((h as { role?: unknown }).role)))
    .slice(-12)
    .map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content.replace(/:::changes[\s\S]*?:::/g, '').trim().slice(0, 4000)}`);
  return turns.length ? `Earlier in this conversation:\n${turns.join('\n\n')}\n\n---\nNow: ${prompt}` : prompt;
}

// ------------------------------------------------------------------- login --

export interface CliAuth { installed: boolean; loggedIn: boolean; method?: string }

/** `claude auth status`: is the CLI installed and signed in (no account details leave this function). */
export function cliAuthStatus(): Promise<CliAuth> {
  const binary = findClaude();
  if (!binary) return Promise.resolve({ installed: false, loggedIn: false });
  return new Promise((resolve) => {
    const child = spawn(binary, ['auth', 'status', '--json'], { env: cliEnv(), windowsHide: true, shell: binary.endsWith('.cmd') });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on('error', () => { clearTimeout(timer); resolve({ installed: true, loggedIn: false }); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out) as { loggedIn?: unknown; authMethod?: unknown };
        resolve({ installed: true, loggedIn: j.loggedIn === true, method: typeof j.authMethod === 'string' ? j.authMethod : undefined });
      } catch {
        resolve({ installed: true, loggedIn: false });
      }
    });
  });
}

/**
 * Open a console window with `claude auth login --claudeai`: it opens the Anthropic sign-in page in the
 * browser and finishes by itself. The user signs in there; Otto never sees a password or a token.
 */
export function openCliLogin(): boolean {
  const binary = findClaude();
  if (!binary) return false;
  if (process.platform === 'win32') {
    // `start` gives the CLI its own visible console
    // `start "title" "program" args`: written out by hand — Node's own quoting breaks `start`'s title
    spawn('cmd.exe', ['/d', '/s', '/c', `start "Claude login" "${binary}" auth login --claudeai`], { env: cliEnv(), detached: true, windowsHide: false, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  } else if (process.platform === 'darwin') {
    spawn('osascript', ['-e', `tell application "Terminal" to do script "'${binary}' auth login --claudeai"`], { env: cliEnv(), detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('x-terminal-emulator', ['-e', binary, 'auth', 'login', '--claudeai'], { env: cliEnv(), detached: true, stdio: 'ignore' }).unref();
  }
  return true;
}

// ------------------------------------------------------------------ limits --

/**
 * The subscription limits the CLI reports while it works (`rate_limit_event` in stream-json):
 * kept from the last run, shown in Settings and next to the model. Null until a run reported them.
 */
export interface ClaudeLimits { status: string; type?: string; resetsAt: number | null; utilization: number | null; at: number }
let lastLimits: ClaudeLimits | null = null;

export function rememberClaudeLimits(info: unknown): void {
  if (!info || typeof info !== 'object') return;
  const o = info as { status?: unknown; rateLimitType?: unknown; resetsAt?: unknown; utilization?: unknown };
  const resets = typeof o.resetsAt === 'number' ? (o.resetsAt < 1e12 ? o.resetsAt * 1000 : o.resetsAt) : null;
  lastLimits = {
    status: typeof o.status === 'string' ? o.status : 'unknown',
    type: typeof o.rateLimitType === 'string' ? o.rateLimitType : undefined,
    resetsAt: resets,
    utilization: typeof o.utilization === 'number' ? o.utilization : null,
    at: Date.now(),
  };
}

export const claudeLimits = (): ClaudeLimits | null => lastLimits;

/** Context / speed figures for the chat's meter from the CLI's final `result` event. */
export function cliUsage(ev: Record<string, unknown>, model: string): { model: string; used: number; ctx: number; generated: number; tps: number; estimated: boolean; compacted: number } | null {
  const u = ev.usage as Record<string, number> | undefined;
  if (!u) return null;
  const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const generated = u.output_tokens ?? 0;
  // modelUsage: { "<model id>": { contextWindow, … } } — the window of the model that answered
  const per = Object.values((ev.modelUsage ?? {}) as Record<string, { contextWindow?: number }>);
  const ctx = per.map((m) => m.contextWindow ?? 0).find((n) => n > 0) ?? 200_000;
  const apiMs = Number(ev.duration_api_ms) || Number(ev.duration_ms) || 0;
  return { model, used, ctx, generated, tps: apiMs > 0 ? Math.round((generated / apiMs) * 1000) : 0, estimated: false, compacted: 0 };
}
