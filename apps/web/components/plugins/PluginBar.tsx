'use client';

import { useEffect, useRef, useState } from 'react';
import { BellRing, KeyRound } from 'lucide-react';
import { useT } from '../../lib/i18n';
import { usePlugins, type PluginId } from '../../lib/plugins';
import { DAY_MS, alertas, loadAlertas, notify, playSound, useAlertas } from '../../lib/alertasStore';
import { AlertasPanel, formatLeft } from './AlertasPanel';
import { CovertyPanel } from './CovertyPanel';

/**
 * Runs in the background whenever the alertas plugin is on (even with the panel closed): fires due
 * reminders and the timer with a desktop notification and a sound.
 */
export function PluginRuntime() {
  const { t } = useT();
  const { enabled } = usePlugins();
  const on = enabled.alertas;
  useEffect(() => { if (on) void loadAlertas(); }, [on]);
  useEffect(() => {
    if (!on) return;
    const tick = () => {
      const s = alertas.getState();
      if (!s.loaded) return;
      const now = Date.now();
      const due = s.reminders.filter((r) => !r.done && !r.fired && r.when <= now);
      if (due.length) {
        alertas.markFired(due.map((r) => r.id));
        // reminders that were missed while the app was closed for more than a day are marked silently
        for (const r of due.filter((x) => now - x.when < DAY_MS)) { notify(`🔔 ${r.title}`, r.notes || t('al.itsTime')); playSound('reminder'); }
      }
      if (s.timer?.running && s.timer.endsAt <= now) {
        alertas.stopTimer();
        notify(`⏱ ${t('al.timerDone')}`, s.timer.label);
        playSound('timer');
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [on, t]);
  return null;
}

const META: Record<PluginId, { icon: typeof KeyRound; titleKey: string }> = {
  coverty: { icon: KeyRound, titleKey: 'pl.coverty' },
  alertas: { icon: BellRing, titleKey: 'pl.alertas' },
};

/** Right side of the header: one icon per enabled plugin; a click opens its panel. The alertas icon shows the running timer. */
export function PluginBar() {
  const { t } = useT();
  const { enabled } = usePlugins();
  const [open, setOpen] = useState<PluginId | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const { timer } = useAlertas();
  const [now, setNow] = useState(() => Date.now());
  const timerRunning = Boolean(enabled.alertas && timer?.running);
  useEffect(() => {
    if (!timerRunning) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [timerRunning]);
  useEffect(() => { if (enabled.alertas) void loadAlertas(); }, [enabled.alertas]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  // a plugin switched off while its panel is open closes it
  useEffect(() => { if (open && !enabled[open]) setOpen(null); }, [enabled, open]);

  const active = (Object.keys(META) as PluginId[]).filter((id) => enabled[id]);
  if (active.length === 0) return null;
  return (
    <div className="relative flex items-center gap-1.5" ref={ref}>
      {active.map((id) => {
        const Icon = META[id].icon;
        const showTimer = id === 'alertas' && timerRunning && timer;
        return (
          <button key={id} onClick={() => setOpen((cur) => (cur === id ? null : id))} title={t(META[id].titleKey)} aria-label={t(META[id].titleKey)}
            className={`flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs transition-colors ${open === id ? 'border-[var(--accent)]/40 bg-[var(--accent-glow)] text-[var(--accent)]' : 'border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--accent)]'}`}>
            <Icon size={14} />
            {showTimer && <span className="font-mono tabular-nums text-[var(--accent)]">{formatLeft(timer.endsAt - now)}</span>}
          </button>
        );
      })}
      {/* the plugins bring their own look (the original extension UIs); Esc or a click outside closes them */}
      {open === 'coverty' && (
        <div className="absolute right-0 top-full z-50 mt-2 rounded-[14px] shadow-2xl ring-1 ring-black/40">
          <CovertyPanel />
        </div>
      )}
      {open === 'alertas' && (
        <div className="absolute right-0 top-full z-50 mt-2 h-[min(760px,85vh)] w-[min(1060px,94vw)] rounded-[14px] shadow-2xl ring-1 ring-black/40">
          <AlertasPanel />
        </div>
      )}
    </div>
  );
}
