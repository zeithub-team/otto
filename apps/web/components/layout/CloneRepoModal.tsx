'use client';

import { useEffect, useState } from 'react';
import { X, GitFork, Loader2, Lock, Search } from 'lucide-react';
import type { Project, Repo } from '../../types';
import { fetchAccountRepos, cloneRepo } from '../../lib/api';
import { useT } from '../../lib/i18n';

interface CloneRepoModalProps {
  accountId: number;
  onClose: () => void;
  onCloned: (project: Project) => void;
}

export function CloneRepoModal({ accountId, onClose, onCloned }: CloneRepoModalProps) {
  const { t } = useT();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [cloning, setCloning] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchAccountRepos(accountId)
      .then((rows) => { if (!cancelled) { setRepos(rows); setLoading(false); } })
      .catch((exc) => { if (!cancelled) { setError(exc instanceof Error ? exc.message : t('common.error')); setLoading(false); } });
    return () => { cancelled = true; };
  }, [accountId, t]);

  const clone = async (repo: Repo) => {
    if (cloning) return;
    setCloning(repo.full_name); setLog([]); setError('');
    try {
      const project = await cloneRepo(accountId, repo.clone_url, repo.name, (line) => setLog((prev) => [...prev.slice(-100), line]));
      if (project) { onCloned(project); onClose(); }
      else setError(t('cl.noProject'));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : t('cl.failed'));
    } finally {
      setCloning(null);
    }
  };

  const filtered = repos.filter((r) => r.full_name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[82vh] flex flex-col rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
          <h3 className="text-sm font-semibold flex items-center gap-2"><GitFork size={15} className="text-[var(--accent)]" /> {t('cl.title')}</h3>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={16} /></button>
        </div>
        <div className="px-4 py-2 border-b border-[var(--border-color)]">
          <div className="flex items-center gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-1.5">
            <Search size={14} className="text-[var(--text-muted)]" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('cl.search')} className="flex-1 bg-transparent text-sm outline-none" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] p-4"><Loader2 size={15} className="animate-spin" /> {t('cl.loading')}</div>
          ) : error && !cloning ? (
            <div className="text-sm text-[var(--error)] p-4">{error}</div>
          ) : filtered.length === 0 ? (
            <div className="text-sm text-[var(--text-muted)] p-4">{t('cl.none')}</div>
          ) : filtered.map((repo) => (
            <button key={repo.full_name} onClick={() => void clone(repo)} disabled={!!cloning} className="w-full flex items-center gap-3 rounded-lg border border-[var(--border-color)] p-3 mb-1.5 text-left hover:border-[var(--accent)]/50 hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 text-sm"><span className="truncate">{repo.full_name}</span>{repo.private && <Lock size={11} className="text-[var(--text-muted)] shrink-0" />}</div>
                {repo.description && <div className="text-xs text-[var(--text-muted)] truncate">{repo.description}</div>}
              </div>
              {cloning === repo.full_name && <Loader2 size={15} className="animate-spin text-[var(--accent)] shrink-0" />}
            </button>
          ))}
        </div>
        {cloning && (
          <div className="border-t border-[var(--border-color)] p-2">
            <pre className="max-h-28 overflow-y-auto rounded bg-[var(--bg-primary)] p-2 text-[10px] font-mono text-[var(--text-muted)] whitespace-pre-wrap">{log.join('\n') || t('cl.cloning')}</pre>
            {error && <div className="text-xs text-[var(--error)] mt-1">{error}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
