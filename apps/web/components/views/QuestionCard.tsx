'use client';

import { useState } from 'react';
import { Check, HelpCircle, Loader2, SkipForward } from 'lucide-react';
import { API_BASE } from '../../lib/api';
import { useT } from '../../lib/i18n';
import type { ChatMessage } from '../../types';

/** ask_user: the model offers a few options; a click sends the choice back and the agent continues. */
export function QuestionCard({ msg }: { msg: ChatMessage }) {
  const { t } = useT();
  const [sending, setSending] = useState<string | null>(null);
  const [own, setOwn] = useState('');
  const status = msg.status ?? 'pending';
  const send = async (answer: string | null) => {
    setSending(answer ?? '');
    try {
      await fetch(`${API_BASE}/api/agent/choice`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: msg.questionId, answer }) });
    } finally { setSending(null); }
  };
  const busy = sending !== null;
  return (
    <div className={`max-w-3xl rounded-xl border p-3 ${status === 'pending' ? 'border-[var(--accent)]/50 bg-[var(--accent-glow)]' : 'border-[var(--border-color)] bg-[var(--bg-secondary)]'}`}>
      <div className="mb-2 flex items-start gap-2 text-sm font-medium text-[var(--text-primary)]">
        <HelpCircle size={15} className="mt-0.5 shrink-0 text-[var(--accent)]" />
        <span>{msg.question ?? msg.content}</span>
      </div>
      {status === 'pending' ? (
        <>
          <div className="flex flex-wrap gap-2">
            {(msg.options ?? []).map((o) => (
              <button key={o} type="button" disabled={busy} onClick={() => void send(o)} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--accent)]/40 bg-[var(--bg-primary)] px-3 py-1.5 text-left text-xs text-[var(--text-primary)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50">
                {sending === o && <Loader2 size={12} className="animate-spin" />}{o}
              </button>
            ))}
          </div>
          <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (own.trim()) void send(own.trim()); }}>
            <input value={own} onChange={(e) => setOwn(e.target.value)} disabled={busy} placeholder={t('ask.own')} className="min-w-0 flex-1 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
            <button type="button" disabled={busy} onClick={() => void send(null)} className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-color)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--accent)] disabled:opacity-50"><SkipForward size={12} />{t('ask.skip')}</button>
          </form>
        </>
      ) : (
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
          <Check size={12} className="text-[var(--accent)]" />
          {status === 'answered' ? <>{t('ask.chosen')} <span className="font-medium text-[var(--text-primary)]">{msg.answer}</span></> : t('ask.skipped')}
        </div>
      )}
    </div>
  );
}
