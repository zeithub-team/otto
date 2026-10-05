'use client';

import { useCallback, useEffect, useState } from 'react';
import { Cable, Check, ExternalLink, KeyRound, Loader2, Plug, RefreshCw, Terminal, Trash2, TriangleAlert } from 'lucide-react';
import type { Project } from '../../types';
import { fetchConnectors, fetchEnvStatus, installTool, removeConnector, saveConnector, testConnector, type ConnectorInfo, type ToolStatus } from '../../lib/api';
import { useT } from '../../lib/i18n';

const GROUPS: Array<ConnectorInfo['group']> = ['design', 'tasks', 'docs', 'dev', 'custom'];

/** Outside services for the models (MCP, by access token) and external tools (Tabby). */
export function ConnectorsView({ project, onOpenTabby }: { project: Project | null; onOpenTabby: () => void }) {
  const { t } = useT();
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(async () => setConnectors(await fetchConnectors()), []);
  useEffect(() => { void refresh(); }, [refresh]);

  const connected = connectors.filter((c) => c.connected).length;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="mb-1 flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]"><Cable size={18} className="text-[var(--accent)]" />{t('conn.title')}</h1>
            <p className="text-xs text-[var(--text-muted)]">{t('conn.subtitle2')}</p>
          </div>
          <button type="button" onClick={() => void refresh()} title={t('conn.refresh')} className="rounded-lg border border-[var(--border-color)] p-2 text-[var(--text-secondary)] hover:text-[var(--accent)]"><RefreshCw size={14} /></button>
        </div>

        <p className="mb-5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-xs leading-relaxed text-[var(--text-secondary)]">
          {t('conn.how')} {connected > 0 && <span className="text-[var(--accent)]">{t('conn.connectedCount').replace('{n}', String(connected))}</span>}
        </p>

        {GROUPS.map((g) => {
          const items = connectors.filter((c) => c.group === g);
          if (!items.length) return null;
          return (
            <section key={g} className="mb-6">
              <h2 className="mb-2 text-xs uppercase tracking-wider text-[var(--text-muted)]">{t(`conn.group.${g}`)}</h2>
              <div className="grid items-start gap-3 sm:grid-cols-2">
                {items.map((c) => (
                  <ConnectorCard key={c.id} c={c} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} onChanged={(next) => setConnectors((all) => all.map((x) => (x.id === next.id ? next : x)))} onRefresh={refresh} />
                ))}
              </div>
            </section>
          );
        })}

        <h2 className="mb-2 text-xs uppercase tracking-wider text-[var(--text-muted)]">{t('conn.group.tools')}</h2>
        <TabbyCard project={project} onOpenTabby={onOpenTabby} />
      </div>
    </div>
  );
}

function ConnectorCard({ c, open, onToggle, onChanged, onRefresh }: { c: ConnectorInfo; open: boolean; onToggle: () => void; onChanged: (c: ConnectorInfo) => void; onRefresh: () => Promise<void> }) {
  const { t } = useT();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'' | 'save' | 'test' | 'remove'>('');
  const [error, setError] = useState('');

  useEffect(() => { if (open) setValues(Object.fromEntries(c.fields.filter((f) => !f.secret).map((f) => [f.key, f.value ?? '']))); }, [open, c.fields]);

  const run = async (kind: 'save' | 'test' | 'remove') => {
    setBusy(kind); setError('');
    try {
      if (kind === 'save') onChanged(await saveConnector(c.id, values));
      else if (kind === 'test') { const r = await testConnector(c.id); if (r.error) setError(r.error); await onRefresh(); }
      else { await removeConnector(c.id); await onRefresh(); onToggle(); }
    } catch (exc) { setError(exc instanceof Error ? exc.message : String(exc)); }
    finally { setBusy(''); }
  };

  const shownError = error || (c.connected ? c.error : '');
  return (
    <div className={`rounded-xl border bg-[var(--bg-secondary)] p-3 ${c.connected && !c.error ? 'border-[var(--accent)]/40' : 'border-[var(--border-color)]'}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-3 text-left">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--bg-tertiary)] text-sm font-semibold text-[var(--accent)]">{c.group === 'custom' ? <Plug size={16} /> : c.name.slice(0, 1)}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-[var(--text-primary)]">{c.name}</span>
            {c.connected && !c.error && <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)]/15 px-2 py-0.5 text-[10px] text-[var(--accent)]"><Check size={10} />{t('conn.on')} · {t('conn.tools').replace('{n}', String(c.tools))}</span>}
            {c.connected && c.error && <span className="inline-flex items-center gap-1 rounded-full bg-[var(--error)]/15 px-2 py-0.5 text-[10px] text-[var(--error)]"><TriangleAlert size={10} />{t('conn.failed')}</span>}
          </span>
          <span className="mt-0.5 block text-xs leading-snug text-[var(--text-muted)]">{c.description}</span>
        </span>
      </button>

      {open && (
        <div className="mt-3 space-y-2 border-t border-[var(--border-color)] pt-3">
          <a href={c.tokenUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline"><KeyRound size={12} />{c.group === 'custom' ? t('conn.findServers') : t('conn.getToken')}<ExternalLink size={11} /></a>
          {c.fields.map((f) => (
            <label key={f.key} className="block">
              <span className="mb-0.5 block text-[11px] text-[var(--text-secondary)]">{f.label}{f.optional ? ` (${t('conn.optional')})` : ''}</span>
              <input
                type={f.secret ? 'password' : 'text'}
                value={values[f.key] ?? ''}
                placeholder={f.secret && f.set ? t('conn.keepSecret') : f.placeholder ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </label>
          ))}
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" disabled={Boolean(busy)} onClick={() => void run('save')} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--on-accent)] disabled:opacity-50">
              {busy === 'save' ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}{busy === 'save' ? t('conn.connecting') : c.connected ? t('conn.save') : t('conn.connect')}
            </button>
            {c.connected && <button type="button" disabled={Boolean(busy)} onClick={() => void run('test')} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-color)] px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--accent)] disabled:opacity-50">{busy === 'test' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}{t('conn.test')}</button>}
            {c.connected && <button type="button" disabled={Boolean(busy)} onClick={() => void run('remove')} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-color)] px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--error)] disabled:opacity-50"><Trash2 size={12} />{t('conn.disconnect')}</button>}
          </div>
          {busy === 'save' && <p className="text-[11px] text-[var(--text-muted)]">{t('conn.firstRun')}</p>}
          {shownError && <p role="alert" className="whitespace-pre-wrap rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/10 px-2.5 py-1.5 text-[11px] text-[var(--error)]">{shownError}</p>}
        </div>
      )}
    </div>
  );
}

/** Tabby: the external terminal app, embedded in Otto (see TabbyView / main/tabby.ts). */
function TabbyCard({ project, onOpenTabby }: { project: Project | null; onOpenTabby: () => void }) {
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

  return (
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
            {tabby?.installed && <button type="button" disabled={busy} onClick={onOpenTabby} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-medium text-[var(--on-accent)] disabled:opacity-50"><ExternalLink size={13} />{t('conn.open')}</button>}
            {tabby?.installed && <span className="inline-flex items-center gap-1 text-[11px] text-[var(--success,#10b981)]"><Check size={13} />{t('conn.ready')}</span>}
          </div>
          {!project && tabby?.installed && <p className="mt-2 text-[11px] text-[var(--text-muted)]">{t('conn.noProject')}</p>}
        </div>
      </div>
      {error && <p role="alert" className="mt-3 whitespace-pre-wrap rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/10 px-3 py-2 text-xs text-[var(--error)]">{error}</p>}
      {log && <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--bg-primary)] p-3 text-[11px] text-[var(--text-muted)]">{log}</pre>}
    </section>
  );
}
