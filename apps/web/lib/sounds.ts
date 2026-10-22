/**
 * Short UI sounds, synthesized with Web Audio (no audio files):
 *   start  — a request went to the model / a task run started
 *   answer — the model's answer arrived in the chat
 *   done   — a task from the board finished all its steps
 *   error  — the answer ended with an error
 * Off/on per viewer in Settings → General (stored in localStorage).
 */
export type SoundKind = 'start' | 'answer' | 'done' | 'error';

const KEY = 'otto-sounds';
let ctx: AudioContext | null = null;

export function soundsEnabled(): boolean {
  try { return window.localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}

export function setSoundsEnabled(on: boolean): void {
  try { window.localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* private window */ }
}

/** [frequency Hz, start s, length s] per note. */
const NOTES: Record<SoundKind, Array<[number, number, number]>> = {
  start: [[660, 0, 0.09], [880, 0.08, 0.12]],
  answer: [[988, 0, 0.16]],
  done: [[784, 0, 0.12], [988, 0.1, 0.12], [1319, 0.2, 0.28]],
  error: [[440, 0, 0.14], [330, 0.13, 0.22]],
};

export function playSound(kind: SoundKind, force = false): void {
  if (typeof window === 'undefined' || (!force && !soundsEnabled())) return;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    for (const [freq, at, len] of NOTES[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // soft attack and release: no clicks, quiet enough not to startle
      gain.gain.setValueAtTime(0, now + at);
      gain.gain.linearRampToValueAtTime(0.08, now + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + len + 0.02);
    }
  } catch { /* audio unavailable */ }
}
