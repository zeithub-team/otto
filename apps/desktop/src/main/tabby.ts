/**
 * Tabby inside Otto: the installed Tabby terminal (tabby.sh) is started as usual and its window is
 * made a child window of Otto's, laid over the "Tabby" tab. The page reports where that tab is
 * (`otto:tabby` → bounds) and the window follows it; leaving the tab hides it, quitting Otto gives
 * the window back to Tabby so it is never destroyed with ours.
 *
 * Windows only. The Win32 calls go through one long-lived PowerShell helper (Add-Type C#), so Otto
 * needs no native module.
 */

import { BrowserWindow, app, ipcMain } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class OttoTabby {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWL(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWL(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);

  const long WS_POPUP = 0x80000000L, WS_CHILD = 0x40000000L, WS_CAPTION = 0x00C00000L, WS_THICKFRAME = 0x00040000L;
  const uint NOACTIVATE = 0x10, FRAMECHANGED = 0x20, SHOW = 0x40;

  // the visible, titled top-level window of a Tabby process
  public static long Find() {
    var pids = new HashSet<uint>();
    foreach (var p in Process.GetProcessesByName("Tabby")) pids.Add((uint)p.Id);
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pids.Contains(pid) && IsWindowVisible(h) && GetWindowTextLengthW(h) > 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found.ToInt64();
  }
  public static int Alive(long h) { return IsWindow(new IntPtr(h)) ? 1 : 0; }
  // returns the original style, needed to give the window back
  public static long Embed(long child, long parent, int x, int y, int w, int hh) {
    IntPtr c = new IntPtr(child);
    long style = GetWL(c, -16).ToInt64();
    long next = (style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME)) | WS_CHILD;
    SetWL(c, -16, new IntPtr(next));
    SetParent(c, new IntPtr(parent));
    SetWindowPos(c, IntPtr.Zero, x, y, w, hh, FRAMECHANGED | SHOW);
    return style;
  }
  public static void Move(long child, int x, int y, int w, int hh) {
    SetWindowPos(new IntPtr(child), IntPtr.Zero, x, y, w, hh, NOACTIVATE | SHOW);
  }
  public static void Hide(long child) { ShowWindow(new IntPtr(child), 0); }
  public static void Release(long child, long style) {
    IntPtr c = new IntPtr(child);
    if (!IsWindow(c)) return;
    SetParent(c, IntPtr.Zero);
    SetWL(c, -16, new IntPtr(style));
    SetWindowPos(c, IntPtr.Zero, 120, 120, 1100, 700, FRAMECHANGED | SHOW);
  }
}
'@
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $a = $line.Split(' ')
  try {
    $r = switch ($a[0]) {
      'find'    { [OttoTabby]::Find() }
      'alive'   { [OttoTabby]::Alive([long]$a[1]) }
      'embed'   { [OttoTabby]::Embed([long]$a[1], [long]$a[2], [int]$a[3], [int]$a[4], [int]$a[5], [int]$a[6]) }
      'move'    { [OttoTabby]::Move([long]$a[1], [int]$a[2], [int]$a[3], [int]$a[4], [int]$a[5]); 0 }
      'hide'    { [OttoTabby]::Hide([long]$a[1]); 0 }
      'release' { [OttoTabby]::Release([long]$a[1], [long]$a[2]); 0 }
      default   { throw "unknown command $($a[0])" }
    }
    [Console]::Out.WriteLine("ok $r")
  } catch {
    [Console]::Out.WriteLine("err $($_.Exception.Message -replace '\s+', ' ')")
  }
  [Console]::Out.Flush()
}
`;

/** Where the Tabby installer puts it (per-user first, then machine-wide). */
export function findTabby(): string | null {
  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Tabby', 'Tabby.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tabby', 'Tabby.exe'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

// ------------------------------------------------------------------ helper --

let helper: ChildProcessWithoutNullStreams | null = null;
let ready: Promise<void> | null = null;
const waiting: Array<(line: string) => void> = [];
let chain: Promise<unknown> = Promise.resolve();

function startHelper(): Promise<void> {
  if (ready) return ready;
  const file = path.join(app.getPath('userData'), 'tabby-host.ps1');
  fs.writeFileSync(file, HELPER, 'utf8');
  // -ExecutionPolicy Bypass applies to this one process only
  helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true });
  let buffer = '';
  ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the window helper did not start')), 20_000);
    helper!.stdout.on('data', (d: Buffer) => {
      buffer += d.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line === 'ready') { clearTimeout(timer); resolve(); continue; }
        waiting.shift()?.(line);
      }
    });
    helper!.on('exit', () => {
      clearTimeout(timer);
      helper = null;
      ready = null;
      while (waiting.length) waiting.shift()!('err helper exited');
      reject(new Error('the window helper exited'));
    });
  });
  ready.catch(() => { /* reported to the caller */ });
  return ready;
}

/** One command at a time; the answer is the text after "ok ". */
function call(command: string): Promise<string> {
  const run = chain.then(async () => {
    await startHelper();
    return new Promise<string>((resolve, reject) => {
      waiting.push((line) => (line.startsWith('ok') ? resolve(line.slice(2).trim()) : reject(new Error(line.slice(3).trim() || 'helper error'))));
      helper!.stdin.write(command + '\n');
    });
  });
  chain = run.catch(() => undefined);
  return run;
}

// ------------------------------------------------------------------ embed --

interface Rect { x: number; y: number; width: number; height: number }
let embedded: { hwnd: string; style: string } | null = null;
let lastRect: Rect | null = null;

function parentHandle(win: BrowserWindow): string {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rectArgs = (r: Rect) => [Math.round(r.x), Math.round(r.y), Math.max(50, Math.round(r.width)), Math.max(50, Math.round(r.height))].join(' ');

async function alive(): Promise<boolean> {
  if (!embedded) return false;
  if ((await call(`alive ${embedded.hwnd}`)) === '1') return true;
  embedded = null;
  return false;
}

/** Start Tabby if needed, take its window and lay it over `rect` (device pixels of Otto's content). */
async function open(win: BrowserWindow, rect: Rect, cwd?: string): Promise<{ status: string; detail?: string }> {
  if (process.platform !== 'win32') return { status: 'unsupported' };
  const exe = findTabby();
  if (!exe) return { status: 'missing' };
  lastRect = rect;
  if (await alive()) {
    await call(`move ${embedded!.hwnd} ${rectArgs(rect)}`);
    if (cwd) spawn(exe, ['open', cwd], { detached: true, stdio: 'ignore' }).unref();
    return { status: 'ready' };
  }
  let hwnd = await call('find');
  if (hwnd === '0') {
    spawn(exe, cwd ? ['open', cwd] : [], { detached: true, stdio: 'ignore', cwd: cwd || undefined }).unref();
    for (let i = 0; i < 60 && hwnd === '0'; i++) {
      await sleep(400);
      hwnd = await call('find');
    }
    if (hwnd === '0') return { status: 'error', detail: 'Tabby did not open a window' };
    await sleep(600); // let it finish its first layout before it is resized
  } else if (cwd) {
    spawn(exe, ['open', cwd], { detached: true, stdio: 'ignore' }).unref();
  }
  const style = await call(`embed ${hwnd} ${parentHandle(win)} ${rectArgs(lastRect)}`);
  embedded = { hwnd, style };
  return { status: 'ready' };
}

/** Give the window back as a normal Tabby window (Otto is closing, or the user wants it separate). */
async function release(): Promise<void> {
  if (!embedded) return;
  const { hwnd, style } = embedded;
  embedded = null;
  await call(`release ${hwnd} ${style}`).catch(() => undefined);
}

export function installTabby(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('otto:tabby', async (_event, req: unknown) => {
    const r = (req ?? {}) as { op?: string; rect?: Rect; cwd?: string };
    const win = getWindow();
    try {
      switch (r.op) {
        case 'status':
          return { status: process.platform !== 'win32' ? 'unsupported' : findTabby() ? (embedded ? 'ready' : 'idle') : 'missing' };
        case 'open':
          if (!win || !r.rect) return { status: 'error', detail: 'no window' };
          return await open(win, r.rect, typeof r.cwd === 'string' && r.cwd ? r.cwd : undefined);
        case 'bounds':
          if (!r.rect) return { status: 'error' };
          lastRect = r.rect;
          if (!(await alive())) return { status: 'closed' };
          await call(`move ${embedded!.hwnd} ${rectArgs(r.rect)}`);
          return { status: 'ready' };
        case 'hide':
          if (embedded) await call(`hide ${embedded.hwnd}`);
          return { status: 'hidden' };
        case 'detach':
          await release();
          return { status: 'idle' };
        default:
          return { status: 'error', detail: 'unknown op' };
      }
    } catch (exc) {
      return { status: 'error', detail: exc instanceof Error ? exc.message : String(exc) };
    }
  });

  // never let Tabby's window die with ours
  let releasing = false;
  app.on('before-quit', (event) => {
    if (!embedded || releasing) { helper?.kill(); return; }
    releasing = true;
    event.preventDefault();
    void Promise.race([release(), sleep(3000)]).finally(() => { helper?.kill(); app.quit(); });
  });
}

/** Called when the main window is about to close: true while the window is being given back first. */
export function holdCloseForTabby(win: BrowserWindow): boolean {
  if (!embedded) return false;
  void Promise.race([release(), sleep(3000)]).finally(() => win.close());
  return true;
}
