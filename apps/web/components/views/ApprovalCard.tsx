'use client';

import { useState } from 'react';
import { Check, Loader2, Terminal, X } from 'lucide-react';
import { API_BASE } from '../../lib/api';
import { useT } from '../../lib/i18n';
import type { ChatMessage } from '../../types';

/** The agent wants to run a command: show it and wait for the user's "Run" / "Deny". */
export function ApprovalCard({ msg }: { msg: ChatMessage }) {
  const { t } = useT();
  const [sending, setSending] = useState(false);
  const status = msg.status ?? 'pending';
  const answer = async (allow: boolean) => {
    setSending(true);
    try {
      await fetch(`${API_BASE}/api/agent/approval`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: msg.approvalId, allow }) });
    } finally { setSending(false); }
  };
  return (
    <div className={`max-w-3xl rounded-xl border p-3 ${status === 'pending' ? 'border-[var(--warning)]/50 bg-[var(--warning)]/10' : 'border-[var(--border-color)] bg-[var(--bg-secondary)]'}`}>
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--text-primary)]">
        <Terminal size={14} className="text-[var(--accent)]" />
        {status === 'pending' ? t('appr.ask') : status === 'allowed' ? t('appr.allowed') : t('appr.denied')}
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--bg-primary)] px-3 py-2 font-mono text-xs text-[var(--text-primary)]">{msg.command}</pre>
      {msg.cwd && <div className="mt-1 truncate font-mono text-[10px] text-[var(--text-muted)]" title={msg.cwd}>{msg.cwd}</div>}
      {status === 'pending' && (
        <div className="mt-2.5 flex items-center gap-2">
          <button disabled={sending} onClick={() => void answer(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--on-accent)] disabled:opacity-50">
            {sending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} {t('appr.run')}
          </button>
          <button disabled={sending} onClick={() => void answer(false)} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-color)] px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:border-[var(--error)] hover:text-[var(--error)] disabled:opacity-50">
            <X size={12} /> {t('appr.deny')}
          </button>
          <span className="ml-1 text-[10px] text-[var(--text-muted)]">{t('appr.hint')}</span>
        </div>
      )}
    </div>
  );
}
