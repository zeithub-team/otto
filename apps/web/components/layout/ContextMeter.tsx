'use client';

import { useEffect, useRef, useState } from 'react';
import { Gauge, Zap } from 'lucide-react';
import type { UsageInfo } from '../../hooks/useChat';
import { useT } from '../../lib/i18n';

// Windows are powers of two (32768 → "32k"), so 1024-based units read naturally.
const fmt = (n: number): string => (n >= 1024 ? `${(n / 1024).toFixed(n >= 10 * 1024 ? 0 : 1).replace(/\.0$/, '')}k` : String(n));

/** Context window fill + generation speed of the last model turn, styled like the option chips. */
export function ContextMeter({ usage }: { usage: UsageInfo | null }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  if (!usage || !usage.ctx) return null;
  const pct = Math.min(100, Math.round((usage.used / usage.ctx) * 100));
  const level = pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'ok';
  const color = level === 'high' ? 'var(--error, #ef4444)' : level === 'mid' ? 'var(--warning, #f59e0b)' : 'var(--accent, #10b981)';
  const title =
    `${t('meter.context')}: ${usage.estimated ? '~' : ''}${usage.used} / ${usage.ctx} (${pct}%)` +
    (usage.tps ? ` · ${usage.tps} t/s` : '') +
    (usage.compacted ? ` · ${t('meter.compacted', { n: usage.compacted })}` : '');

  return (
    <div className="relative" ref={box}>
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      className="flex items-center gap-2 h-[26px] px-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[11px] tabular-nums select-none hover:border-[var(--accent)]/40 transition-colors"
      style={level === 'ok' ? undefined : { borderColor: color }}
      title={title}
    >
      <Gauge size={12} className="text-[var(--text-muted)] shrink-0" />
      <span className="relative w-14 h-1.5 rounded-full bg-[var(--border-color)] overflow-hidden shrink-0">
        <span className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500" style={{ width: `${Math.max(pct, 3)}%`, background: color }} />
      </span>
      <span className="text-[var(--text-secondary)]">
        {usage.estimated ? '~' : ''}
        {fmt(usage.used)}
        <span className="text-[var(--text-muted)]"> / {fmt(usage.ctx)}</span>
      </span>
      {usage.tps > 0 && (
        <span className="hidden md:flex items-center gap-0.5 text-[var(--text-muted)] pl-2 border-l border-[var(--border-color)]">
          <Zap size={10} />
          {usage.tps}
          <span className="text-[9px]">t/s</span>
        </span>
      )}
    </button>
    {open && (
      <div className="absolute right-0 bottom-full mb-1.5 z-30 w-64 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 shadow-xl animate-fade-in text-[11px]">
        <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{t('meter.context')}</div>
        <div className="mb-2 h-2 overflow-hidden rounded-full bg-[var(--border-color)]">
          <div className="h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%`, background: color }} />
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 tabular-nums">
          <dt className="text-[var(--text-muted)]">{t('meter.used')}</dt>
          <dd className="text-right text-[var(--text-primary)]">{usage.estimated ? '~' : ''}{usage.used.toLocaleString()} ({pct}%)</dd>
          <dt className="text-[var(--text-muted)]">{t('meter.window')}</dt>
          <dd className="text-right text-[var(--text-primary)]">{usage.ctx.toLocaleString()}</dd>
          <dt className="text-[var(--text-muted)]">{t('meter.left')}</dt>
          <dd className="text-right text-[var(--text-primary)]">{Math.max(0, usage.ctx - usage.used).toLocaleString()}</dd>
          <dt className="text-[var(--text-muted)]">{t('meter.generated')}</dt>
          <dd className="text-right text-[var(--text-primary)]">{usage.generated.toLocaleString()}</dd>
          {usage.tps > 0 && (
            <>
              <dt className="text-[var(--text-muted)]">{t('meter.speed')}</dt>
              <dd className="text-right text-[var(--text-primary)]">{usage.tps} t/s</dd>
            </>
          )}
          <dt className="text-[var(--text-muted)]">{t('meter.model')}</dt>
          <dd className="truncate text-right text-[var(--text-primary)]" title={usage.model}>{usage.model}</dd>
        </dl>
        {usage.compacted > 0 && <p className="mt-2 text-[var(--text-muted)]">{t('meter.compacted', { n: usage.compacted })}</p>}
        {usage.estimated && <p className="mt-1 text-[var(--text-muted)]">{t('meter.estimated')}</p>}
      </div>
    )}
    </div>
  );
}
