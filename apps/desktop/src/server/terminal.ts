/**
 * Project shell sessions — the backend behind the Terminal view.
 *
 * One persistent OS shell per session (PowerShell on Windows, `$SHELL` on
 * POSIX), spawned with `cwd` locked to the project folder. Stdout/stderr are
 * multiplexed to attached WebSocket clients (`ws.ts`), stdin comes back the
 * same way. No `node-pty` on purpose: a native pty module would need a
 * per-Electron rebuild, while piped stdio covers the real use cases
 * (`npm run dev`, `python main.py`, `git …`, …).
 *
 * Interactive TTY programs (editors, pagers, password prompts) will not work
 * here — the UI says so instead of hanging silently.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { live } from './appconfig';
import { projectPhpEnv } from './phpvm';
import { refreshProcessPath } from './env';
import { randomUUID } from 'crypto';
import { requestPermission } from './permissions';

export interface TerminalMeta {
  id: string;
  project_id: number;
  shell: string;
  running: boolean;
  exit_code: number | null;
  started_at: number;
}

interface SessionRecord extends TerminalMeta {
  proc: ChildProcess | null;
  buffer: string;
  listeners: Set<(data: string) => void>;
  exitListeners: Set<(code: number | null) => void>;
}

/** Ring buffer cap per session (keeps long dev-server logs bounded). */
const MAX_BUFFER = 256 * 1024;
/** Bytes replayed to a freshly attached client. */
const REPLAY_TAIL = 64 * 1024;

const sessions = new Map<string, SessionRecord>();

function shellCmd(): { cmd: string; args: string[]; label: string } {
  const choice = live<string>('terminal.shell');
  if (process.platform === 'win32' && choice === 'cmd') return { cmd: 'cmd.exe', args: ['/d', '/k', 'chcp 65001>nul'], label: 'cmd' };
  if (process.platform === 'win32' && choice === 'bash') return { cmd: 'bash.exe', args: ['--login', '-i'], label: 'bash' };
  if (process.platform === 'win32' && choice === 'pwsh') {
    return { cmd: 'pwsh.exe', args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', "$ProgressPreference = 'SilentlyContinue'"], label: 'pwsh' };
  }
  if (process.platform !== 'win32' && (choice === 'bash' || choice === 'zsh')) return { cmd: choice, args: [], label: choice };
  if (process.platform === 'win32') {
    return {
      cmd: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NoExit',
        '-Command',
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $ProgressPreference = \'SilentlyContinue\'',
      ],
      label: 'powershell',
    };
  }
  return {
    cmd: process.env.SHELL || '/bin/bash',
    args: [],
    label: process.env.SHELL || 'bash',
  };
}

function appendBuffer(rec: SessionRecord, data: string): void {
  rec.buffer += data;
  if (rec.buffer.length > MAX_BUFFER) {
    rec.buffer = rec.buffer.slice(rec.buffer.length - MAX_BUFFER);
  }
}

function emit(rec: SessionRecord, data: string): void {
  appendBuffer(rec, data);
  for (const fn of rec.listeners) {
    try {
      fn(data);
    } catch {
      /* a dead client must never break the session */
    }
  }
}

function emitExit(rec: SessionRecord, code: number | null): void {
  rec.running = false;
  rec.exit_code = code;
  rec.proc = null;
  appendBuffer(rec, `\n[сессия завершена, код ${code ?? '?'}]\n`);
  for (const fn of rec.exitListeners) {
    try {
      fn(code);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Spawn a shell with `cwd` = project folder. The caller (api.ts) resolves
 * and validates the project path — this module never touches the DB.
 */
export async function startTerminal(projectId: number, cwd: string): Promise<TerminalMeta> {
  if (live<string>('permissions.terminal') !== 'allow') {
    const approval = requestPermission({ kind: 'terminal', action: 'Открыть локальную командную оболочку', target: cwd });
    if (!(await approval.decision)) throw new Error('Запуск терминала отклонён или время подтверждения истекло');
  }
  refreshProcessPath();
  const { cmd, args, label } = shellCmd();
  const id = randomUUID();
  const rec: SessionRecord = {
    id,
    project_id: projectId,
    shell: label,
    running: true,
    exit_code: null,
    started_at: Math.floor(Date.now() / 1000),
    proc: null,
    buffer: '',
    listeners: new Set(),
    exitListeners: new Set(),
  };
  let proc: ChildProcess;
  try {
    proc = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      // the project's PHP version and php.ini (Data/Services tab → PHP versions) apply in its terminal
      env: projectPhpEnv(cwd, {
        ...process.env,
        TERM: 'dumb',
        POWERSHELL_TELEMETRY_OPTOUT: '1',
        PYTHONIOENCODING: 'utf-8',
      }),
    });
  } catch (exc) {
    throw new Error(`Не удалось запустить shell: ${exc instanceof Error ? exc.message : String(exc)}`);
  }
  rec.proc = proc;
  proc.stdout?.on('data', (buf: Buffer) => emit(rec, buf.toString('utf8')));
  proc.stderr?.on('data', (buf: Buffer) => emit(rec, buf.toString('utf8')));
  proc.on('error', (exc) => {
    emit(rec, `\n[ошибка запуска: ${exc.message}]\n`);
    emitExit(rec, null);
  });
  proc.on('exit', (code) => emitExit(rec, code));
  sessions.set(id, rec);
  return meta(rec);
}

function meta(rec: SessionRecord): TerminalMeta {
  return {
    id: rec.id,
    project_id: rec.project_id,
    shell: rec.shell,
    running: rec.running,
    exit_code: rec.exit_code,
    started_at: rec.started_at,
  };
}

export function listTerminals(projectId?: number): TerminalMeta[] {
  const out: TerminalMeta[] = [];
  for (const rec of sessions.values()) {
    if (projectId === undefined || rec.project_id === projectId) out.push(meta(rec));
  }
  out.sort((a, b) => a.started_at - b.started_at);
  return out;
}

/** Write user input to the session shell. False = session is gone. */
export function writeTerminal(id: string, data: string): boolean {
  const rec = sessions.get(id);
  if (!rec || !rec.running || !rec.proc?.stdin) return false;
  try {
    rec.proc.stdin.write(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort Ctrl+C: works for console programs attached to pipes, harmless
 * otherwise. Returns false when the session is already dead.
 */
export function interruptTerminal(id: string): boolean {
  return writeTerminal(id, '\x03');
}

/** Kill the whole process tree (dev servers spawn children). */
export function killTerminal(id: string): boolean {
  const rec = sessions.get(id);
  if (!rec) return false;
  const proc = rec.proc;
  if (!proc || proc.exitCode !== null) {
    if (rec.running) emitExit(rec, rec.exit_code);
    return true;
  }
  try {
    if (process.platform === 'win32' && proc.pid !== undefined) {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
    } else {
      proc.kill('SIGKILL');
    }
  } catch {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }
  return true;
}

/** Forget a finished session (running ones are killed first). */
export function removeTerminal(id: string): boolean {
  const rec = sessions.get(id);
  if (!rec) return false;
  if (rec.running) killTerminal(id);
  rec.listeners.clear();
  rec.exitListeners.clear();
  sessions.delete(id);
  return true;
}

/** Last output bytes for a freshly attached client. */
export function replayTail(id: string): string | null {
  const rec = sessions.get(id);
  if (!rec) return null;
  return rec.buffer.slice(-REPLAY_TAIL);
}

export function sessionRunning(id: string): boolean {
  return sessions.get(id)?.running ?? false;
}

export function onTerminalOutput(id: string, fn: (data: string) => void): () => void {
  const rec = sessions.get(id);
  if (!rec) return () => undefined;
  rec.listeners.add(fn);
  return () => {
    rec.listeners.delete(fn);
  };
}

export function onTerminalExit(id: string, fn: (code: number | null) => void): () => void {
  const rec = sessions.get(id);
  if (!rec) return () => undefined;
  rec.exitListeners.add(fn);
  return () => {
    rec.exitListeners.delete(fn);
  };
}

/** Kill every session (server shutdown). Test hook. */
export function killAllTerminals(): void {
  for (const id of [...sessions.keys()]) {
    try {
      killTerminal(id);
    } catch {
      /* ignore */
    }
    sessions.delete(id);
  }
}
