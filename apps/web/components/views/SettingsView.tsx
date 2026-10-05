'use client';

import { CHANGELOG } from '../../lib/changelog';
import { SubscriptionAuth } from './ClaudeCliAuth';
import { useEffect, useState, type ReactNode } from 'react';
import { Palette, Check, Languages, SlidersHorizontal, Cpu, Bot, FolderCog, SquareTerminal, Server, Info, Loader2, FolderOpen, RotateCcw, Zap, ShieldCheck } from 'lucide-react';
import { CloudProviders } from './CloudProviders';
import { SkillsPanel } from './SkillsPanel';
import { ProjectsRoot } from './ProjectsRoot';
import { SettingField } from './settings/SettingField';
import { useAppSettings, type AppSettingsApi } from './settings/useAppSettings';
import { THEMES, getTheme, setTheme, type ThemeId } from '../../lib/theme';
import { useT, LOCALES } from '../../lib/i18n';
import { canRelaunch, relaunchApp, testOllamaUrl } from '../../lib/api';

type Page = 'general' | 'models' | 'agent' | 'projects' | 'terminal' | 'permissions' | 'server' | 'about';

const PAGES: Array<{ id: Page; icon: typeof Cpu }> = [
  { id: 'general', icon: SlidersHorizontal },
  { id: 'models', icon: Cpu },
  { id: 'agent', icon: Bot },
  { id: 'projects', icon: FolderCog },
  { id: 'terminal', icon: SquareTerminal },
  { id: 'permissions', icon: ShieldCheck },
  { id: 'server', icon: Server },
  { id: 'about', icon: Info },
];

const PAGE_KEY = 'otto-settings-page';

type Bridge = { appVersion?: string; relaunch?: unknown; revealPath?: (p: string) => Promise<string>; versions?: Record<string, string>; platform?: string };
const desktopBridge = (): Bridge | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { ottoDesktop?: Bridge }).ottoDesktop);

function Section({ icon: Icon, title, hint, children }: { icon?: typeof Cpu; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-1 flex items-center gap-1.5 text-xs uppercase tracking-wider text-[var(--text-muted)]">
        {Icon && <Icon size={13} />} {title}
      </h2>
      {hint ? <p className="mb-3 text-xs text-[var(--text-muted)]">{hint}</p> : <div className="mb-2" />}
      {children}
    </section>
  );
}

function General() {
  const { t, locale, setLocale } = useT();
  const [theme, setActiveTheme] = useState<ThemeId>('emerald');
  useEffect(() => { setActiveTheme(getTheme()); }, []);
  const pickTheme = (id: ThemeId) => { setTheme(id); setActiveTheme(id); };
  return (
    <>
      <Section icon={Languages} title={t('settings.language')}>
        <div className="grid gap-2 sm:grid-cols-3">
          {LOCALES.map((l) => {
            const active = locale === l.id;
            return (
              <button
                key={l.id}
                onClick={() => setLocale(l.id)}
                className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  active ? 'border-[var(--accent)] bg-[var(--accent-glow)]' : 'border-[var(--border-color)] bg-[var(--bg-secondary)] hover:border-[var(--accent)]/40'
                }`}
              >
                <span className="text-sm text-[var(--text-primary)]">{l.name}</span>
                {active && <Check size={15} className="text-[var(--accent)]" />}
              </button>
            );
          })}
        </div>
      </Section>
      <Section icon={Palette} title={t('settings.scheme')}>
        <div className="grid gap-2 sm:grid-cols-2">
          {THEMES.map((th) => {
            const active = theme === th.id;
            return (
              <button
                key={th.id}
                onClick={() => pickTheme(th.id)}
                className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  active ? 'border-[var(--accent)] bg-[var(--accent-glow)]' : 'border-[var(--border-color)] bg-[var(--bg-secondary)] hover:border-[var(--accent)]/40'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <span className="flex gap-1">
                    <span className="h-4 w-4 rounded-full border border-black/20" style={{ background: th.swatch[0] }} />
                    <span className="h-4 w-4 rounded-full border border-black/20" style={{ background: th.swatch[1] }} />
                  </span>
                  <span className="text-sm text-[var(--text-primary)]">{th.name}</span>
                </span>
                {active && <Check size={15} className="text-[var(--accent)]" />}
              </button>
            );
          })}
        </div>
      </Section>
    </>
  );
}

function OllamaTest({ api }: { api: AppSettingsApi }) {
  const { t } = useT();
  const [state, setState] = useState<{ busy: boolean; ok?: boolean; text?: string }>({ busy: false });
  const run = async () => {
    setState({ busy: true });
    const r = await testOllamaUrl(String(api.value('ollama.url')));
    setState({ busy: false, ok: r.ok, text: r.ok ? t('set.ollama.ok', { n: r.models ?? 0 }) : r.error });
  };
  return (
    <div className="mt-2.5 flex items-center gap-2">
      <button type="button" onClick={() => void run()} disabled={state.busy} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border-color)] px-3 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/40 hover:text-[var(--text-primary)] disabled:opacity-50">
        {state.busy ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />} {t('set.ollama.test')}
      </button>
      {state.text && <span className={`text-xs ${state.ok ? 'text-[var(--success,#10b981)]' : 'text-[var(--error)]'}`}>{state.text}</span>}
    </div>
  );
}

function Fields({ api, page, extra }: { api: AppSettingsApi; page: string; extra?: Record<string, ReactNode> }) {
  if (!api.data) return null;
  return (
    <div className="space-y-3">
      {api.data.meta.filter((m) => m.page === page).map((m) => (
        <SettingField key={m.key} meta={m} api={api} extra={extra?.[m.key]} />
      ))}
    </div>
  );
}

function ServerInfo({ api }: { api: AppSettingsApi }) {
  const { t } = useT();
  const port = api.data?.running['server.port'];
  const dir = api.data?.data_dir ?? '';
  const bridge = desktopBridge();
  return (
    <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 text-xs">
      <dt className="text-[var(--text-muted)]">{t('set.server.running')}</dt>
      <dd className="font-mono text-[var(--text-primary)]">{port ? `127.0.0.1:${String(port)}` : '—'}</dd>
      <dt className="text-[var(--text-muted)]">{t('set.server.data')}</dt>
      <dd className="flex items-center gap-2 break-all font-mono text-[var(--text-primary)]">
        {dir || '—'}
        {dir && bridge?.revealPath && (
          <button type="button" onClick={() => void bridge.revealPath?.(dir)} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--border-color)] px-2 py-0.5 font-sans text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--accent)]">
            <FolderOpen size={11} /> {t('set.server.open')}
          </button>
        )}
      </dd>
    </dl>
  );
}

function About() {
  const { t } = useT();
  const bridge = desktopBridge();
  const rows: Array<[string, string]> = [
    ['zeithub.otto', bridge?.appVersion || CHANGELOG[0]?.version || '—'],
    ...(bridge?.versions ? ([['Electron', bridge.versions.electron], ['Chromium', bridge.versions.chrome], ['Node.js', bridge.versions.node]] as Array<[string, string]>) : []),
    ...(bridge?.platform ? ([[t('set.about.platform'), bridge.platform]] as Array<[string, string]>) : []),
  ];
  return (
    <Section icon={Info} title={t('settings.nav.about')}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-[var(--text-muted)]">{k}</dt>
            <dd className="font-mono text-[var(--text-primary)]">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-[var(--text-muted)]">{t('settings.servicesHint')}</p>
      <h3 className="mb-2 mt-6 text-xs uppercase tracking-wider text-[var(--text-muted)]">{t('set.about.changelog')}</h3>
      <ul className="space-y-4 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 text-sm">
        {CHANGELOG.map((r) => (
          <li key={r.version}>
            <div className="flex items-baseline gap-2">
              <span className="font-mono font-semibold text-[var(--text-primary)]">{r.version}</span>
              <span className="text-xs text-[var(--text-muted)]">{r.date}</span>
            </div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[var(--text-secondary)]">
              {r.items.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function SettingsView() {
  const { t } = useT();
  const api = useAppSettings();
  // the subscription switches act at once (sign-in starts, models appear), so they are saved at once too
  const instantDirty = api.dirtyKeys.some((k) => k === 'claude.cli' || k === 'codex.cli');
  useEffect(() => {
    if (instantDirty && !api.busy) void api.save().then(() => window.dispatchEvent(new Event('otto:subscription-auth')));
  }, [instantDirty, api]);
  const [page, setPage] = useState<Page>('general');
  const [restarting, setRestarting] = useState(false);
  const [laterHidden, setLaterHidden] = useState(false);

  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem(PAGE_KEY) as Page | null;
      if (saved && PAGES.some((p) => p.id === saved)) setPage(saved);
    } catch { /* ignore */ }
  }, []);
  const open = (id: Page) => {
    setPage(id);
    try { window.sessionStorage.setItem(PAGE_KEY, id); } catch { /* ignore */ }
  };

  const desktop = typeof window !== 'undefined' && canRelaunch();
  const restartKeys = api.pendingRestart.map((k) => t(`set.${k}`)).join(', ');

  const restart = async () => {
    setRestarting(true);
    if (!(await relaunchApp())) setRestarting(false);
  };
  const saveAndRestart = async () => {
    if (await api.save()) await restart();
  };

  const showBar = api.dirtyKeys.length > 0 || (api.pendingRestart.length > 0 && !laterHidden);
  const cur = PAGES.find((p) => p.id === page)!;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--border-color)] p-3 lg:flex" aria-label={t('settings.title')}>
          <div className="mb-1 px-2 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{t('settings.title')}</div>
          {PAGES.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => open(p.id)}
              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                page === p.id ? 'bg-[var(--accent-glow)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
              }`}
            >
              <p.icon size={13} className="shrink-0" />
              <span className="truncate">{t(`settings.nav.${p.id}`)}</span>
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-6 py-6">
            <select
              value={page}
              onChange={(e) => open(e.target.value as Page)}
              aria-label={t('settings.title')}
              className="mb-4 w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none lg:hidden"
            >
              {PAGES.map((p) => <option key={p.id} value={p.id}>{t(`settings.nav.${p.id}`)}</option>)}
            </select>
            <h1 className="mb-1 flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]">
              <cur.icon size={18} className="text-[var(--accent)]" /> {t(`settings.nav.${page}`)}
            </h1>
            <p className="mb-6 text-xs text-[var(--text-muted)]">{t(`settings.nav.${page}.hint`)}</p>

            {api.loadError && <p className="mb-4 rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/10 px-3 py-2 text-xs text-[var(--error)]">{api.loadError}</p>}

            {page === 'general' && <General />}
            {page === 'models' && (
              <>
                <CloudProviders />
                <Section icon={Cpu} title={t('settings.models.local')} hint={t('settings.models.localHint')}>
                  <Fields api={api} page="models" extra={{ 'ollama.url': <OllamaTest api={api} />, 'claude.cli': api.value('claude.cli') ? <SubscriptionAuth kind="claude" autoLogin /> : null, 'codex.cli': api.value('codex.cli') ? <SubscriptionAuth kind="codex" autoLogin /> : null }} />
                </Section>
              </>
            )}
            {page === 'agent' && (
              <>
                <Section icon={Bot} title={t('settings.nav.agent')}>
                  <Fields api={api} page="agent" />
                </Section>
                <SkillsPanel />
              </>
            )}
            {page === 'projects' && <ProjectsRoot />}
            {page === 'terminal' && <Fields api={api} page="terminal" />}
            {page === 'permissions' && <Fields api={api} page="permissions" />}
            {page === 'server' && (
              <>
                <Fields api={api} page="server" />
                <ServerInfo api={api} />
                {desktop && (
                  <button type="button" onClick={() => void restart()} disabled={restarting} className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border-color)] px-3 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/40 hover:text-[var(--text-primary)] disabled:opacity-50">
                    {restarting ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} {t('set.server.restartApp')}
                  </button>
                )}
              </>
            )}
            {page === 'about' && <About />}
          </div>
        </div>
      </div>

      {/* Save bar */}
      {showBar && (
        <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-5 py-2.5" role="status" aria-live="polite">
          <span className="text-xs text-[var(--text-secondary)]">
            {api.dirtyKeys.length > 0
              ? t('set.unsaved')
              : desktop
              ? t('set.restartNeeded', { list: restartKeys })
              : `${t('set.restartNeeded', { list: restartKeys })} — ${t('set.restartManual')}`}
          </span>
          <span className="ml-auto flex items-center gap-2">
            {api.dirtyKeys.length > 0 ? (
              <>
                <button type="button" onClick={api.discard} className="h-8 rounded-lg px-3 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">{t('set.discard')}</button>
                <button type="button" onClick={() => void api.save()} disabled={api.busy} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 text-xs font-semibold text-[var(--on-accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50">
                  {api.busy && <Loader2 size={12} className="animate-spin" />} {t('set.save')}
                </button>
                {api.draftNeedsRestart && desktop && (
                  <button type="button" onClick={() => void saveAndRestart()} disabled={api.busy || restarting} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--accent)]/50 px-3 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent-glow)] disabled:opacity-50">
                    <RotateCcw size={12} /> {t('set.saveRestart')}
                  </button>
                )}
              </>
            ) : (
              <>
                <button type="button" onClick={() => setLaterHidden(true)} className="h-8 rounded-lg px-3 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">{t('set.restartLater')}</button>
                {desktop && (
                  <button type="button" onClick={() => void restart()} disabled={restarting} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 text-xs font-semibold text-[var(--on-accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50">
                    {restarting ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} {t('set.restartNow')}
                  </button>
                )}
              </>
            )}
          </span>
        </div>
      )}
      {api.savedFlash && api.dirtyKeys.length === 0 && api.pendingRestart.length === 0 && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-[var(--accent)] px-4 py-1.5 text-xs font-semibold text-[var(--on-accent)] shadow-lg">{t('set.saved')}</div>
      )}
    </div>
  );
}
