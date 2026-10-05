'use client';

import { useCallback, useEffect, useState } from 'react';
import { Cable, Check, ExternalLink, Loader2, RefreshCw, Terminal } from 'lucide-react';
import type { Project } from '../../types';
import { fetchEnvStatus, installTool, type ToolStatus } from '../../lib/api';
import { useT } from '../../lib/i18n';

/** External tools. Tabby opens embedded in the "Tabby" tab (see TabbyView / main/tabby.ts). */
export function ConnectorsView({ project, onOpenTabby }: { project: Project | null; onOpenTabby: () => void }) {
  const { t } = useT();
  const [tabby, setTabby] = useState<ToolStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [log, setLog] = useState('');

  const refresh = useCallback(async () => {
    const tools = await fetchEnvStatus();
    setTabby(tools.find((tool) => tool.id === 'tabby') ?? null);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const install = async () => {
    setBusy(true); setError(''); setLog('');
    try {
      const code = await installTool('tabby', (line) => setLog((old) => `${old}${old ? '\n' : ''}${line}`));
      if (code !== 0) throw new Error(`Tabby installer exited with code ${code}`);
      setLog((old) => `${old}${old ? '\n' : ''}${t('conn.installDone')}`);
      await refresh();
    } catch (exc) { setError(exc instanceof Error ? exc.message : String(exc)); }
    finally { setBusy(false); }
  };

  const open = () => onOpenTabby();

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="mb-1 flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]"><Cable size={18} className="text-[var(--accent)]" />{t('conn.title')}</h1>
            <p className="text-xs text-[var(--text-muted)]">{t('conn.subtitle')}</p>
          </div>
          <button type="button" onClick={() => void refresh()} title={t('conn.refresh')} className="rounded-lg border border-[var(--border-color)] p-2 text-[var(--text-secondary)] hover:text-[var(--accent)]"><RefreshCw size={14} /></button>
        </div>

        <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--bg-tertiary)] text-[var(--accent)]"><Terminal size={20} /></span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t('conn.tabby')}</h2>
                <span className={`rounded-full px-2 py-0.5 text-[10px] ${tabby?.installed ? 'bg-[var(--success,#10b981)]/15 text-[var(--success,#10b981)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'}`}>
                  {tabby?.installed ? t('conn.installed') : t('conn.missing')}
                </span>
                {tabby?.version && <span className="text-[10px] text-[var(--text-muted)]">{tabby.version}</span>}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">{t('conn.tabby.desc')}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {!tabby?.installed && <button type="button" disabled={busy} onClick={() => void install()} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-medium text-[var(--on-accent)] disabled:opacity-50">{busy ? <Loader2 size={13} className="animate-spin" /> : <Terminal size={13} />}{busy ? t('conn.installing') : t('conn.install')}</button>}
                {tabby?.installed && <button type="button" disabled={busy} onClick={open} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-medium text-[var(--on-accent)] disabled:opacity-50">{busy ? <Loader2 size={13} className="animate-spin" /> : <ExternalLink size={13} />}{t('conn.open')}</button>}
                {tabby?.installed && <span className="inline-flex items-center gap-1 text-[11px] text-[var(--success,#10b981)]"><Check size={13} />{t('conn.ready')}</span>}
              </div>
              {!project && tabby?.installed && <p className="mt-2 text-[11px] text-[var(--text-muted)]">{t('conn.noProject')}</p>}
            </div>
          </div>
          {error && <p role="alert" className="mt-3 whitespace-pre-wrap rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/10 px-3 py-2 text-xs text-[var(--error)]">{error}</p>}
          {log && <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--bg-primary)] p-3 text-[11px] text-[var(--text-muted)]">{log}</pre>}
        </section>
      </div>
    </div>
  );
}
