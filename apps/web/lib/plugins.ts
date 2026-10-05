'use client';

import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from './api';

export type PluginId = 'coverty' | 'alertas';

export const PLUGIN_IDS: PluginId[] = ['coverty', 'alertas'];

const ENABLED_KEY = 'otto-plugins-enabled';
const EVENT = 'otto:plugins-changed';

function readEnabled(): Record<PluginId, boolean> {
  try {
    const v = JSON.parse(window.localStorage.getItem(ENABLED_KEY) || '{}') as Partial<Record<PluginId, boolean>>;
    return { coverty: v.coverty === true, alertas: v.alertas === true };
  } catch {
    return { coverty: false, alertas: false };
  }
}

/** Which plugins are switched on (kept in this browser; every component that uses it updates together). */
export function usePlugins() {
  const [enabled, setEnabled] = useState<Record<PluginId, boolean>>({ coverty: false, alertas: false });
  useEffect(() => {
    setEnabled(readEnabled());
    const sync = () => setEnabled(readEnabled());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener('storage', sync); };
  }, []);
  const toggle = useCallback((id: PluginId, on: boolean) => {
    const next = { ...readEnabled(), [id]: on };
    try { window.localStorage.setItem(ENABLED_KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return { enabled, toggle };
}

/** A plugin's saved document (null when nothing was saved yet). */
export async function loadPluginData<T>(id: PluginId): Promise<T | null> {
  const res = await fetch(`${API_BASE}/api/plugins/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { data: T | null }).data;
}

export async function savePluginData(id: PluginId, data: unknown): Promise<void> {
  const res = await fetch(`${API_BASE}/api/plugins/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
