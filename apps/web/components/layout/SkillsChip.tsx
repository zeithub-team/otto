'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Search, Sparkles } from 'lucide-react';
import { fetchSkills, resetSkillProfile, setSkillEnabled, type SkillInfo } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { shortModelName } from '../../lib/models';

const CATEGORY_ORDER = ['design', 'code', 'testing', 'writing', 'media', 'data', 'workflow', 'productivity', 'business', 'learning', 'other'] as const;

/**
 * "Skills" next to Tools / Web: which skills the chosen model may use in this project, with search and grouped
 * by kind of work. The choice is kept per project + model (the first change copies the global choice).
 */
export function SkillsChip({ projectId, model }: { projectId?: number; model: string | null }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    void fetchSkills(projectId, model ?? undefined).then(setSkills).catch(() => setSkills([]));
  }, [projectId, model]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!open) return;
    window.setTimeout(() => searchRef.current?.focus(), 0);
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const on = skills.filter((s) => s.enabled).length;
  const own = skills.some((s) => s.own_profile);
  const set = (names: string[], enabled: boolean) => {
    setSkills((prev) => prev.map((s) => (names.includes(s.name) ? { ...s, enabled, own_profile: true } : s)));
    void Promise.all(names.map((n) => setSkillEnabled(n, enabled, projectId, model ?? undefined))).catch(load);
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (s: SkillInfo) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || t(`sk.cat.${s.category ?? 'other'}`).toLowerCase().includes(q);
    return CATEGORY_ORDER
      .map((cat) => ({ cat, items: skills.filter((s) => (s.category ?? 'other') === cat && hit(s)).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)) }))
      .filter((g) => g.items.length > 0);
  }, [skills, query, t]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={t('sk.title')}
        className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors ${on > 0 ? 'border-[var(--accent)]/40 bg-[var(--accent-glow)] text-[var(--accent)]' : 'border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
      >
        <Sparkles size={13} /> {t('sk.chip')} <span className="opacity-70">{on}/{skills.length}</span>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 flex max-h-[70vh] w-96 flex-col overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-xl">
          <div className="border-b border-[var(--border-color)] px-3 py-2">
            <div className="text-xs font-medium text-[var(--text-primary)]">{t('sk.title')}</div>
            <div className="truncate text-[10px] text-[var(--text-muted)]">
              {model ? t('sk.forModel', { model: shortModelName(model) }) : t('sk.noModel')} · {own ? t('sk.own') : t('sk.global')}
            </div>
            <div className="relative mt-2">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
              <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('sk.search')}
                className="w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] py-1 pl-7 pr-2 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {groups.length === 0 && <div className="px-3 py-4 text-center text-[11px] text-[var(--text-muted)]">{query ? t('sk.nothing') : t('sk.none')}</div>}
            {groups.map(({ cat, items }) => {
              const allOn = items.every((s) => s.enabled);
              return (
                <div key={cat} className="pb-1">
                  <div className="sticky top-0 z-10 flex items-center gap-2 bg-[var(--bg-secondary)] px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    <span className="flex-1">{t(`sk.cat.${cat}`)} <span className="font-normal opacity-70">{items.filter((s) => s.enabled).length}/{items.length}</span></span>
                    <button onClick={() => set(items.map((s) => s.name), !allOn)} className="font-normal normal-case tracking-normal text-[var(--accent)] hover:underline">{allOn ? t('sk.noneOfGroup') : t('sk.allOfGroup')}</button>
                  </div>
                  {items.map((s) => (
                    <label key={s.name} className="flex cursor-pointer items-start gap-2 px-3 py-1.5 hover:bg-[var(--bg-hover)]">
                      <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={s.enabled} onChange={() => set([s.name], !s.enabled)} />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 text-xs text-[var(--text-primary)]">
                          {s.name}
                          {s.official && <span className="rounded bg-[var(--accent-glow)] px-1 text-[9px] text-[var(--accent)]" title={t('sk.officialHint')}>{s.vendor === 'openai' ? 'OpenAI' : 'Anthropic'}</span>}
                          {s.source !== 'builtin' && s.source !== 'library' && <span className="text-[10px] text-[var(--text-muted)]">({t(`sk.src.${s.source}`)})</span>}
                        </span>
                        {s.description && <span className="block text-[10px] leading-snug text-[var(--text-muted)] line-clamp-2">{s.description}</span>}
                      </span>
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
          {own && model && projectId && (
            <button onClick={() => void resetSkillProfile(projectId, model).then(load)} className="flex w-full items-center gap-1.5 border-t border-[var(--border-color)] px-3 py-2 text-[11px] text-[var(--text-secondary)] hover:text-[var(--accent)]">
              <RotateCcw size={11} /> {t('sk.reset')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
