'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, UserPlus, Trash2, Check, User, GitFork } from 'lucide-react';
import type { Account } from '../../types';
import { useConfirm } from '../ui/Confirm';
import { useT } from '../../lib/i18n';

interface AccountMenuProps {
  accounts: Account[];
  activeId: number;
  onSelect: (id: number) => void;
  onAddAccount: () => void;
  onCloneRepo: () => void;
  onDeleteAccount: (id: number) => void;
  /** Icon-only trigger: a person with a small arrow (top-right of the header). */
  compact?: boolean;
}

export function AccountMenu({ accounts, activeId, onSelect, onAddAccount, onCloneRepo, onDeleteAccount, compact }: AccountMenuProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  const active = accounts.find((a) => a.id === activeId) ?? accounts[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const avatar = (a: Account, size: number) => a.avatar_url
    ? <img src={a.avatar_url} alt="" width={size} height={size} className="rounded-full" />
    : <span className="grid place-items-center rounded-full bg-[var(--bg-active)] text-[var(--text-muted)]" style={{ width: size, height: size }}><User size={size - 8} /></span>;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={compact
          ? `flex h-8 items-center justify-center gap-0.5 rounded-lg px-1.5 transition-colors ${open ? 'bg-[var(--accent-glow)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`
          : `flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full border transition-colors ${
            open ? 'border-[var(--accent)]/40 bg-[var(--accent-glow)]' : 'border-[var(--border-color)] bg-[var(--bg-tertiary)] hover:border-[var(--accent)]/40'
          }`}
        title={t('acc.title')}
        aria-label={t('acc.title')}
      >
        {compact ? (
          <>
            <User size={16} />
            <ChevronDown size={11} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
          </>
        ) : (
          <>
            {avatar(active, 22)}
            <span className="text-[13px] text-[var(--text-secondary)] max-w-[120px] truncate">{active.provider === 'local' ? t('account.local') : active.username}</span>
            <ChevronDown size={13} className={`text-[var(--text-muted)] transition-transform ${open ? 'rotate-180' : ''}`} />
          </>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-64 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-xl overflow-hidden z-50">
          <div className="px-3 py-2 border-b border-[var(--border-color)] text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{t('account.accounts')}</div>
          <div className="max-h-64 overflow-y-auto py-1">
            {accounts.map((a) => (
              <div key={a.id} className={`group flex items-center gap-2 px-3 py-2 cursor-pointer text-sm ${a.id === activeId ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`} onClick={() => { onSelect(a.id); setOpen(false); }}>
                {avatar(a, 22)}
                <div className="flex-1 min-w-0">
                  <div className="truncate">{a.provider === 'local' ? t('account.local') : a.username}</div>
                  {a.id > 0 && <div className="text-[10px] text-[var(--text-muted)] truncate">{a.provider}</div>}
                </div>
                {a.id === activeId && <Check size={14} className="shrink-0" />}
                {a.id > 0 && a.id !== activeId && (
                  <button
                    onClick={async (e) => { e.stopPropagation(); if (await confirm({ title: t('acc.delTitle'), message: t('acc.delMsg', { name: a.username }), danger: true, confirmText: t('common.delete') })) onDeleteAccount(a.id); }}
                    className="opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-[var(--error)] shrink-0"
                    title={t('acc.delTitle')}
                  ><Trash2 size={13} /></button>
                )}
              </div>
            ))}
          </div>
          <div className="border-t border-[var(--border-color)] py-1">
            <button onClick={() => { setOpen(false); onAddAccount(); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><UserPlus size={14} /> {t('account.add')}</button>
            <button onClick={() => { setOpen(false); onCloneRepo(); }} disabled={activeId === 0} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-not-allowed"><GitFork size={14} /> {t('account.clone')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
