'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Brain, Check, Clock, Cloud, Code2, Cpu, Eye, Gift, KeyRound, Layers, RefreshCw, Search, Sparkles, X, Zap } from 'lucide-react';
import { fetchProviders } from '../../lib/api';
import {
  CONTEXT_SIZES, EFFORTS, PROVIDER_KEYS, compareModels, loadRecent, modelBadges, modelClass, providerOf, shortModelName,
  type Effort, type ModelBadge, type ModelClass, type ModelParams, type ProviderKey,
} from '../../lib/models';
import { useT } from '../../lib/i18n';
import { fetchHardware, fetchLocalSizes, fitOf, type FitInfo, type Hardware } from '../../lib/hardware';

type Section = 'all' | 'recent' | ProviderKey;

const BADGE_ICON: Record<ModelBadge, typeof Cpu> = { free: Gift, vision: Eye, reasoning: Brain, coder: Code2, small: Zap, large: Layers };

interface Props {
  models: string[];
  value: string | null;
  params: ModelParams;
  loading: boolean;
  onSelect: (model: string) => void;
  onParams: (params: ModelParams) => void;
  onRefresh: () => void;
  onClose: () => void;
}

/**
 * Model picker: a searchable list split into sections (recent, local, each cloud
 * provider) plus the reasoning effort, context window and temperature of the
 * chat. Providers without a key show a shortcut to Settings instead of a list.
 */
export function ModelPicker({ models, value, params, loading, onSelect, onParams, onRefresh, onClose }: Props) {
  const { t } = useT();
  const [query, setQuery] = useState('');
  const [section, setSection] = useState<Section>('all');
  const [configuredMap, setConfiguredMap] = useState<Record<string, boolean>>({});
  const [cursor, setCursor] = useState(0);
  const [kind, setKind] = useState<'all' | 'online' | 'offline'>('all');
  const [cls, setCls] = useState<'all' | ModelClass>('all');
  const recent = useMemo(() => loadRecent().filter((m) => models.includes(m)), [models]);
  const listRef = useRef<HTMLDivElement>(null);

  // will a local model run on this machine? (memory needed vs RAM / video memory)
  const [hw, setHw] = useState<Hardware | null>(null);
  const [sizes, setSizes] = useState<Record<string, number>>({});
  useEffect(() => {
    void fetchHardware().then(setHw);
    void fetchLocalSizes().then(setSizes);
  }, []);
  const fitFor = (m: string): FitInfo | null => (hw && sizes[m] ? fitOf(sizes[m], hw) : null);

  useEffect(() => {
    void (async () => {
      try {
        const list = (await fetchProviders()) as unknown as Array<{ id: string; configured?: boolean; hasKey?: boolean }>;
        const map: Record<string, boolean> = {};
        for (const p of list) map[p.id] = Boolean(p.configured ?? p.hasKey);
        setConfiguredMap(map);
      } catch { /* status unknown: no lock icons */ }
    })();
  }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: models.length, recent: recent.length };
    for (const key of PROVIDER_KEYS) c[key] = 0;
    for (const m of models) c[providerOf(m)]++;
    return c;
  }, [models, recent.length]);

  const configured = (key: ProviderKey): boolean | null => {
    if (key === 'local') return true;
    return key in configuredMap ? configuredMap[key] : null;
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = section === 'all' ? [...models] : section === 'recent' ? [...recent] : models.filter((m) => providerOf(m) === section);
    if (kind === 'online') list = list.filter((m) => providerOf(m) !== 'local');
    else if (kind === 'offline') list = list.filter((m) => providerOf(m) === 'local');
    if (cls !== 'all') list = list.filter((m) => modelClass(m) === cls);
    if (q) list = list.filter((m) => m.toLowerCase().includes(q));
    return section === 'recent' && !q ? list : list.sort(compareModels);
  }, [models, recent, section, query, kind, cls]);

  useEffect(() => setCursor(0), [section, query, kind, cls]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(filtered.length - 1, c + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
      else if (e.key === 'Enter' && filtered[cursor]) {
        e.preventDefault();
        const f = providerOf(filtered[cursor]) === 'local' ? fitFor(filtered[cursor]) : null;
        if (f?.fit !== 'no') onSelect(filtered[cursor]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, cursor, onClose, onSelect, hw, sizes]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const openSettings = () => {
    window.dispatchEvent(new CustomEvent('otto:open-settings', { detail: { page: 'models' } }));
    onClose();
  };

  const isLocalSelected = !value || providerOf(value) === 'local';
  const needsKey = section !== 'all' && section !== 'recent' && configured(section) === false;

  const nav = (id: Section, label: string, Icon: typeof Cpu, count: number, locked = false) => (
    <button
      key={id}
      type="button"
      onClick={() => setSection(id)}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
        section === id ? 'bg-[var(--accent-glow)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
      }`}
    >
      <Icon size={13} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {locked
        ? <KeyRound size={11} className="shrink-0 text-[var(--text-muted)]" aria-label={t('mp.noKey')} />
        : <span className="shrink-0 tabular-nums text-[10px] text-[var(--text-muted)]">{count}</span>}
    </button>
  );

  const seg = (active: boolean) =>
    `rounded-md border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed ${
      active ? 'border-[var(--accent)] bg-[var(--accent-glow)] text-[var(--accent)]' : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]'
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-label={t('mp.title')} className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl">
        <div className="flex items-center gap-3 border-b border-[var(--border-color)] px-4 py-3">
          <Sparkles size={16} className="shrink-0 text-[var(--accent)]" />
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t('mp.title')}</h2>
          <label className="relative ml-2 min-w-0 flex-1">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('mp.search')}
              className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] py-1.5 pl-8 pr-3 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
            />
          </label>
          <button type="button" onClick={onRefresh} aria-label="Refresh" className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <X size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav className="hidden w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--border-color)] p-2 sm:flex" aria-label={t('mp.sections')}>
            {nav('all', t('mp.all'), Layers, counts.all)}
            {nav('recent', t('mp.recent'), Clock, counts.recent)}
            <div className="mx-2 my-1.5 h-px bg-[var(--border-color)]" />
            {PROVIDER_KEYS.filter((key) => (kind === 'online' ? key !== 'local' : kind === 'offline' ? key === 'local' : true)).map((key) => {
              const known = configured(key);
              if (key === 'custom' && !counts.custom && known !== true) return null;
              return nav(key, t(`mp.p.${key}`), key === 'local' ? Cpu : Cloud, counts[key], known === false);
            })}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--border-color)] px-3 py-2">
              <div className="flex gap-1.5" role="radiogroup" aria-label={t('mp.kind')}>
                {(['all', 'online', 'offline'] as const).map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => { setKind(k); setSection('all'); }} className={seg(kind === k)}>{t(`mp.kind.${k}`)}</button>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('mp.class')}>
                {(['all', 'coding', 'vision', 'chat'] as const).map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={cls === c} onClick={() => setCls(c)} className={seg(cls === c)}>{t(`mp.cls.${c}`)}</button>
                ))}
              </div>
            </div>
            <div ref={listRef} className="min-h-[220px] flex-1 overflow-y-auto p-2">
              {needsKey && (
                <div className="m-2 rounded-xl border border-dashed border-[var(--border-color)] p-5 text-center">
                  <KeyRound size={22} className="mx-auto mb-2 text-[var(--accent)]" />
                  <p className="mb-1 text-sm font-medium text-[var(--text-primary)]">{t('mp.connect', { name: t(`mp.p.${section}`) })}</p>
                  <p className="mb-3 text-xs text-[var(--text-muted)]">{t(`mp.p.${section}.hint`)}</p>
                  <button type="button" onClick={openSettings} className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--bg-primary)] hover:opacity-90">{t('mp.openSettings')}</button>
                </div>
              )}
              {!needsKey && filtered.length === 0 && (
                <p className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">{query ? t('mp.nothing') : '—'}</p>
              )}
              {!needsKey && filtered.map((m, i) => {
                const active = m === value;
                const key = providerOf(m);
                const fit = key === 'local' ? fitFor(m) : null;
                return (
                  <button
                    key={m}
                    data-i={i}
                    type="button"
                    onClick={() => { if (fit?.fit !== 'no') onSelect(m); }}
                    onMouseMove={() => setCursor(i)}
                    aria-disabled={fit?.fit === 'no'}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${i === cursor ? 'bg-[var(--bg-hover)]' : ''} ${active ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'} ${fit?.fit === 'no' ? 'cursor-not-allowed opacity-50' : ''}`}
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                      {active ? <Check size={14} /> : key === 'local' ? <Cpu size={13} className="text-[var(--text-muted)]" /> : <Cloud size={13} className="text-[var(--text-muted)]" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate font-mono text-xs ${active ? '' : 'text-[var(--text-primary)]'}`}>{shortModelName(m)}</span>
                      {(section === 'all' || section === 'recent') && <span className="block text-[10px] text-[var(--text-muted)]">{t(`mp.p.${key}`)}</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {fit && fit.fit !== 'gpu' && hw && (
                        <span
                          title={t('mp.fit.tip', { need: fit.needGb, ram: hw.ramGb, vram: hw.vramGb })}
                          className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium ${
                            fit.fit === 'no' ? 'border-[var(--error)]/50 bg-[var(--error)]/10 text-[var(--error)]' : 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                          }`}
                        >
                          <AlertTriangle size={10} /> {t(`mp.fit.${fit.fit}`)}
                        </span>
                      )}
                      {modelBadges(m).map((b) => {
                        const Icon = BADGE_ICON[b];
                        return (
                          <span key={b} title={t(`mp.badge.${b}`)} className="inline-flex items-center gap-0.5 rounded-full border border-[var(--border-color)] px-1.5 py-px text-[10px] text-[var(--text-muted)]">
                            <Icon size={10} /> <span className="hidden md:inline">{t(`mp.badge.${b}`)}</span>
                          </span>
                        );
                      })}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="space-y-3 border-t border-[var(--border-color)] px-4 py-3">
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-xs font-medium text-[var(--text-primary)]">{t('mp.effort')}</span>
                  <span className="text-[11px] text-[var(--text-muted)]">{t(`mp.effort.${params.effort}`)}</span>
                </div>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('mp.effort')}>
                  {EFFORTS.map((e: Effort) => (
                    <button key={e} type="button" role="radio" aria-checked={params.effort === e} onClick={() => onParams({ ...params, effort: e })} className={seg(params.effort === e)}>
                      {t(`mp.eff.${e}`)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className={isLocalSelected ? '' : 'opacity-50'}>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-xs font-medium text-[var(--text-primary)]">{t('mp.ctx')}</span>
                    {!isLocalSelected && <span className="text-[11px] text-[var(--text-muted)]">{t('mp.ctxLocalOnly')}</span>}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" disabled={!isLocalSelected} onClick={() => onParams({ ...params, numCtx: null })} className={seg(params.numCtx === null)}>{t('mp.eff.auto')}</button>
                    {CONTEXT_SIZES.map((n) => (
                      <button key={n} type="button" disabled={!isLocalSelected} onClick={() => onParams({ ...params, numCtx: n })} className={seg(params.numCtx === n)}>{Math.round(n / 1024)}k</button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-xs font-medium text-[var(--text-primary)]">{t('mp.temperature')}</span>
                    <span className="text-[11px] tabular-nums text-[var(--text-muted)]">{params.temperature === null ? t('mp.eff.auto') : params.temperature.toFixed(1)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="range" min={0} max={1} step={0.1}
                      value={params.temperature ?? 0.4}
                      onChange={(e) => onParams({ ...params, temperature: Number(e.target.value) })}
                      aria-label={t('mp.temperature')}
                      className="h-1 flex-1 accent-[var(--accent)]"
                    />
                    <button type="button" onClick={() => onParams({ ...params, temperature: null })} className={seg(params.temperature === null)}>{t('mp.eff.auto')}</button>
                  </div>
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">{t('mp.note')}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
