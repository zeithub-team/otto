import type { ViewType } from '../types';

/** BroadcastChannel the documentation window uses to drive the main window. */
export const DOCS_CHANNEL = 'otto-docs-nav';

/**
 * Open the documentation in its own window (reused when already open). The
 * desktop shell turns `window.open` into a real BrowserWindow; in a plain
 * browser it becomes a popup. Returns false when the popup was blocked.
 */
export function openDocsWindow(): boolean {
  const win = window.open('/?docs=1', 'otto-docs', 'popup=yes,width=1120,height=820');
  if (!win) return false;
  win.focus();
  return true;
}

/** Ask the main window to show a section. */
export function requestMainView(view: ViewType): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(DOCS_CHANNEL);
  channel.postMessage({ view });
  channel.close();
  try {
    window.opener?.focus();
  } catch {
    /* cross-window focus can be refused */
  }
}
