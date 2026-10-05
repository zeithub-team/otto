'use client';

import { useSyncExternalStore } from 'react';
import { loadPluginData, savePluginData } from './plugins';

export interface Reminder { id: string; title: string; notes: string; /** ms since epoch */ when: number; done: boolean; fired: boolean }
export interface TimerState { endsAt: number; label: string; running: boolean }
interface State { reminders: Reminder[]; timer: TimerState | null; loaded: boolean }

let state: State = { reminders: [], timer: null, loaded: false };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

const emit = (): void => { listeners.forEach((l) => l()); };
const set = (next: Partial<State>): void => { state = { ...state, ...next }; emit(); };

async function persist(): Promise<void> {
  try { await savePluginData('alertas', { reminders: state.reminders, timer: state.timer }); } catch { /* the next change saves again */ }
}

export function loadAlertas(): Promise<void> {
  if (state.loaded) return Promise.resolve();
  loading ??= loadPluginData<{ reminders?: Reminder[]; timer?: TimerState | null }>('alertas')
    .then((d) => set({ reminders: Array.isArray(d?.reminders) ? d!.reminders! : [], timer: d?.timer ?? null, loaded: true }))
    .catch(() => set({ loaded: true }))
    .finally(() => { loading = null; });
  return loading;
}

export const alertas = {
  getState: (): State => state,
  subscribe: (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; },

  save(rem: Reminder): void {
    const exists = state.reminders.some((r) => r.id === rem.id);
    set({ reminders: exists ? state.reminders.map((r) => (r.id === rem.id ? rem : r)) : [...state.reminders, rem] });
    void persist();
  },
  remove(id: string): void { set({ reminders: state.reminders.filter((r) => r.id !== id) }); void persist(); },
  markFired(ids: string[]): void {
    if (ids.length === 0) return;
    set({ reminders: state.reminders.map((r) => (ids.includes(r.id) ? { ...r, fired: true } : r)) });
    void persist();
  },
  startTimer(seconds: number, label: string): void { set({ timer: { endsAt: Date.now() + seconds * 1000, label, running: true } }); void persist(); },
  stopTimer(): void { set({ timer: state.timer ? { ...state.timer, running: false } : null }); void persist(); },
};

export function useAlertas(): State {
  return useSyncExternalStore(alertas.subscribe, alertas.getState, alertas.getState);
}

// ------------------------------------------------------------------ sound --

/** Short beeps with WebAudio, so no sound file is needed. Reminder: two soft tones; timer: three higher ones. */
export function playSound(kind: 'reminder' | 'timer' = 'reminder'): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const tones = kind === 'timer' ? [880, 880, 1174] : [659, 880];
    tones.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = ctx.currentTime + i * 0.28;
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.24);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.26);
    });
    window.setTimeout(() => void ctx.close(), 1500);
  } catch { /* no audio available */ }
}

export function notify(title: string, body: string): void {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') new Notification(title, { body });
    else if (Notification.permission !== 'denied') void Notification.requestPermission().then((p) => { if (p === 'granted') new Notification(title, { body }); });
  } catch { /* notifications unavailable */ }
}

export const DAY_MS = 86_400_000;
