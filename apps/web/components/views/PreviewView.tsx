'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play, Square, RotateCw, Smartphone, Monitor, ExternalLink, Maximize2, Minimize2, TerminalSquare,
  Globe, Loader2, MonitorSmartphone, Plus, X,
} from 'lucide-react';
import type { Project } from '../../types';
import { detectRun, fetchPages, fetchRun, fetchSiteStamp, serverUrl, startRun, stopRun, type RunDetection, type RunState } from '../../lib/api';
import { useT } from '../../lib/i18n';

interface Device {
  id: string;
  label: string;
  w: number;
  h: number;
  group: 'phones' | 'tablets' | 'desktops';
}

const DEVICES: Device[] = [
  { id: 'iphone-se', label: 'iPhone SE', w: 375, h: 667, group: 'phones' },
  { id: 'iphone-15', label: 'iPhone 15', w: 393, h: 852, group: 'phones' },
  { id: 'iphone-15-pm', label: 'iPhone 15 Pro Max', w: 430, h: 932, group: 'phones' },
  { id: 'pixel-8', label: 'Pixel 8', w: 412, h: 915, group: 'phones' },
  { id: 'galaxy-s23', label: 'Galaxy S23', w: 360, h: 780, group: 'phones' },
  { id: 'ipad-mini', label: 'iPad mini', w: 744, h: 1133, group: 'tablets' },
  { id: 'ipad-air', label: 'iPad Air', w: 820, h: 1180, group: 'tablets' },
  { id: 'ipad-pro', label: 'iPad Pro 12.9', w: 1024, h: 1366, group: 'tablets' },
  { id: 'laptop', label: 'Laptop 1280×800', w: 1280, h: 800, group: 'desktops' },
  { id: 'desktop', label: 'Desktop 1440×900', w: 1440, h: 900, group: 'desktops' },
  { id: 'fullhd', label: 'Full HD 1920×1080', w: 1920, h: 1080, group: 'desktops' },
];

const PREFS_KEY = 'otto-preview-prefs';

interface Prefs {
  device: string;
  /** Swap width and height relative to the device's natural orientation. */
  rotated: boolean;
  zoom: 'fit' | number;
  custom: { w: number; h: number };
}

const DEFAULT_PREFS: Prefs = { device: 'iphone-15', rotated: false, zoom: 'fit', custom: { w: 800, h: 600 } };

function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

const STATUS_DOT: Record<RunState['status'], string> = {
  idle: 'bg-[var(--text-muted)]',
  starting: 'bg-[var(--warning,#f59e0b)] animate-pulse',
  running: 'bg-[var(--success,#10b981)]',
  exited: 'bg-[var(--error,#ef4444)]',
};

/** A preview tab: one page / address (url '' = a new, empty tab). */
interface Tab { id: number; url: string }

/** Short tab title: the file name of a project page, host + path of an address. */
function tabTitle(url: string): string {
  if (!url) return '';
  if (url.startsWith('/api/site/')) return decodeURIComponent(url.split('/').slice(4).join('/')) || 'index.html';
  try { const u = new URL(url); return u.host + (u.pathname === '/' ? '' : u.pathname); } catch { return url; }
}

const clampSize = (n: number): number => Math.max(200, Math.min(4000, Math.round(n) || 200));

/** Preview tab: run the project and look at it in a device frame (phone, tablet, desktop). */
export function PreviewView({ project, openFile, openUrl }: { project: Project | null; /** A file another part of the app asked to preview (editor button, chat). */ openFile?: { path: string; n: number } | null; /** An address the agent asked to show (a dev server it started). */ openUrl?: { url: string; n: number } | null }) {
  const { t } = useT();
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [detect, setDetect] = useState<RunDetection | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [command, setCommand] = useState('');
  const [address, setAddress] = useState('');
  const [frameUrl, setFrameUrl] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState('');
  const [pages, setPages] = useState<string[]>([]);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState(0);
  const nextTab = useRef(1);
  const stage = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const projectId = project?.id;

  useEffect(() => setPrefs(loadPrefs()), []);
  const patch = (change: Partial<Prefs>) =>
    setPrefs((prev) => {
      const next = { ...prev, ...change };
      try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });

  // Detect what can be run whenever the project changes.
  useEffect(() => {
    setDetect(null);
    setRun(null);
    setFrameUrl('');
    setAddress('');
    setError('');
    setTabs([]);
    setActiveTab(0);
    if (projectId === undefined) return;
    let alive = true;
    void detectRun(projectId).then((d) => alive && (setDetect(d), setCommand((c) => c || d.command))).catch(() => undefined);
    void fetchPages(projectId).then((p) => alive && setPages(p)).catch(() => undefined);
    void fetchRun(projectId).then((r) => alive && setRun(r)).catch(() => undefined);
    return () => { alive = false; };
  }, [projectId]);

  // the agent started / stopped the project (otto_preview): pick up its new state
  useEffect(() => {
    if (projectId === undefined) return;
    const refresh = () => { afterExit.current = 0; void fetchRun(projectId).then(setRun).catch(() => undefined); };
    window.addEventListener('otto:preview-refresh', refresh);
    return () => window.removeEventListener('otto:preview-refresh', refresh);
  }, [projectId]);

  // Keep the command box in sync with the project's own suggestion until the user edits it.
  useEffect(() => { setCommand(detect?.command ?? ''); }, [detect?.command, projectId]);

  // Poll while the app is starting/running (URL and log come from the server).
  const afterExit = useRef(0);
  useEffect(() => {
    if (projectId === undefined || !run) return;
    const live = run.status === 'starting' || run.status === 'running';
    // an exited command may still attach to a server that owns its port: look a few more times
    const settling = run.status === 'exited' && !run.url && (Boolean(run.busy_port) || afterExit.current < 6);
    if (!live && !settling) return;
    const timer = setInterval(() => {
      if (!live) afterExit.current += 1;
      void fetchRun(projectId).then(setRun).catch(() => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [projectId, run?.status, run?.url, run?.busy_port]); // eslint-disable-line react-hooks/exhaustive-deps

  // The dev server announced its address: show it.
  useEffect(() => {
    if (run?.url && run.url !== address && !frameUrl) {
      setAddress(run.url);
      setFrameUrl(run.url);
      setLoading(true);
    }
  }, [run?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [run?.log.length, showLog]);

  // Measure the stage for "fit".
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => observer.disconnect();
  }, [fullscreen, projectId]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const isCustom = prefs.device === 'responsive';
  const device = DEVICES.find((d) => d.id === prefs.device);
  const base = isCustom || !device ? prefs.custom : { w: device.w, h: device.h };
  const width = prefs.rotated && !isCustom ? base.h : base.w;
  const height = prefs.rotated && !isCustom ? base.w : base.h;
  const scale = useMemo(() => {
    if (prefs.zoom !== 'fit') return prefs.zoom;
    if (!box.w || !box.h) return 1;
    return Math.min(1, (box.w - 40) / (width + 24), (box.h - 40) / (height + 24));
  }, [prefs.zoom, box, width, height]);
  const framed = !isCustom && device?.group !== 'desktops';
  const bezel = framed ? 12 : 0;

  const running = run?.status === 'starting' || run?.status === 'running';
  const canRun = Boolean(command.trim());

  const siteRoute = (rel: string): string => `/api/site/${projectId}/${rel.split('/').map(encodeURIComponent).join('/')}`;
  const isStatic = frameUrl.startsWith('/api/site/');

  const go = useCallback((url: string) => {
    const target = url.trim();
    if (!target) return;
    const full = /^[a-z]+:\/\//i.test(target) ? target : target.startsWith('/') ? target : `http://${target}`;
    setAddress(target);
    setFrameUrl(full);
    setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);

  // the current tab follows whatever is shown (address bar, page picker, dev server)
  useEffect(() => {
    if (!frameUrl) return;
    setTabs((prev) => {
      if (prev.some((x) => x.id === activeTab)) return prev.map((x) => (x.id === activeTab ? { ...x, url: frameUrl } : x));
      const id = nextTab.current++;
      setActiveTab(id);
      return [...prev, { id, url: frameUrl }];
    });
  }, [frameUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const showTab = (tab: Tab): void => {
    setActiveTab(tab.id);
    setAddress(tab.url.startsWith('/api/site/') ? '' : tab.url);
    setFrameUrl(tab.url);
    setLoading(Boolean(tab.url));
    setReloadKey((k) => k + 1);
  };

  /** Opens a page in its own tab (or switches to the tab already showing it). */
  const openTab = (url: string): void => {
    const full = /^[a-z]+:\/\//i.test(url) || url.startsWith('/') ? url : `http://${url}`;
    const same = tabs.find((x) => x.url === full);
    if (same) { showTab(same); return; }
    const id = nextTab.current++;
    setTabs((prev) => [...prev, { id, url: full }]);
    showTab({ id, url: full });
  };

  const newTab = (): void => {
    const id = nextTab.current++;
    setTabs((prev) => [...prev, { id, url: '' }]);
    showTab({ id, url: '' });
  };

  const closeTab = (id: number): void => {
    const i = tabs.findIndex((x) => x.id === id);
    const rest = tabs.filter((x) => x.id !== id);
    setTabs(rest);
    if (id !== activeTab) return;
    const next = rest[Math.min(i, rest.length - 1)];
    if (next) showTab(next);
    else { setActiveTab(0); setAddress(''); setFrameUrl(''); }
  };

  // the agent started a server and wants it shown
  useEffect(() => {
    if (openUrl?.url) openTab(openUrl.url);
  }, [openUrl?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // a file was sent here from the editor or the chat
  useEffect(() => {
    if (!openFile || projectId === undefined) return;
    openTab(siteRoute(openFile.path));
    void fetchPages(projectId).then(setPages).catch(() => undefined);
  }, [openFile?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // live reload of a static page: files change on disk (the AI wrote them, or a person did)
  useEffect(() => {
    if (!isStatic || projectId === undefined) return;
    let last = 0;
    let alive = true;
    const bump = (): void => { setLoading(true); setReloadKey((k) => k + 1); };
    const tick = async (): Promise<void> => {
      const stamp = await fetchSiteStamp(projectId).catch(() => 0);
      if (!alive) return;
      if (last && stamp && stamp !== last) bump();
      if (stamp) last = stamp;
    };
    void tick();
    const timer = setInterval(() => void tick(), 1200);
    const onFiles = (): void => { setTimeout(() => void tick(), 350); };
    window.addEventListener('otto:files-changed', onFiles);
    return () => { alive = false; clearInterval(timer); window.removeEventListener('otto:files-changed', onFiles); };
  }, [isStatic, projectId, frameUrl]);

  const onRun = async () => {
    if (projectId === undefined) return;
    setError('');
    try {
      setFrameUrl('');
      afterExit.current = 0;
      setRun(await startRun(projectId, command.trim() || undefined));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    }
  };

  const onStop = async () => {
    if (projectId === undefined) return;
    try { setRun(await stopRun(projectId)); } catch { /* ignore */ }
  };

  const openExternal = () => {
    const url = frameUrl || run?.url;
    if (!url) return;
    window.open(url.startsWith('/') ? serverUrl(url) : url, '_blank');
  };

  if (!project) {
    return <div className="flex flex-1 items-center justify-center text-[var(--text-muted)]">{t('prev.noProject')}</div>;
  }

  const shownStatus = run?.status ?? 'idle';
  const iframeSrc = frameUrl.startsWith('/') ? serverUrl(frameUrl) : frameUrl;
  const btn = 'inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/40 hover:text-[var(--text-primary)] disabled:opacity-40';

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${fullscreen ? 'fixed inset-0 z-50 bg-[var(--bg-primary)]' : ''}`}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2">
        {running ? (
          <button onClick={() => void onStop()} className={`${btn} border-[var(--error)]/40 text-[var(--error)]`}>
            <Square size={12} fill="currentColor" /> {t('prev.stop')}
          </button>
        ) : (
          <button
            onClick={() => void onRun()}
            disabled={!canRun}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[var(--accent)] px-2.5 text-xs font-semibold text-[var(--on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
            title={canRun ? undefined : t('prev.nothingToRun')}
          >
            <Play size={12} fill="currentColor" /> {t('prev.run')}
          </button>
        )}
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && canRun && !running) void onRun(); }}
          placeholder={t('prev.command')}
          aria-label={t('prev.command')}
          disabled={running}
          className="h-7 w-44 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)]/60 px-2 font-mono text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]/60 disabled:opacity-60"
        />
        <span className="flex items-center gap-1.5 px-1 text-[11px] text-[var(--text-muted)]" aria-live="polite">
          <span className={`h-2 w-2 rounded-full ${run?.attached ? STATUS_DOT.running : STATUS_DOT[shownStatus]}`} />
          {run?.attached ? t('prev.attached') : t(`prev.${shownStatus}`)}
        </span>
        {detect?.site_url && (
          <button onClick={() => go(detect.site_url!)} className={btn}>
            <Globe size={12} /> {t('prev.openSite')}
          </button>
        )}

        <span className="mx-1 hidden h-5 w-px bg-[var(--border-color)] md:block" />

        {/* Address bar */}
        <form
          onSubmit={(e) => { e.preventDefault(); go(address); }}
          className="flex min-w-[180px] flex-1 items-center gap-1"
        >
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="http://localhost:3000"
            aria-label={t('prev.address')}
            className="h-7 min-w-0 flex-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)]/60 px-2 font-mono text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]/60"
          />
          <button type="button" onClick={() => { setLoading(true); setReloadKey((k) => k + 1); }} disabled={!frameUrl} className={btn} title={t('prev.reload')} aria-label={t('prev.reload')}>
            <RotateCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
        </form>

        {/* Device */}
        <select
          value={prefs.device}
          onChange={(e) => patch({ device: e.target.value, rotated: false })}
          aria-label="Device"
          className="h-7 rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-1.5 text-xs text-[var(--text-primary)] outline-none"
        >
          {(['phones', 'tablets', 'desktops'] as const).map((group) => (
            <optgroup key={group} label={t(`prev.${group}`)}>
              {DEVICES.filter((d) => d.group === group).map((d) => (
                <option key={d.id} value={d.id}>{d.group === 'desktops' ? d.label : `${d.label} · ${d.w}×${d.h}`}</option>
              ))}
            </optgroup>
          ))}
          <option value="responsive">{t('prev.responsive')}</option>
        </select>
        {isCustom && (
          <span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
            <input
              type="number" min={200} max={4000} value={prefs.custom.w} aria-label={t('prev.width')}
              onChange={(e) => patch({ custom: { ...prefs.custom, w: clampSize(Number(e.target.value)) } })}
              className="h-7 w-16 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)]/60 px-1.5 text-xs text-[var(--text-primary)] outline-none"
            />
            ×
            <input
              type="number" min={200} max={4000} value={prefs.custom.h} aria-label={t('prev.height')}
              onChange={(e) => patch({ custom: { ...prefs.custom, h: clampSize(Number(e.target.value)) } })}
              className="h-7 w-16 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)]/60 px-1.5 text-xs text-[var(--text-primary)] outline-none"
            />
          </span>
        )}
        {!isCustom && (
          <button onClick={() => patch({ rotated: !prefs.rotated })} className={btn} title={t('prev.rotate')} aria-label={t('prev.rotate')} aria-pressed={prefs.rotated}>
            {(device?.group === 'desktops') !== prefs.rotated ? <Monitor size={13} /> : <Smartphone size={13} />}
          </button>
        )}
        <select
          value={String(prefs.zoom)}
          onChange={(e) => patch({ zoom: e.target.value === 'fit' ? 'fit' : Number(e.target.value) })}
          aria-label={t('prev.zoom')}
          className="h-7 rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-1.5 text-xs text-[var(--text-primary)] outline-none"
        >
          <option value="fit">{t('prev.fit')}</option>
          {[0.5, 0.75, 1, 1.25].map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
        </select>

        <button onClick={() => setShowLog((v) => !v)} className={`${btn} ${showLog ? 'text-[var(--accent)]' : ''}`} title={t('prev.log')} aria-pressed={showLog}>
          <TerminalSquare size={13} />
        </button>
        <button onClick={openExternal} disabled={!frameUrl && !run?.url} className={btn} title={t('prev.openBrowser')} aria-label={t('prev.openBrowser')}>
          <ExternalLink size={13} />
        </button>
        <button onClick={() => setFullscreen((v) => !v)} className={btn} title={fullscreen ? t('prev.exitFullscreen') : t('prev.fullscreen')} aria-label={fullscreen ? t('prev.exitFullscreen') : t('prev.fullscreen')}>
          {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>

      {/* Tabs */}
      {tabs.length > 0 && (
        <div role="tablist" className="flex items-center gap-1 overflow-x-auto border-b border-[var(--border-color)] bg-[var(--bg-secondary)]/60 px-2 pt-1.5">
          {tabs.map((tab) => {
            const on = tab.id === activeTab;
            return (
              <div key={tab.id} role="tab" aria-selected={on}
                className={`group flex h-7 max-w-[200px] shrink-0 items-center gap-1 rounded-t-md border border-b-0 px-2 text-[11px] ${on ? 'border-[var(--border-color)] bg-[var(--bg-primary)] text-[var(--text-primary)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}>
                <button onClick={() => showTab(tab)} className="min-w-0 truncate" title={tab.url}>{tabTitle(tab.url) || t('prev.newTab')}</button>
                <button onClick={() => closeTab(tab.id)} aria-label={t('prev.closeTab')} className="rounded p-0.5 opacity-50 hover:bg-[var(--bg-tertiary)] hover:opacity-100"><X size={11} /></button>
              </div>
            );
          })}
          <button onClick={newTab} aria-label={t('prev.newTab')} title={t('prev.newTab')} className="mb-0.5 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"><Plus size={13} /></button>
        </div>
      )}

      {/* What was recognised in the project */}
      {detect && (detect.stacks.length > 0 || detect.containers.compose || pages.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]/60 px-3 py-1.5 text-[11px]">
          {detect.stacks.map((s) => (
            <span key={s} className="rounded-full border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2 py-0.5 text-[var(--text-secondary)]">{s}</span>
          ))}
          {!detect.frontend && <span className="rounded-full bg-[var(--warning,#f59e0b)]/15 px-2 py-0.5 text-[var(--warning,#f59e0b)]">{t('prev.noFrontend')}</span>}
          {detect.options.length > 1 && (
            <label className="ml-auto flex items-center gap-1.5 text-[var(--text-muted)]">
              {t('prev.launch')}
              <select
                value={detect.options.find((o) => o.command === command)?.id ?? ''}
                onChange={(e) => { const o = detect.options.find((x) => x.id === e.target.value); if (o) setCommand(o.command); }}
                disabled={running}
                className="h-6 max-w-[300px] rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-1.5 text-[11px] text-[var(--text-primary)] outline-none disabled:opacity-60"
              >
                <option value="" disabled>{t('prev.custom')}</option>
                {detect.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </label>
          )}
          {pages.length > 0 && (
            <label className={`${detect.options.length > 1 ? '' : 'ml-auto '}flex items-center gap-1.5 text-[var(--text-muted)]`}>
              {t('prev.file')}
              <select
                value={isStatic ? pages.find((pg) => siteRoute(pg) === frameUrl) ?? '' : ''}
                onChange={(e) => { if (e.target.value) go(siteRoute(e.target.value)); }}
                className="h-6 max-w-[260px] rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-1.5 text-[11px] text-[var(--text-primary)] outline-none"
              >
                <option value="" disabled>{t('prev.pickFile')}</option>
                {pages.map((pg) => <option key={pg} value={pg}>{pg}</option>)}
              </select>
            </label>
          )}
        </div>
      )}

      {error && <div className="border-b border-[var(--error)]/30 bg-[var(--error)]/10 px-3 py-1.5 text-xs text-[var(--error)]">{error}</div>}

      {/* Stage */}
      <div ref={stage} className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[var(--bg-primary)] p-5"
        style={{ backgroundImage: 'radial-gradient(circle, var(--border-color) 1px, transparent 1px)', backgroundSize: '18px 18px' }}>
        {frameUrl ? (
          <div className="relative shrink-0" style={{ width: (width + bezel * 2) * scale, height: (height + bezel * 2) * scale }}>
            <div
              className={framed ? 'rounded-[34px] bg-[#0b0b0d] shadow-[0_18px_50px_rgba(0,0,0,0.55)] ring-1 ring-white/10' : 'rounded-md shadow-[0_18px_50px_rgba(0,0,0,0.45)] ring-1 ring-[var(--border-color)]'}
              style={{ width: width + bezel * 2, height: height + bezel * 2, padding: bezel, transform: `scale(${scale})`, transformOrigin: 'top left' }}
            >
              <div className={`relative h-full w-full overflow-hidden bg-white ${framed ? 'rounded-[24px]' : 'rounded-md'}`}>
                <iframe
                  key={reloadKey}
                  src={iframeSrc}
                  title="preview"
                  onLoad={() => setLoading(false)}
                  className="h-full w-full border-0 bg-white"
                  allow="clipboard-read; clipboard-write; fullscreen; geolocation; microphone; camera"
                />
                {loading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-white/70">
                    <Loader2 size={22} className="animate-spin text-neutral-500" />
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="max-w-md text-center">
            <MonitorSmartphone size={38} className="mx-auto mb-3 text-[var(--accent)]" />
            <h2 className="mb-1.5 text-base font-semibold text-[var(--text-primary)]">{t('prev.emptyTitle')}</h2>
            {run?.status === 'exited' && !run.url ? (
              <div className="rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/10 p-3 text-left">
                <div className="mb-1.5 text-xs font-semibold text-[var(--error)]">
                  {run.busy_port ? t('prev.portBusy', { port: run.busy_port }) : t('prev.failed')}
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-[var(--text-secondary)]">
                  {run.log.slice(-8).join('\n')}
                </pre>
              </div>
            ) : (
              <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{detect && !detect.frontend ? t('prev.noFrontendText') : canRun || detect?.site_url ? t('prev.emptyText') : t('prev.nothingToRun')}</p>
            )}
            {run?.status === 'starting' && <Loader2 size={18} className="mx-auto mt-4 animate-spin text-[var(--accent)]" />}
          </div>
        )}
        <div className="pointer-events-none absolute bottom-2 left-3 text-[10px] tabular-nums text-[var(--text-muted)]">
          {width}×{height} · {Math.round(scale * 100)}%
        </div>
        {frameUrl && <div className="pointer-events-none absolute bottom-2 right-3 max-w-[60%] truncate text-[10px] text-[var(--text-muted)]">{t('prev.blocked')}</div>}
      </div>

      {/* Log */}
      {showLog && (
        <pre ref={logRef} className="max-h-40 min-h-[5rem] overflow-auto border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 font-mono text-[11px] leading-snug text-[var(--text-secondary)]">
          {run?.log.length ? run.log.join('\n') : '—'}
        </pre>
      )}
    </div>
  );
}
