/**
 * The agent's terminal: `run_command` runs one shell command in the project folder.
 *
 * Mode (Settings → agent.shell):
 *   ask  (default) every command waits for the user's "Run" / "Deny" in the chat;
 *        runs without a chat (task steps, background agents) are refused
 *   auto  commands run straight away
 *   off   the tool refuses
 * Whatever the mode, commands that can wreck the machine are never run (see `dangerReason`).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { withScaffoldRoom } from './scaffold';

export type ShellMode = 'ask' | 'auto' | 'off';

const MAX_OUTPUT = 20_000;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** Commands that are refused in every mode: wiping disks, the system, the user's home, the machine itself. */
const DANGER: Array<[RegExp, string]> = [
  // the commands, not the words: `docker ps --format`, `Format-Table`, `prettier --format` are harmless
  [/(?<![-\w.])(format(\.com)?(?=\s+[a-z]:)|diskpart|mkfs(\.\w+)?|fdisk|bcdedit|cipher\s+\/w)\b/i, 'disk formatting / partitioning'],
  [/\brm\s+(-\w*\s+)*-\w*[rR]\w*\s+(-\w+\s+)*(\/|~|\$HOME|\/\*|[A-Za-z]:[\\/]?)(\s|$)/, 'recursive delete of a root or home folder'],
  // the flag may come before or after the path
  [/\bremove-item\b(?=[^|;]*-recurse)[^|;]*\s(["']?)([A-Za-z]:[\\/]?|~|\$env:(userprofile|systemroot|windir)|\$home)\1(\s|$)/i, 'recursive delete of a drive or home folder'],
  [/\b(rd|rmdir)\s+\/s\b[^|;&]*\s[A-Za-z]:[\\/]?(\s|$)/i, 'recursive delete of a drive'],
  [/\bdel\s+(\/\w\s+)*[A-Za-z]:\\\*/i, 'deleting a whole drive'],
  [/\b(shutdown|restart-computer|stop-computer)\b/i, 'shutting the computer down'],
  [/\breg(\.exe)?\s+delete\s+hk(lm|ey_local_machine)/i, 'deleting system registry keys'],
  [/\b(vssadmin|wbadmin)\b.*\bdelete\b/i, 'deleting backups / shadow copies'],
  [/\bset-executionpolicy\b|\bsetx\s+path\b|\bnetsh\s+advfirewall\b/i, 'changing system security settings'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bomb'],
];

export function dangerReason(command: string): string | null {
  for (const [re, why] of DANGER) if (re.test(command)) return why;
  return null;
}

// ------------------------------------------------------------------ approvals --

const pending = new Map<string, { resolve: (allow: boolean) => void; timer: NodeJS.Timeout }>();

/** Wait for the user's answer to an approval card (resolved by `/api/agent/approval`); false on timeout. */
export function requestApproval(): { id: string; decision: Promise<boolean> } {
  const id = randomUUID();
  const decision = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(false); }, APPROVAL_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
  });
  return { id, decision };
}

export function resolveApproval(id: string, allow: boolean): boolean {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(allow);
  return true;
}

// ------------------------------------------------------------------ choices --

/** ask_user: the model asked the user to pick one of a few options in the chat. */
const choices = new Map<string, { resolve: (answer: string | null) => void; timer: NodeJS.Timeout }>();
const CHOICE_TIMEOUT_MS = 30 * 60_000;

export function requestChoice(): { id: string; answer: Promise<string | null> } {
  const id = randomUUID();
  const answer = new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => { choices.delete(id); resolve(null); }, CHOICE_TIMEOUT_MS);
    choices.set(id, { resolve, timer });
  });
  return { id, answer };
}

export function resolveChoice(id: string, answer: string | null): boolean {
  const c = choices.get(id);
  if (!c) return false;
  clearTimeout(c.timer);
  choices.delete(id);
  c.resolve(answer);
  return true;
}

/** A chat that is stopped mid-question must not leave the agent waiting forever. */
export function denyAllPending(): void {
  for (const id of Array.from(pending.keys())) resolveApproval(id, false);
  for (const id of Array.from(choices.keys())) resolveChoice(id, null);
}

// --------------------------------------------------------------------- running --

export interface CommandResult { code: number | null; output: string; timedOut: boolean; ms: number; cancelled?: boolean }

/** Kill a shell and everything it started (on Windows `kill()` stops only powershell, npm/php live on). */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill());
  else child.kill('SIGKILL');
}

function shellFor(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    // UTF-8 output, and errors as plain text instead of red PowerShell records
    const prelude = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference="SilentlyContinue"; ';
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prelude + command] };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}

/** Run one command; scaffolders into a non-empty folder get the room they need (scaffold.ts). */
export function runCommand(cwd: string, command: string, timeoutSeconds = DEFAULT_TIMEOUT_S, signal?: AbortSignal): Promise<CommandResult> {
  return withScaffoldRoom(cwd, command, () => runRaw(cwd, command, timeoutSeconds, signal));
}

function runRaw(cwd: string, command: string, timeoutSeconds = DEFAULT_TIMEOUT_S, signal?: AbortSignal): Promise<CommandResult> {
  const timeout = Math.min(MAX_TIMEOUT_S, Math.max(1, Math.round(timeoutSeconds) || DEFAULT_TIMEOUT_S)) * 1000;
  const started = Date.now();
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve({ code: null, output: '', timedOut: false, ms: 0, cancelled: true }); return; }
    const { file, args } = shellFor(command);
    let out = '';
    let timedOut = false;
    let cancelled = false;
    const add = (chunk: Buffer) => { if (out.length < MAX_OUTPUT) out += chunk.toString('utf8'); };
    const child = spawn(file, args, { cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
    const onAbort = () => { cancelled = true; killTree(child); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = (code: number | null, extra = '') => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, output: out + extra, timedOut, ms: Date.now() - started, cancelled });
    };
    child.on('error', (err) => done(null, err.message));
    child.on('close', (code) => done(code));
  });
}

/** The text the model gets back. */
export function describeResult(command: string, r: CommandResult): string {
  const body = r.output.length >= MAX_OUTPUT ? `${r.output.slice(0, MAX_OUTPUT)}\n… [output cut at ${MAX_OUTPUT} characters]` : r.output;
  const status = r.cancelled ? 'cancelled by the user' : r.timedOut ? 'stopped: time limit reached' : `exit code ${r.code ?? 'unknown'}`;
  return `$ ${command}\n(${status}, ${Math.round(r.ms / 100) / 10} s)\n${body.trim() || '(no output)'}`;
}

export function normalizeMode(value: unknown): ShellMode {
  return value === 'auto' || value === 'off' ? value : 'ask';
}

// ------------------------------------------------------------- background runs --

interface BackgroundRun { pid: number; command: string; cwd: string; startedAt: number; output: string; exited: number | null | undefined }
const background = new Map<number, BackgroundRun>();

/**
 * Start a long-running command (dev server, watcher, `docker compose logs -f`…) and come back after
 * `settleMs` with what it printed so far; it keeps running. Stopped together with the app.
 */
export function startBackground(cwd: string, command: string, settleMs = 6000): Promise<string> {
  const { file, args } = shellFor(command);
  const child = spawn(file, args, { cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const run: BackgroundRun = { pid: child.pid ?? -1, command, cwd, startedAt: Date.now(), output: '', exited: undefined };
  const add = (chunk: Buffer) => { run.output = (run.output + chunk.toString('utf8')).slice(-MAX_OUTPUT); };
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  child.on('close', (code) => { run.exited = code; });
  child.on('error', (err) => { run.output += err.message; run.exited = null; });
  if (run.pid > 0) background.set(run.pid, run);
  return new Promise((resolve) => setTimeout(() => {
    const state = run.exited === undefined ? `still running in the background (pid ${run.pid}; stop it with: Stop-Process -Id ${run.pid})` : `already exited with code ${run.exited ?? 'unknown'}`;
    resolve(`$ ${command}\n(${state})\n${run.output.trim() || '(no output yet)'}`);
  }, settleMs));
}

export function listBackground(): Array<{ pid: number; command: string; running: boolean; startedAt: number }> {
  return Array.from(background.values()).map((r) => ({ pid: r.pid, command: r.command, running: r.exited === undefined, startedAt: r.startedAt }));
}

export function stopAllBackground(): void {
  for (const r of background.values()) {
    if (r.exited !== undefined) continue;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(r.pid), '/T', '/F'], { windowsHide: true });
      else process.kill(r.pid);
    } catch { /* already gone */ }
  }
}
