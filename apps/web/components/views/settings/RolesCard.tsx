'use client';

import { useEffect, useMemo, useState } from 'react';
import { Brain, Wrench, Workflow } from 'lucide-react';
import { fetchModels } from '../../../lib/api';
import { useT } from '../../../lib/i18n';
import type { AppSettingsApi } from './useAppSettings';

const EFFORTS = ['auto', 'off', 'low', 'medium', 'high', 'max'];

/** Size in billions from an Ollama name ("qwen3.6:35b" → 35), 0 when unknown. */
const sizeOf = (m: string): number => Number(/(\d+(?:\.\d+)?)b\b/i.exec(m)?.[1] ?? 0);
const isCloud = (m: string): boolean => m.includes('/');

interface Scheme { id: string; values: Record<string, string | boolean> | null }

/** Ready-made role schemes built from the models this computer has. */
function schemes(models: string[]): Scheme[] {
  const local = models.filter((m) => !isCloud(m));
  const cloud = models.filter(isCloud);
  const strongest = [...local].sort((a, b) => sizeOf(b) - sizeOf(a))[0];
  const coder = local.find((m) => /coder|devstral|codestral/i.test(m))
    ?? [...local].filter((m) => sizeOf(m) >= 7).sort((a, b) => sizeOf(a) - sizeOf(b))[0] ?? local[0];
  const smart = cloud.find((m) => /opus|pro\b|large|sonnet|gpt-5|grok-4|r1|thinking/i.test(m)) ?? cloud[0];
  const cheap = cloud.find((m) => /haiku|flash|mini|small|lite|nano|fast/i.test(m)) ?? cloud[0];
  return [
    { id: 'off', values: { 'roles.mode': 'off' } },
    { id: 'same', values: { 'roles.mode': 'auto', 'roles.planner.model': '', 'roles.planner.effort': 'high', 'roles.coder.model': '', 'roles.coder.effort': 'low' } },
    { id: 'local', values: strongest && coder && strongest !== coder ? { 'roles.mode': 'auto', 'roles.planner.model': strongest, 'roles.planner.effort': 'high', 'roles.coder.model': coder, 'roles.coder.effort': 'off' } : null },
    { id: 'mixed', values: smart && coder ? { 'roles.mode': 'auto', 'roles.planner.model': smart, 'roles.planner.effort': 'high', 'roles.coder.model': coder, 'roles.coder.effort': 'off' } : null },
    { id: 'cloud', values: smart && cheap ? { 'roles.mode': 'auto', 'roles.planner.model': smart, 'roles.planner.effort': 'high', 'roles.coder.model': cheap, 'roles.coder.effort': 'low' } : null },
  ];
}

/** Settings → Models: who thinks (plans, task lists, audits) and who writes the code. */
export function RolesCard({ api }: { api: AppSettingsApi }) {
  const { t } = useT();
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => { void fetchModels().then(setModels).catch(() => undefined); }, []);
  const list = useMemo(() => schemes(models), [models]);
  const on = api.value('roles.mode') !== 'off';
  const v = (k: string) => String(api.value(k) ?? '');
  const apply = (values: Record<string, string | boolean>) => { for (const [k, x] of Object.entries(values)) api.set(k, x); };
  const active = list.find((s) => s.values && Object.entries(s.values).every(([k, x]) => String(api.value(k) ?? '') === String(x)))?.id;
  const field = 'rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs text-[var(--text-primary)]';

  const role = (r: 'planner' | 'coder') => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex w-36 items-center gap-1.5 text-xs font-medium text-[var(--text-primary)]">
        {r === 'planner' ? <Brain size={13} className="text-[var(--accent)]" /> : <Wrench size={13} className="text-[var(--accent)]" />}{t(`roles.${r}`)}
      </span>
      <select value={v(`roles.${r}.model`)} onChange={(e) => api.set(`roles.${r}.model`, e.target.value)} disabled={!on} className={`${field} min-w-0 flex-1`}>
        <option value="">{t('roles.chatModel')}</option>
        {v(`roles.${r}.model`) && !models.includes(v(`roles.${r}.model`)) && <option value={v(`roles.${r}.model`)}>{v(`roles.${r}.model`)}</option>}
        <optgroup label={t('roles.local')}>{models.filter((m) => !isCloud(m)).map((m) => <option key={m} value={m}>{m}</option>)}</optgroup>
        <optgroup label={t('roles.cloud')}>{models.filter(isCloud).map((m) => <option key={m} value={m}>{m}</option>)}</optgroup>
      </select>
      <select value={v(`roles.${r}.effort`) || 'auto'} onChange={(e) => api.set(`roles.${r}.effort`, e.target.value)} disabled={!on} className={field} title={t('roles.effort')}>
        {EFFORTS.map((e) => <option key={e} value={e}>{t('roles.effort')}: {e}</option>)}
      </select>
    </div>
  );

  return (
    <section className="mb-5 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]"><Workflow size={15} className="text-[var(--accent)]" />{t('roles.title')}</h2>
      <p className="mb-3 text-xs leading-relaxed text-[var(--text-muted)]">{t('roles.hint')}</p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {list.map((s) => (
          <button key={s.id} type="button" disabled={!s.values} onClick={() => s.values && apply(s.values)} title={s.values ? t(`roles.scheme.${s.id}.hint`) : t('roles.schemeMissing')}
            className={`rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-35 ${active === s.id ? 'border-[var(--accent)] bg-[var(--accent-glow)] text-[var(--accent)]' : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--accent)]/50'}`}>
            {t(`roles.scheme.${s.id}`)}
          </button>
        ))}
      </div>
      <div className="space-y-2">
        {role('planner')}
        {role('coder')}
        <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          <input type="checkbox" checked={api.value('roles.chain') !== false} disabled={!on} onChange={(e) => api.set('roles.chain', e.target.checked)} />{t('roles.chain')}
        </label>
      </div>
    </section>
  );
}
