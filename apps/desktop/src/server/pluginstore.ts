/** Storage for the built-in plugins (zeithub.coverty, zeithub.alertas): one JSON document per plugin in the app data folder. */

import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_NAMES = ['coverty', 'alertas'] as const;
export type PluginName = (typeof PLUGIN_NAMES)[number];

const MAX_BYTES = 5 * 1024 * 1024;

export const isPluginName = (name: string): name is PluginName => (PLUGIN_NAMES as readonly string[]).includes(name);

const file = (dataDir: string, name: PluginName): string => path.join(dataDir, 'plugins', `${name}.json`);

/** The stored document, or null when nothing was saved yet. */
export function readPlugin(dataDir: string, name: PluginName): unknown {
  try {
    return JSON.parse(fs.readFileSync(file(dataDir, name), 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Written to a temp file first, so a crash mid-write never leaves a half-written vault. */
export function writePlugin(dataDir: string, name: PluginName, data: unknown): void {
  const text = JSON.stringify(data);
  if (text.length > MAX_BYTES) throw new Error('The data is too large');
  const target = file(dataDir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, target);
}
