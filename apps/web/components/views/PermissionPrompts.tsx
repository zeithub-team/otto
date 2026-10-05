'use client';

import { useEffect, useState } from 'react';
import { Check, ShieldAlert, X } from 'lucide-react';
import { API_BASE } from '../../lib/api';
import { useT } from '../../lib/i18n';

type PermissionRequest = { id: string; kind: 'terminal' | 'ssh'; action: string; target?: string };

export function PermissionPrompts() {
  const { t } = useT();
  const [request, setRequest] = useState<PermissionRequest | null>(null);
  const [socket, setSocket] = useState<WebSocket | null>(null);
  useEffect(() => {
    const origin = (API_BASE || window.location.origin).replace(/^http/, 'ws');
    const ws = new WebSocket(`${origin}/api/permissions/ws`);
    setSocket(ws);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as { type?: string } & PermissionRequest;
        if (msg.type === 'request') setRequest(msg);
      } catch { /* ignore malformed server messages */ }
    };
    return () => { setSocket(null); ws.close(); };
  }, []);
  const answer = (allow: boolean) => {
    if (!request) return;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: request.id, allow }));
    setRequest(null);
  };
  if (!request) return null;
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/55 p-4" role="alertdialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-2xl border border-[var(--warning)]/50 bg-[var(--bg-secondary)] p-5 shadow-2xl">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]"><ShieldAlert size={17} className="text-[var(--warning)]" />{t('perm.title')}</h2>
        <p className="mb-3 text-xs text-[var(--text-muted)]">{request.kind === 'terminal' ? t('perm.terminal') : t('perm.ssh')}</p>
        <div className="rounded-lg bg-[var(--bg-primary)] p-3 font-mono text-xs text-[var(--text-primary)]">{request.action}{request.target ? `\n${request.target}` : ''}</div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => answer(false)} disabled={socket?.readyState !== WebSocket.OPEN} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-color)] px-3 py-2 text-xs text-[var(--text-secondary)] disabled:opacity-50"><X size={13} />{t('perm.deny')}</button>
          <button type="button" onClick={() => answer(true)} disabled={socket?.readyState !== WebSocket.OPEN} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-medium text-[var(--on-accent)] disabled:opacity-50"><Check size={13} />{t('perm.allow')}</button>
        </div>
      </div>
    </div>
  );
}
