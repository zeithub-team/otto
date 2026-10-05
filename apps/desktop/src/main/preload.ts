import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only bridge between the page and the desktop shell.
 * Keep it minimal: no Node APIs leak into the renderer.
 *
 * `apiBase: ''` means "same origin": in the packaged app the embedded
 * server hosts both the UI and the API, so no port guessing.
 * In dev the page is served by Next on :3000 while the API runs on the
 * embedded server (default port 8000).
 */
function resolveApiBase(): string {
  try {
    const { port, hostname } = window.location;
    if (
      port === '3000' &&
      (hostname === 'localhost' || hostname === '127.0.0.1')
    ) {
      const arg = process.argv.find((a) => a.startsWith('--otto-api-port='));
      return `http://localhost:${arg ? arg.split('=')[1] : 8000}`;
    }
  } catch {
    /* no window location — fall through to same origin */
  }
  return '';
}

contextBridge.exposeInMainWorld('ottoDesktop', {
  isDesktop: true,
  platform: process.platform,
  apiBase: resolveApiBase(),
  /** This build's version (apps/desktop/package.json), passed by the main process. */
  appVersion: (process.argv.find((a) => a.startsWith('--otto-version=')) ?? '').split('=')[1] ?? '',
  /** Open a folder in the OS file manager (resolve on error). */
  revealPath: (path: string) => ipcRenderer.invoke('otto:reveal-path', path),
  /** Restart the application (used after settings that only apply at startup). */
  relaunch: () => ipcRenderer.invoke('otto:relaunch'),
  /** The embedded Tabby terminal window (see main/tabby.ts). */
  tabby: (req: { op: string; rect?: { x: number; y: number; width: number; height: number }; cwd?: string }) => ipcRenderer.invoke('otto:tabby', req),
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
