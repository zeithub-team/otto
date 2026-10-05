'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchAppSettings, saveAppSettings, type AppSettings, type SettingValue } from '../../../lib/api';

/**
 * Server-backed settings with a local draft: edit freely, then Save. Tracks
 * which restart-settings were saved but are not yet in effect.
 */
export function useAppSettings() {
  const [data, setData] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<Record<string, SettingValue>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await fetchAppSettings();
      setData(next);
      setDraft({});
      setLoadError('');
    } catch (exc) {
      setLoadError(exc instanceof Error ? exc.message : String(exc));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const value = useCallback((key: string): SettingValue => (key in draft ? draft[key] : data?.values[key] ?? ''), [draft, data]);
  const set = useCallback((key: string, next: SettingValue) => {
    setDraft((prev) => {
      const saved = data?.values[key];
      const out = { ...prev, [key]: next };
      if (saved !== undefined && String(saved) === String(next)) delete out[key];
      return out;
    });
    setErrors((prev) => {
      const out = { ...prev };
      delete out[key];
      return out;
    });
  }, [data]);

  const dirtyKeys = useMemo(() => Object.keys(draft), [draft]);

  /** Restart-settings whose saved value differs from what the running app uses. */
  const pendingRestart = useMemo(() => {
    if (!data) return [];
    return data.meta.filter((m) => m.restart && String(data.values[m.key]) !== String(data.running[m.key] ?? data.values[m.key])).map((m) => m.key);
  }, [data]);

  /** The draft touches something that only applies after a restart. */
  const draftNeedsRestart = useMemo(() => {
    if (!data) return false;
    return dirtyKeys.some((k) => data.meta.find((m) => m.key === k)?.restart && String(draft[k]) !== String(data.running[k] ?? ''));
  }, [data, dirtyKeys, draft]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!dirtyKeys.length) return true;
    setBusy(true);
    try {
      const result = await saveAppSettings(draft);
      setData(result);
      setErrors(result.errors);
      // keep only the values the server refused, so the user can fix them
      setDraft((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k in result.errors)));
      if (!Object.keys(result.errors).length) {
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 2000);
      }
      return Object.keys(result.errors).length === 0;
    } catch (exc) {
      setErrors({ _: exc instanceof Error ? exc.message : String(exc) });
      return false;
    } finally {
      setBusy(false);
    }
  }, [dirtyKeys.length, draft]);

  const discard = useCallback(() => {
    setDraft({});
    setErrors({});
  }, []);

  return { data, value, set, dirtyKeys, pendingRestart, draftNeedsRestart, save, discard, busy, errors, loadError, savedFlash, reload: load };
}

export type AppSettingsApi = ReturnType<typeof useAppSettings>;
