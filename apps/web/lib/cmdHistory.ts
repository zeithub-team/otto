import { useCallback, useRef, useState } from 'react';

const MAX = 500;

function load(key: string): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(key) || '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-MAX) : [];
  } catch {
    return [];
  }
}

/**
 * Shell-style command history: Up goes back, Down goes forward and ends at what you had typed.
 * Kept per `key` (e.g. per project) in localStorage, so it survives switching tabs and restarts.
 */
export function useCommandHistory(key: string) {
  const [items, setItems] = useState<string[]>(() => (typeof window === 'undefined' ? [] : load(key)));
  const pos = useRef(-1); // -1 = not browsing
  const draft = useRef('');
  const loadedKey = useRef(key);
  if (loadedKey.current !== key) {
    loadedKey.current = key;
    pos.current = -1;
    if (typeof window !== 'undefined') setItems(load(key));
  }

  const add = useCallback((cmd: string) => {
    pos.current = -1;
    setItems((prev) => {
      const next = prev[prev.length - 1] === cmd ? prev : [...prev, cmd].slice(-MAX);
      try { window.localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage blocked */ }
      return next;
    });
  }, [key]);

  /** `current` is what is in the input now; returns the text to show, or null when there is nothing to change. */
  const older = useCallback((current: string): string | null => {
    if (items.length === 0) return null;
    if (pos.current === -1) { draft.current = current; pos.current = items.length - 1; }
    else if (pos.current > 0) pos.current -= 1;
    return items[pos.current];
  }, [items]);

  const newer = useCallback((): string | null => {
    if (pos.current === -1) return null;
    if (pos.current >= items.length - 1) { pos.current = -1; return draft.current; }
    pos.current += 1;
    return items[pos.current];
  }, [items]);

  const reset = useCallback(() => { pos.current = -1; }, []);
  return { add, older, newer, reset };
}
