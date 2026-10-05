'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Circle, Loader2, Rocket, SkipForward, X, AlertTriangle } from 'lucide-react';
import { fetchEnvStatus, fetchSetup, finishSetup, installTool } from '../../lib/api';
import { LOCALES, useT, type Locale } from '../../lib/i18n';
import { THEMES, setTheme, type ThemeId } from '../../lib/theme';

type RowState = 'queued' | 'installing' | 'done' | 'skipped' | 'failed';
interface Row { id: string; name: string; state: RowState; line: string }

/**
 * Applies the choices made in the installer wizard (`setup.json`): UI language
 * and color scheme right away, then installs the selected tools one by one
 * with live progress. The server marks the setup as applied when everything
 * has run, so it never repeats.
 */
export function FirstRunSetup() {
  const { t, setLocale } = useT();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [finished, setFinished] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const patch = (id: string, change: Partial<Row>) =>
      setRows((prev) => (prev ? prev.map((r) => (r.id === id ? { ...r, ...change } : r)) : prev));

    void (async () => {
      const setup = await fetchSetup();
      if (!setup) return;
      if (LOCALES.some((l) => l.id === setup.locale)) setLocale(setup.locale as Locale);
      if (THEMES.some((th) => th.id === setup.theme)) setTheme(setup.theme as ThemeId);
      if (setup.tools.length === 0) {
        await finishSetup();
        return;
      }

      const status = new Map((await fetchEnvStatus()).map((s) => [s.id, s]));
      const list: Row[] = setup.tools.map((id) => ({
        id,
        name: status.get(id)?.name ?? id,
        state: status.get(id)?.installed ? 'skipped' : 'queued',
        line: '',
      }));
      setRows(list);

      for (const item of list) {
        if (item.state === 'skipped') continue;
        patch(item.id, { state: 'installing' });
        try {
          const code = await installTool(item.id, (line) => patch(item.id, { line: line.slice(0, 120) }));
          patch(item.id, { state: code === 0 ? 'done' : 'failed' });
        } catch {
          patch(item.id, { state: 'failed' });
        }
      }
      setFinished(true);
      await finishSetup();
    })();
  }, [setLocale]);

  if (!rows || hidden) return null;

  const icon = (state: RowState) => {
    if (state === 'installing') return <Loader2 size={15} className="animate-spin text-[var(--accent)]" />;
    if (state === 'done') return <Check size={15} className="text-[var(--success)]" />;
    if (state === 'skipped') return <SkipForward size={14} className="text-[var(--text-muted)]" />;
    if (state === 'failed') return <AlertTriangle size={15} className="text-[var(--error)]" />;
    return <Circle size={14} className="text-[var(--text-muted)]" />;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="glass glow w-[420px] max-w-[92vw] rounded-xl p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
              <Rocket size={15} className="text-[var(--accent)]" /> {t('setup.title')}
            </h3>
            <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{t('setup.subtitle')}</p>
          </div>
          <button onClick={() => setHidden(true)} title={t('common.close')} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            <X size={15} />
          </button>
        </div>

        <ul className="mt-3 space-y-1.5">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-2.5 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2">
              {icon(r.state)}
              <div className="min-w-0 flex-1">
                <div className="text-sm text-[var(--text-primary)]">{r.name}</div>
                {r.state === 'installing' && r.line && (
                  <div className="truncate font-mono text-[10px] text-[var(--text-muted)]">{r.line}</div>
                )}
              </div>
              <span className="text-[10px] text-[var(--text-muted)]">{t(`setup.state.${r.state}`)}</span>
            </li>
          ))}
        </ul>

        <p className="mt-3 text-[10px] text-[var(--text-muted)]">{t('setup.hint')}</p>
        <div className="mt-3 flex justify-end">
          <button
            onClick={() => setHidden(true)}
            className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-semibold text-[var(--on-accent)] hover:bg-[var(--accent-hover)] transition-colors"
          >
            {finished ? t('setup.ready') : t('setup.background')}
          </button>
        </div>
      </div>
    </div>
  );
}
