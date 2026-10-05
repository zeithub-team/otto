'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { GitBranch, ChevronDown, Plus, Check, Loader2 } from 'lucide-react';
import { fetchBranches, checkoutBranch, type BranchInfo } from '../../lib/api';
import { useT } from '../../lib/i18n';

/** Branch switcher for the selected project (hidden when it is not a git repo). */
export function BranchMenu({ projectId }: { projectId?: number }) {
  const { t } = useT();
  const [info, setInfo] = useState<BranchInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!projectId) { setInfo(null); return; }
    try { setInfo(await fetchBranches(projectId)); } catch { setInfo(null); }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setCreating(false); } };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!projectId || !info || !info.isRepo) return null;

  const switchTo = async (branch: string, create: boolean) => {
    if (!projectId || busy) return;
    setBusy(true);
    try {
      const next = await checkoutBranch(projectId, branch, create);
      setInfo(next);
      setOpen(false); setCreating(false); setNewName('');
    } catch { /* keep menu open on error */ }
    finally { setBusy(false); }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm border transition-colors ${
          open ? 'border-[var(--accent)]/40 bg-[var(--accent-glow)] text-[var(--accent)]' : 'border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:border-[var(--accent)]/40'
        }`}
        title={t('br.title')}
      >
        <GitBranch size={13} className="shrink-0" />
        <span className="max-w-[140px] truncate">{info.current ?? 'detached'}</span>
        <ChevronDown size={12} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 w-56 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-xl overflow-hidden z-50">
          <div className="px-3 py-2 border-b border-[var(--border-color)] text-[10px] uppercase tracking-wider text-[var(--text-muted)] flex items-center justify-between">
            {t('br.branches')} {busy && <Loader2 size={12} className="animate-spin" />}
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {info.branches.map((b) => (
              <button key={b} onClick={() => void switchTo(b, false)} className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm ${b === info.current ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
                <GitBranch size={12} className="shrink-0" />
                <span className="flex-1 truncate text-left">{b}</span>
                {b === info.current && <Check size={13} className="shrink-0" />}
              </button>
            ))}
          </div>
          <div className="border-t border-[var(--border-color)] p-1">
            {creating ? (
              <div className="flex items-center gap-1 p-1">
                <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) void switchTo(newName.trim().replace(/\s+/g, '-'), true); }} placeholder={t('br.name')} autoFocus className="flex-1 min-w-0 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-xs" />
                <button onClick={() => newName.trim() && void switchTo(newName.trim().replace(/\s+/g, '-'), true)} disabled={!newName.trim()} className="px-2 py-1 rounded-md bg-[var(--accent-glow)] text-[var(--accent)] text-xs disabled:opacity-40">OK</button>
              </div>
            ) : (
              <button onClick={() => setCreating(true)} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Plus size={13} /> {t('br.new')}</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
