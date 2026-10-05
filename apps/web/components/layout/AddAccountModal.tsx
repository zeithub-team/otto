'use client';

import { useState } from 'react';
import { X, UserPlus, Loader2, ExternalLink } from 'lucide-react';
import { useT } from '../../lib/i18n';

interface AddAccountModalProps {
  onClose: () => void;
  onAdd: (token: string, provider: string) => Promise<void>;
}

export function AddAccountModal({ onClose, onAdd }: AddAccountModalProps) {
  const { t } = useT();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!token.trim() || busy) return;
    setBusy(true); setError('');
    try {
      await onAdd(token.trim(), 'github');
      onClose();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : t('add.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
          <h3 className="text-sm font-semibold flex items-center gap-2"><UserPlus size={15} className="text-[var(--accent)]" /> {t('add.title')}</h3>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-xs text-[var(--text-secondary)]">
            {t('add.hint')}
          </p>
          <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-xs text-[var(--accent)] hover:underline">
            <ExternalLink size={12} /> {t('add.createToken')}
          </a>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            placeholder="ghp_…"
            autoFocus
            className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 py-2 text-sm font-mono outline-none focus:border-[var(--accent)]/50"
          />
          {error && <div className="text-xs text-[var(--error)]">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--border-color)]">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">{t('common.cancel')}</button>
          <button onClick={() => void submit()} disabled={!token.trim() || busy} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-[var(--accent)] text-[var(--on-accent)] font-medium disabled:opacity-40">
            {busy && <Loader2 size={14} className="animate-spin" />} {t('add.connect')}
          </button>
        </div>
      </div>
    </div>
  );
}
