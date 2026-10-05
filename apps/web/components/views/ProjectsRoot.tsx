'use client';

import { useEffect, useState } from 'react';
import { FolderCog, FolderOpen, Check } from 'lucide-react';
import { fetchProjectsRoot, saveProjectsRoot } from '../../lib/api';
import { FolderBrowser } from '../layout/FolderBrowser';
import { useT } from '../../lib/i18n';

/** Settings section: where new projects are created. */
export function ProjectsRoot() {
  const { t } = useT();
  const [current, setCurrent] = useState('');
  const [value, setValue] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetchProjectsRoot().then((r) => { setCurrent(r.path); setValue(r.path); }).catch(() => undefined);
  }, []);

  const save = async (folder: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const saved = await saveProjectsRoot(folder);
      setCurrent(saved.path);
      setValue(saved.path);
      setMsg({ ok: true, text: t('root.saved') });
    } catch (exc) {
      setMsg({ ok: false, text: exc instanceof Error ? exc.message : String(exc) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-8">
      <h2 className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-1 flex items-center gap-1.5">
        <FolderCog size={13} /> {t('root.title')}
      </h2>
      <p className="text-xs text-[var(--text-muted)] mb-3">{t('root.hint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && value.trim() && value !== current) void save(value.trim()); }}
          aria-label={t('root.title')}
          placeholder="C:\\Users\\you\\Projects"
          className="min-w-[260px] flex-1 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 py-2 font-mono text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
        <button
          onClick={() => setBrowsing((v) => !v)}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border-color)] px-3 text-xs text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text-primary)]"
        >
          <FolderOpen size={14} /> {t('root.browse')}
        </button>
        <button
          onClick={() => void save(value.trim())}
          disabled={busy || !value.trim() || value.trim() === current}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 text-xs font-semibold text-[var(--on-accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40"
        >
          <Check size={14} /> {t('common.save')}
        </button>
      </div>
      {browsing && (
        <div className="mt-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
          <FolderBrowser onSelect={(folder) => { setBrowsing(false); setValue(folder); void save(folder); }} onCancel={() => setBrowsing(false)} />
        </div>
      )}
      {msg && <p className={`mt-2 text-xs ${msg.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>{msg.text}</p>}
    </section>
  );
}
