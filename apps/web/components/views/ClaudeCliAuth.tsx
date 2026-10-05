'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Gauge, Loader2, LogIn, XCircle } from 'lucide-react';
import { API_BASE } from '../../lib/api';
import { useT } from '../../lib/i18n';

export type SubKind = 'claude' | 'codex';

interface Window { usedPercent: number; windowMins: number | null; resetsAt: number | null }
export interface SubStatus {
  installed: boolean;
  loggedIn: boolean;
  plan?: string;
  /** Codex: from the account. */
  limits?: { primary: Window | null; secondary: Window | null; reached: boolean } | ClaudeLimits | null;
}
interface ClaudeLimits { status: string; type?: string; resetsAt: number | null; utilization: number | null; at: number }

const base = (kind: SubKind) => `${API_BASE}/api/${kind === 'claude' ? 'claude-cli' : 'codex-cli'}`;

export async function fetchSubStatus(kind: SubKind): Promise<SubStatus | null> {
  try {
    const res = await fetch(`${base(kind)}/status`);
    return res.ok ? ((await res.json()) as SubStatus) : null;
  } catch {
    return null;
  }
}

const isCodexLimits = (l: SubStatus['limits']): l is { primary: Window | null; secondary: Window | null; reached: boolean } => Boolean(l && 'primary' in l);

/** "used 12% of 5 h · resets 14:20" style lines for the limits we know. */
export function limitLines(s: SubStatus | null, t: (k: string, v?: Record<string, string | number>) => string): Array<{ text: string; warn: boolean }> {
  const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  const span = (mins: number | null) => (!mins ? '' : mins >= 1440 ? t('lim.days', { n: Math.round(mins / 1440) }) : t('lim.hours', { n: Math.round(mins / 60) }));
  if (!s?.limits) return [];
  if (isCodexLimits(s.limits)) {
    return [s.limits.primary, s.limits.secondary].filter((w): w is Window => Boolean(w)).map((w) => ({
      text: t('lim.used', { p: Math.round(w.usedPercent), span: span(w.windowMins), at: when(w.resetsAt) }),
      warn: s.limits && isCodexLimits(s.limits) ? s.limits.reached || w.usedPercent >= 90 : false,
    }));
  }
  const c = s.limits as ClaudeLimits;
  const pct = c.utilization !== null ? Math.round(c.utilization <= 1 ? c.utilization * 100 : c.utilization) : null;
  return [{
    text: pct !== null ? t('lim.used', { p: pct, span: c.type ? c.type.replace(/_/g, ' ') : '', at: when(c.resetsAt) }) : t('lim.status', { s: c.status, at: when(c.resetsAt) }),
    warn: c.status !== 'allowed' || (pct ?? 0) >= 90,
  }];
}

/**
 * Sign-in state of a subscription CLI (Claude Code or Codex), its limits, and a "Sign in" button that opens the
 * CLI's own browser sign-in. While waiting, the state is re-checked every few seconds.
 * `autoLogin`: start signing in right away when the CLI is not signed in (used when the switch is turned on).
 */
export function SubscriptionAuth({ kind, autoLogin = false, compact = false }: { kind: SubKind; autoLogin?: boolean; compact?: boolean }) {
  const { t } = useT();
  const [status, setStatus] = useState<SubStatus | null>(null);
  const [waiting, setWaiting] = useState(false);
  const autoDone = useRef(false);

  const login = useCallback(async () => {
    setWaiting(true);
    try { await fetch(`${base(kind)}/login`, { method: 'POST' }); } catch { setWaiting(false); }
  }, [kind]);

  useEffect(() => {
    let alive = true;
    void fetchSubStatus(kind).then((s) => {
      if (!alive) return;
      setStatus(s);
      if (autoLogin && s?.installed && !s.loggedIn && !autoDone.current) { autoDone.current = true; void login(); }
    });
    return () => { alive = false; };
  }, [kind, autoLogin, login]);

  useEffect(() => {
    if (!waiting) return;
    const id = window.setInterval(() => {
      void fetchSubStatus(kind).then((s) => {
        setStatus(s);
        if (s?.loggedIn) { setWaiting(false); window.dispatchEvent(new Event('otto:subscription-auth')); }
      });
    }, 3000);
    const stop = window.setTimeout(() => setWaiting(false), 5 * 60 * 1000);
    return () => { window.clearInterval(id); window.clearTimeout(stop); };
  }, [waiting, kind]);

  const name = kind === 'claude' ? 'Claude' : 'Codex';
  if (!status) return compact ? null : <div className="mt-2 text-xs text-[var(--text-muted)]"><Loader2 size={12} className="mr-1 inline animate-spin" />{t('cc.checking')}</div>;
  if (!status.installed) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--error)]">
        <XCircle size={13} /> {t(kind === 'claude' ? 'cc.notInstalled' : 'cx.notInstalled')}{' '}
        <a href={kind === 'claude' ? 'https://claude.ai/code' : 'https://openai.com/codex'} target="_blank" rel="noreferrer" className="text-[var(--accent)] underline">{kind === 'claude' ? 'claude.ai/code' : 'openai.com/codex'}</a>
      </div>
    );
  }
  if (status.loggedIn) {
    const lines = limitLines(status, t);
    return (
      <div className="mt-2 space-y-1 text-xs">
        <div className="flex items-center gap-1.5 text-[var(--success,#10b981)]"><CheckCircle2 size={13} /> {t('sub.loggedIn', { name })}{status.plan ? <span className="text-[var(--text-muted)]"> · {t('sub.plan', { plan: status.plan })}</span> : null}</div>
        {lines.length > 0
          ? lines.map((l, i) => <div key={i} className={`flex items-center gap-1.5 ${l.warn ? 'text-[var(--warning)]' : 'text-[var(--text-secondary)]'}`}><Gauge size={12} /> {l.text}</div>)
          : <div className="flex items-center gap-1.5 text-[var(--text-muted)]"><Gauge size={12} /> {t('lim.later')}</div>}
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => void login()} disabled={waiting}
        className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--on-accent)] disabled:opacity-60">
        {waiting ? <Loader2 size={12} className="animate-spin" /> : <LogIn size={12} />} {t('sub.login', { name })}
      </button>
      <span className="text-[11px] text-[var(--text-muted)]">{waiting ? t('cc.waiting') : t(kind === 'claude' ? 'cc.notLoggedIn' : 'cx.notLoggedIn')}</span>
    </div>
  );
}

/** Kept for the existing call sites. */
export function ClaudeCliAuth(props: { autoLogin?: boolean; compact?: boolean }) {
  return <SubscriptionAuth kind="claude" {...props} />;
}

/** Next to the composer when a subscription model is chosen: how much of the plan's limit is used. */
export function SubscriptionLimitsBadge({ model }: { model: string | null }) {
  const { t } = useT();
  const kind: SubKind | null = model?.startsWith('claude-cli/') ? 'claude' : model?.startsWith('codex-cli/') ? 'codex' : null;
  const [status, setStatus] = useState<SubStatus | null>(null);
  useEffect(() => {
    if (!kind) { setStatus(null); return; }
    let alive = true;
    const load = () => void fetchSubStatus(kind).then((s) => { if (alive) setStatus(s); });
    load();
    const id = window.setInterval(load, 60_000);
    const onAuth = () => load();
    window.addEventListener('otto:subscription-auth', onAuth);
    return () => { alive = false; window.clearInterval(id); window.removeEventListener('otto:subscription-auth', onAuth); };
  }, [kind, model]);
  if (!kind || !status) return null;
  if (!status.loggedIn) return <span className="text-[10px] text-[var(--warning)]">{t('sub.notSignedShort', { name: kind === 'claude' ? 'Claude' : 'Codex' })}</span>;
  const lines = limitLines(status, t);
  if (!lines.length) return null;
  const warn = lines.some((l) => l.warn);
  return (
    <span title={lines.map((l) => l.text).join('\n')} className={`hidden items-center gap-1 text-[10px] lg:inline-flex ${warn ? 'text-[var(--warning)]' : 'text-[var(--text-muted)]'}`}>
      <Gauge size={11} /> {lines[0].text}
    </span>
  );
}
