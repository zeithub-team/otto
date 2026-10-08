import { app, BrowserWindow, clipboard, ipcMain, Menu, shell } from 'electron';
import { clipboardAction } from './shortcuts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { startEmbeddedServer } from './server';
import { holdCloseForTabby, installTabby } from './tabby';
import { startUpdateChecks } from './updates';

const isDev = process.argv.includes('--dev');

// macOS: an app started from the Dock gets a bare PATH (/usr/bin:/bin…), without Homebrew, nvm or
// ~/.local/bin — node, git, npx, ollama and the Claude/Codex CLIs would not be found. Take the PATH
// of the user's login shell, plus the usual folders in case the shell does not answer.
if (process.platform === 'darwin') {
  const extra = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
  let shellPath = '';
  try {
    const r = spawnSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "%s" "$PATH"'], { encoding: 'utf8', timeout: 4000 });
    shellPath = (r.stdout ?? '').trim().split('\n').pop() ?? '';
  } catch { /* keep the defaults */ }
  const parts = [...shellPath.split(':'), ...(process.env.PATH ?? '').split(':'), ...extra].filter(Boolean);
  process.env.PATH = [...new Set(parts)].join(':');
}

const apiPort = Number(process.env.OTTO_PORT ?? 8000);

let mainWindow: BrowserWindow | null = null;
installTabby(() => mainWindow);
let server: Awaited<ReturnType<typeof startEmbeddedServer>> | null = null;

// Reveal a folder in Explorer — requested by the renderer (Edit project dialog)
ipcMain.handle('otto:reveal-path', (_event, target: unknown) => {
  if (typeof target !== 'string' || !target.trim()) return 'invalid path';
  return shell.openPath(target);
});

// Restart the whole app (Settings → "Save and restart")
ipcMain.handle('otto:relaunch', () => {
  app.relaunch();
  // quit normally (not exit) so the server, terminals and dev servers are closed properly; the relaunch starts a new instance
  setTimeout(() => app.quit(), 150);
  return true;
});

/** The otto icon (window, taskbar, Alt+Tab); the default Electron logo otherwise. */
function resolveIcon(): string | undefined {
  const file = path.join(app.getAppPath(), 'assets', 'icon.ico');
  return fs.existsSync(file) ? file : undefined;
}

function resolvePreload(): string {
  return path.join(__dirname, 'preload.js');
}

async function loadApp(win: BrowserWindow): Promise<void> {
  // The API + WebSocket server runs in *both* modes: in dev the renderer is
  // served by Next on :3000 and talks to this embedded server (preload maps
  // port 3000 → http://localhost:8000), in production it is same-origin.
  const port = isDev ? apiPort : 0;
  try {
    server = await startEmbeddedServer({ port });
    app.on('will-quit', () => {
      void server?.close();
    });
  } catch (exc) {
    if (!isDev) throw exc;
    // Dev: port 8000 may already be taken by a standalone `npm run dev:server`.
    console.warn('[main] embedded API server not started:', exc);
  }

  if (isDev) {
    const devUrl = process.env.OTTO_DEV_URL ?? 'http://localhost:3000';
    await win.loadURL(devUrl);
    return;
  }

  // Production: embedded server hosts the built frontend and the API
  await win.loadURL(server!.url);
}

const zh = (): boolean => app.getLocale().toLowerCase().startsWith('ru');
const L = (ru: string, en: string): string => (zh() ? ru : en);

/**
 * Standard desktop shortcuts without an application menu:
 *  Ctrl+C/X/V/A/Z/Y also on a Russian layout, Ctrl +/−/0 zoom, F5 / Ctrl+R reload,
 *  F11 full screen, F12 / Ctrl+Shift+I developer tools, and a right-click menu
 *  (undo, cut, copy, paste, select all, copy link).
 */
function installStandardShortcuts(win: BrowserWindow, dev: boolean): void {
  const web = win.webContents;
  const zoomBy = (delta: number | 'reset'): void => {
    const level = delta === 'reset' ? 0 : Math.max(-3, Math.min(5, web.getZoomLevel() + delta));
    web.setZoomLevel(level);
  };
  web.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = input.key;

    // Clipboard keys. With the application menu removed Chromium no longer runs Copy / Cut / Paste
    // for Ctrl+C / X / V on Windows, so every layout is handled here (letters of the Russian layout
    // and drivers that send no `code` included). Select all, undo and redo stay with the page: the code
    // editor has its own, and plain fields are covered by the renderer (see app/page.tsx).
    const clip = clipboardAction(input);
    if (clip) {
      event.preventDefault();
      if (clip === 'copy') web.copy(); else if (clip === 'cut') web.cut(); else web.paste();
      return;
    }
    if (mod && (key === '=' || key === '+')) { event.preventDefault(); zoomBy(0.5); return; }
    if (mod && (key === '-' || key === '_')) { event.preventDefault(); zoomBy(-0.5); return; }
    if (mod && key === '0') { event.preventDefault(); zoomBy('reset'); return; }
    // Plain Ctrl+R belongs to the editor (replace); reload is F5 and Ctrl+Shift+R
    if (key === 'F5' || (mod && input.shift && !input.alt && input.code === 'KeyR')) {
      event.preventDefault();
      if (input.shift) web.reloadIgnoringCache(); else web.reload();
      return;
    }
    if (key === 'F11') { event.preventDefault(); win.setFullScreen(!win.isFullScreen()); return; }
    if (key === 'F12' || (mod && input.shift && input.code === 'KeyI')) { event.preventDefault(); web.toggleDevTools(); }
  });

  web.on('context-menu', (_event, params) => {
    const flags = params.editFlags;
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      items.push(
        { label: L('Отменить', 'Undo'), enabled: flags.canUndo, click: () => web.undo(), accelerator: 'CommandOrControl+Z', registerAccelerator: false },
        { label: L('Повторить', 'Redo'), enabled: flags.canRedo, click: () => web.redo(), accelerator: 'CommandOrControl+Y', registerAccelerator: false },
        { type: 'separator' },
        { label: L('Вырезать', 'Cut'), enabled: flags.canCut, click: () => web.cut(), accelerator: 'CommandOrControl+X', registerAccelerator: false },
        { label: L('Копировать', 'Copy'), enabled: flags.canCopy, click: () => web.copy(), accelerator: 'CommandOrControl+C', registerAccelerator: false },
        { label: L('Вставить', 'Paste'), enabled: flags.canPaste, click: () => web.paste(), accelerator: 'CommandOrControl+V', registerAccelerator: false },
        { type: 'separator' },
        { label: L('Выделить всё', 'Select all'), enabled: flags.canSelectAll, click: () => web.selectAll(), accelerator: 'CommandOrControl+A', registerAccelerator: false },
      );
    } else {
      if (params.linkURL) items.push({ label: L('Копировать ссылку', 'Copy link'), click: () => clipboard.writeText(params.linkURL) }, { type: 'separator' });
      items.push(
        { label: L('Копировать', 'Copy'), enabled: Boolean(params.selectionText), click: () => web.copy(), accelerator: 'CommandOrControl+C', registerAccelerator: false },
        { label: L('Выделить всё', 'Select all'), click: () => web.selectAll(), accelerator: 'CommandOrControl+A', registerAccelerator: false },
      );
    }
    if (dev) items.push({ type: 'separator' }, { label: 'Inspect', click: () => web.inspectElement(params.x, params.y) });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function createWindow(): void {
  // The default menu owns Ctrl+R (reload), Ctrl+W, Ctrl+Shift+I… and swallows
  // them before the page sees the keydown, which breaks in-app hotkeys.
  Menu.setApplicationMenu(null);
  // Windows groups taskbar buttons (and picks their icon) by this id
  if (process.platform === 'win32') app.setAppUserModelId('team.zeithub.otto');

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0a0f0d',
    title: 'zeithub.otto',
    icon: resolveIcon(),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Dev: tells the preload which port the embedded API server uses
      additionalArguments: [`--otto-api-port=${apiPort}`, `--otto-version=${app.getVersion()}`],
    },
  });

  // The application menu is gone (it swallowed the page's own hotkeys), so the
  // standard shortcuts and the right-click menu are provided here.
  installStandardShortcuts(mainWindow, isDev);
  // Tabby's window is a child of ours while embedded: give it back before ours is destroyed
  mainWindow.on('close', (event) => {
    if (mainWindow && holdCloseForTabby(mainWindow)) event.preventDefault();
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // No popup windows except the documentation (same origin, `?docs=1`);
  // external links open in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      const current = new URL(mainWindow?.webContents.getURL() ?? '');
      if (target.origin === current.origin && target.searchParams.get('docs') === '1') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 1120,
            height: 820,
            minWidth: 640,
            minHeight: 480,
            backgroundColor: '#0a0f0d',
            title: 'zeithub.otto',
            icon: resolveIcon(),
            autoHideMenuBar: true,
          },
        };
      }
    } catch {
      /* malformed url — fall through */
    }
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Stay inside the app: allow same-origin navigation only
    const current = mainWindow?.webContents.getURL() ?? '';
    try {
      if (new URL(url).origin === new URL(current).origin) return;
    } catch {
      /* malformed url — block */
    }
    event.preventDefault();
  });

  void loadApp(mainWindow);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Single instance: a second launch just focuses the existing window
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    if (!isDev) startUpdateChecks(() => mainWindow);

    app.on('activate', () => {
      // macOS: re-create the window when the dock icon is clicked
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
