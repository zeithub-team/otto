'use client';

import { useEffect, useState } from 'react';
import { Check, Cloud, ExternalLink, Eye, EyeOff, Loader2 } from 'lucide-react';
import { fetchProviderLimits, fetchProviders, saveProvider, testProvider, type ProviderLimits, type ProviderStatus } from '../../lib/api';
import { useT } from '../../lib/i18n';

interface Msg { ok: boolean; text: string }

/**
 * Settings section: free cloud model providers. Each needs only an API key
 * (free account); "custom" takes any OpenAI-compatible base URL instead.
 */
export function CloudProviders() {
  const { t } = useT();
  const [list, setList] = useState<ProviderStatus[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Record<string, Msg>>({});
  const [limits, setLimits] = useState<Record<string, ProviderLimits>>({});

  const loadLimits = (id: string) => {
    void fetchProviderLimits(id).then((l) => setLimits((prev) => ({ ...prev, [id]: l })));
  };

  useEffect(() => {
    void fetchProviders()
      .then((rows) => {
        setList(rows);
        setUrls(Object.fromEntries(rows.filter((r) => r.needs_base_url).map((r) => [r.id, r.base_url])));
        rows.filter((r) => r.configured).forEach((r) => loadLimits(r.id));
      })
      .catch(() => setList([]));
  }, []);

  const update = (row: ProviderStatus) => setList((prev) => prev.map((p) => (p.id === row.id ? row : p)));
  const say = (id: string, msg: Msg | null) =>
    setMsgs((prev) => {
      const next = { ...prev };
      if (msg) next[id] = msg;
      else delete next[id];
      return next;
    });

  const save = async (p: ProviderStatus) => {
    setBusy(p.id);
    say(p.id, null);
    try {
      const change: { apiKey?: string; baseUrl?: string } = {};
      if ((keys[p.id] ?? '').trim()) change.apiKey = keys[p.id].trim();
      if (p.needs_base_url) change.baseUrl = urls[p.id] ?? '';
      const row = await saveProvider(p.id, change);
      update(row);
      setKeys((prev) => ({ ...prev, [p.id]: '' }));
      if (!row.configured) return;
      const res = await testProvider(p.id);
      say(p.id, res.ok ? { ok: true, text: t('prov.ok', { n: res.models }) } : { ok: false, text: res.error ?? 'Error' });
      loadLimits(p.id);
    } catch (exc) {
      say(p.id, { ok: false, text: exc instanceof Error ? exc.message : String(exc) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (p: ProviderStatus) => {
    setBusy(p.id);
    try {
      update(await saveProvider(p.id, { apiKey: '' }));
      say(p.id, { ok: true, text: t('prov.removed') });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mb-8">
      <h2 className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-2 flex items-center gap-1.5">
        <Cloud size={13} /> {t('prov.title')}
      </h2>
      <p className="text-[11px] text-[var(--text-muted)] mb-3">{t('prov.hint')}</p>

      <div className="space-y-2.5">
        {list.map((p) => (
          <div key={p.id} className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">{p.name}</span>
              {p.configured && (
                <span className="flex items-center gap-1 rounded bg-[var(--success)]/15 px-1.5 py-0.5 text-[10px] text-[var(--success)]">
                  <Check size={10} /> {t('prov.connected')}
                </span>
              )}
              {p.signup_url && (
                <a
                  href={p.signup_url}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
                >
                  {t('prov.getKey')} <ExternalLink size={11} />
                </a>
              )}
            </div>
            <p className="mt-1 text-[11px] leading-snug text-[var(--text-muted)]">{t(`prov.note.${p.id}`)}</p>

            {p.configured && limits[p.id] && (
              <div className="mt-1.5 rounded-md bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-[11px] leading-snug text-[var(--text-secondary)]">
                {limits[p.id].daily ? (
                  <>
                    <div className="flex items-center gap-2">
                      <span>
                        {t('prov.limits.daily', {
                          used: limits[p.id].daily!.used,
                          limit: limits[p.id].daily!.limit,
                          left: limits[p.id].daily!.remaining,
                        })}
                      </span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--bg-hover)]">
                      <div
                        className={`h-full transition-all ${limits[p.id].daily!.remaining === 0 ? 'bg-[var(--error)]' : 'bg-[var(--accent)]'}`}
                        style={{ width: `${Math.min(100, Math.round((limits[p.id].daily!.used / Math.max(1, limits[p.id].daily!.limit)) * 100))}%` }}
                      />
                    </div>
                    {limits[p.id].perMinute && (
                      <div className="mt-1 text-[var(--text-muted)]">{t('prov.limits.minute', { n: limits[p.id].perMinute! })}</div>
                    )}
                    {limits[p.id].freeTier && <div className="mt-1 text-[var(--text-muted)]">{t('prov.limits.freeTier')}</div>}
                  </>
                ) : limits[p.id].supported ? (
                  limits[p.id].error && <span className="text-[var(--error)]">{limits[p.id].error}</span>
                ) : (
                  <span className="text-[var(--text-muted)]">{t('prov.limits.other')}</span>
                )}
              </div>
            )}

            <div className="mt-2 space-y-1.5">
              {p.needs_base_url && (
                <input
                  value={urls[p.id] ?? ''}
                  onChange={(e) => setUrls((prev) => ({ ...prev, [p.id]: e.target.value }))}
                  placeholder="http://localhost:1234/v1"
                  spellCheck={false}
                  className="w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-xs font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent)]/50"
                />
              )}
              <div className="flex gap-1.5">
                <div className="relative flex-1">
                  <input
                    type={shown[p.id] ? 'text' : 'password'}
                    value={keys[p.id] ?? ''}
                    onChange={(e) => setKeys((prev) => ({ ...prev, [p.id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') void save(p); }}
                    placeholder={p.hint ? `${t('prov.saved')} (${p.hint})` : p.key_required ? 'API key' : t('prov.keyOptional')}
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-1.5 pr-8 text-xs font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent)]/50"
                  />
                  <button
                    type="button"
                    onClick={() => setShown((prev) => ({ ...prev, [p.id]: !prev[p.id] }))}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    {shown[p.id] ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
                <button
                  onClick={() => void save(p)}
                  disabled={busy === p.id || (!(keys[p.id] ?? '').trim() && !p.needs_base_url)}
                  className="flex items-center gap-1.5 rounded-md border border-[var(--accent)]/40 bg-[var(--accent-glow)] px-3 text-xs text-[var(--accent)] hover:bg-[var(--accent)]/20 disabled:opacity-40 transition-colors"
                >
                  {busy === p.id && <Loader2 size={12} className="animate-spin" />} {t('common.save')}
                </button>
                {p.hint && !p.from_env && (
                  <button
                    onClick={() => void remove(p)}
                    disabled={busy === p.id}
                    className="rounded-md border border-[var(--border-color)] px-3 text-xs text-[var(--text-secondary)] hover:border-[var(--error)]/40 hover:text-[var(--error)] disabled:opacity-40 transition-colors"
                  >
                    {t('common.delete')}
                  </button>
                )}
              </div>
              {msgs[p.id] && (
                <p className={`text-[11px] ${msgs[p.id].ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>{msgs[p.id].text}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
