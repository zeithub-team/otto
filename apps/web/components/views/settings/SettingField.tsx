'use client';

import { RotateCcw } from 'lucide-react';
import type { SettingMeta } from '../../../lib/api';
import { useT } from '../../../lib/i18n';
import type { AppSettingsApi } from './useAppSettings';

const kFmt = (n: number): string => `${Math.round(n / 1024)}k`;

/** One setting, generated from the server schema: label, control, hint, default and error. */
export function SettingField({ meta, api, extra }: { meta: SettingMeta; api: AppSettingsApi; extra?: React.ReactNode }) {
  const { t } = useT();
  const value = api.value(meta.key);
  const error = api.errors[meta.key];
  const changed = String(value) !== String(meta.default);
  const optionLabel = (o: string | number): string => {
    if (typeof o === 'number') return `${kFmt(o)} ${t('set.tokens')}`;
    const key = `set.opt.${o}`;
    const text = t(key);
    return text === key ? o : text;
  };
  const defaultText = typeof meta.default === 'boolean' ? t(meta.default ? 'set.on' : 'set.off') : meta.kind === 'select' ? optionLabel(meta.default as string | number) : String(meta.default);
  const input = 'rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]';

  return (
    <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
      <div className="mb-1 flex items-center gap-2">
        <label htmlFor={`set-${meta.key}`} className="text-sm font-medium text-[var(--text-primary)]">{t(`set.${meta.key}`)}</label>
        {meta.restart && (
          <span className="rounded-full bg-[var(--warning,#f59e0b)]/15 px-2 py-px text-[10px] text-[var(--warning,#f59e0b)]">{t('set.needsRestart')}</span>
        )}
        {changed && (
          <button
            type="button"
            onClick={() => api.set(meta.key, meta.default)}
            title={t('set.resetTo', { v: defaultText })}
            aria-label={t('set.resetTo', { v: defaultText })}
            className="ml-auto rounded p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
          >
            <RotateCcw size={12} />
          </button>
        )}
      </div>
      <p className="mb-2.5 text-xs leading-relaxed text-[var(--text-muted)]">{t(`set.${meta.key}.hint`)}</p>

      {meta.kind === 'bool' && (
        <button
          id={`set-${meta.key}`}
          type="button"
          role="switch"
          aria-checked={Boolean(value)}
          onClick={() => api.set(meta.key, !value)}
          className={`relative h-6 w-11 rounded-full transition-colors ${value ? 'bg-[var(--accent)]' : 'bg-[var(--border-color)]'}`}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${value ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
      )}
      {meta.kind === 'number' && (
        <div className="flex items-center gap-2">
          <input
            id={`set-${meta.key}`}
            type="number"
            min={meta.min}
            max={meta.max}
            value={String(value)}
            onChange={(e) => api.set(meta.key, e.target.value === '' ? '' : Number(e.target.value))}
            className={`${input} w-32 tabular-nums`}
          />
          {meta.min !== undefined && meta.max !== undefined && <span className="text-[11px] text-[var(--text-muted)]">{meta.min}–{meta.max}</span>}
        </div>
      )}
      {meta.kind === 'text' && (
        <input id={`set-${meta.key}`} value={String(value)} onChange={(e) => api.set(meta.key, e.target.value)} className={`${input} w-full font-mono text-xs`} />
      )}
      {meta.kind === 'select' && (
        <div className="flex flex-wrap gap-1.5">
          {(meta.options ?? []).map((o) => {
            const active = String(value) === String(o);
            return (
              <button
                key={String(o)}
                type="button"
                onClick={() => api.set(meta.key, o)}
                aria-pressed={active}
                className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                  active ? 'border-[var(--accent)] bg-[var(--accent-glow)] text-[var(--accent)]' : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text-primary)]'
                }`}
              >
                {optionLabel(o)}
              </button>
            );
          })}
        </div>
      )}
      {extra}
      {error && <p className="mt-2 text-xs text-[var(--error)]">{error}</p>}
    </div>
  );
}
