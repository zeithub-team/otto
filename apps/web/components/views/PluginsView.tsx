'use client';

import { BellRing, KeyRound, Puzzle } from 'lucide-react';
import { useT } from '../../lib/i18n';
import { usePlugins, type PluginId } from '../../lib/plugins';

const PLUGINS: Array<{ id: PluginId; icon: typeof KeyRound }> = [
  { id: 'coverty', icon: KeyRound },
  { id: 'alertas', icon: BellRing },
];

/** Plugins: switch each one on or off. An enabled plugin gets an icon on the right of the header. */
export function PluginsView() {
  const { t } = useT();
  const { enabled, toggle } = usePlugins();
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-6">
        <h1 className="mb-1 flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]"><Puzzle size={18} className="text-[var(--accent)]" /> {t('pl.title')}</h1>
        <p className="mb-5 text-xs text-[var(--text-muted)]">{t('pl.subtitle')}</p>
        <div className="space-y-3">
          {PLUGINS.map(({ id, icon: Icon }) => (
            <div key={id} className={`flex items-start gap-3 rounded-xl border p-4 ${enabled[id] ? 'border-[var(--accent)]/40 bg-[var(--accent-glow)]' : 'border-[var(--border-color)] bg-[var(--bg-secondary)]'}`}>
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--bg-tertiary)] text-[var(--accent)]"><Icon size={20} /></span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-[var(--text-primary)]">zeithub.{id}</div>
                <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{t(`pl.${id}.desc`)}</p>
                <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-[var(--text-muted)]">
                  {[1, 2, 3].map((n) => <li key={n}>{t(`pl.${id}.f${n}`)}</li>)}
                </ul>
              </div>
              <button role="switch" aria-checked={enabled[id]} onClick={() => toggle(id, !enabled[id])} title={t(enabled[id] ? 'pl.turnOff' : 'pl.turnOn')}
                className={`relative mt-1 h-6 w-11 shrink-0 rounded-full transition-colors ${enabled[id] ? 'bg-[var(--accent)]' : 'bg-[var(--bg-active)]'}`}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${enabled[id] ? 'left-[22px]' : 'left-0.5'}`} />
              </button>
            </div>
          ))}
        </div>
        <p className="mt-4 text-[11px] text-[var(--text-muted)]">{t('pl.where')}</p>
      </div>
    </div>
  );
}
