'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Loader2, Sparkles, Wand2 } from 'lucide-react';
import { fetchEnvFileStatus, syncProjectEnv, type EnvFileStatus } from '../../lib/api';
import { describeServices, readStoredInstances } from '../../lib/servicesStore';
import { useT } from '../../lib/i18n';

/**
 * Explorer button for the project's `.env`: shows whether it exists, creates it from `.env.example`
 * with the values of the project's services, or asks the AI agent to create it.
 */
export function EnvButton({ projectId, onOpen }: { projectId: number; onOpen: (path: string) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<EnvFileStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const load = useCallback(async () => setStatus(await fetchEnvFileStatus(projectId)), [projectId]);
  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener('otto:files-changed', refresh);
    return () => window.removeEventListener('otto:files-changed', refresh);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const needsAttention = status !== null && (!status.hasEnv || status.missing.length > 0);

  const fromExample = async () => {
    setBusy(true);
    setMsg('');
    try {
      const result = await syncProjectEnv(projectId, readStoredInstances(projectId), 'always');
      setMsg(result.created ? t('env.created') : result.changed.length ? t('env.updated', { n: result.changed.length }) : t('env.upToDate'));
      window.dispatchEvent(new CustomEvent('otto:files-changed', { detail: { projectId } }));
      await load();
      onOpen(result.path);
    } catch (exc) {
      setMsg(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  };

  const askAi = () => {
    const services = describeServices(readStoredInstances(projectId)) || t('env.noServices');
    window.dispatchEvent(new CustomEvent('otto:ask-ai', { detail: { prompt: t('env.aiPrompt', { example: status?.example ?? '—', services }) } }));
    setOpen(false);
  };

  const line = status === null ? '' : !status.hasEnv ? t('env.statusNone') : status.missing.length ? t('env.statusMissing', { n: status.missing.length }) : t('env.statusOk');

  return (
    <div className="relative" ref={box}>
      <button
        ref={btnRef}
        onClick={() => {
          const r = btnRef.current?.getBoundingClientRect();
          if (r) setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(window.innerWidth - 296, r.left)) });
          setOpen((o) => !o); setMsg(''); void load();
        }}
        className={`relative rounded p-1 hover:bg-[var(--bg-hover)] ${open ? 'text-[var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
        title={t('env.button')}
        aria-label={t('env.button')}
      >
        <KeyRound size={13} />
        {needsAttention && <span className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-[var(--warning)]" />}
      </button>
      {open && (
        // fixed: the explorer clips overflowing children, and the panel is wider than the explorer
        <div className="fixed z-50 w-72 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 shadow-2xl" style={{ top: pos.top, left: pos.left }}>
          <div className="mb-2 text-xs font-semibold text-[var(--text-primary)]">.env</div>
          {line && <p className={`mb-3 text-[11px] ${needsAttention ? 'text-[var(--warning)]' : 'text-[var(--success)]'}`}>{line}{status?.example ? ` · ${status.example}` : ''}</p>}
          <button
            onClick={() => void fromExample()}
            disabled={busy}
            className="mb-2 flex w-full items-start gap-2 rounded-lg border border-[var(--border-color)] px-2.5 py-2 text-left hover:border-[var(--accent)] disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-[var(--accent)]" /> : <Wand2 size={14} className="mt-0.5 shrink-0 text-[var(--accent)]" />}
            <span><span className="block text-xs text-[var(--text-primary)]">{t('env.fromExample')}</span><span className="block text-[10px] text-[var(--text-muted)]">{t('env.fromExampleHint')}</span></span>
          </button>
          <button
            onClick={askAi}
            className="flex w-full items-start gap-2 rounded-lg border border-[var(--border-color)] px-2.5 py-2 text-left hover:border-[var(--accent)]"
          >
            <Sparkles size={14} className="mt-0.5 shrink-0 text-[var(--accent)]" />
            <span><span className="block text-xs text-[var(--text-primary)]">{t('env.askAi')}</span><span className="block text-[10px] text-[var(--text-muted)]">{t('env.askAiHint')}</span></span>
          </button>
          {msg && <p className="mt-2 text-[11px] text-[var(--text-secondary)]">{msg}</p>}
        </div>
      )}
    </div>
  );
}
