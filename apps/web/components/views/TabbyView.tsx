'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ExternalLink, Loader2, RotateCcw, SquareTerminal } from 'lucide-react';
import { useT } from '../../lib/i18n';
import type { Project } from '../../types';

type Status = 'idle' | 'starting' | 'ready' | 'missing' | 'closed' | 'error' | 'unsupported' | 'web' | 'detached';
interface Rect { x: number; y: number; width: number; height: number }

const btn = 'inline-flex items-center gap-1.5 rounded-md border border-[var(--border-color)] px-2.5 py-1 text-xs text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]';

/**
 * The installed Tabby terminal in the terminal dock (Settings → Terminal → shell = Tabby): the desktop shell lays Tabby's own window over
 * the area below (see apps/desktop/src/main/tabby.ts), so this component only reports where it is.
 */
export function TabbyView({ project, onCollapse }: { project: Project | null; onCollapse?: () => void }) {
  const { t } = useT();
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [detail, setDetail] = useState('');
  const bridge = typeof window !== 'undefined' ? window.ottoDesktop?.tabby : undefined;

  // device pixels of Otto's content area (Win32 coordinates of the child window)
  const rect = useCallback((): Rect | null => {
    const el = host.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const k = window.devicePixelRatio || 1;
    return { x: r.left * k, y: r.top * k, width: r.width * k, height: r.height * k };
  }, []);

  const open = useCallback(async () => {
    const r = rect();
    if (!bridge || !r) return;
    setStatus('starting');
    const res = await bridge({ op: 'open', rect: r, cwd: project?.path });
    setStatus(res.status as Status);
    setDetail(res.detail ?? '');
  }, [bridge, rect, project?.path]);

  // start (or show) Tabby when the tab opens, hide it when the tab is left
  useEffect(() => {
    if (!bridge) { setStatus('web'); return; }
    void open();
    return () => { void bridge({ op: 'hide' }); };
    // the project folder only matters for the first open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  // another project selected while Tabby is shown: open a Tabby tab in its folder
  const firstPath = useRef(project?.path);
  useEffect(() => {
    if (!bridge || !project?.path || project.path === firstPath.current) return;
    firstPath.current = project.path;
    void open();
  }, [bridge, project?.path, open]);

  // follow the tab: window resize, sidebar / panels moving, zoom
  useEffect(() => {
    if (!bridge || status !== 'ready') return;
    let last = '';
    const sync = () => {
      const r = rect();
      if (!r) return;
      const key = [r.x, r.y, r.width, r.height].map(Math.round).join(',');
      if (key === last) return;
      last = key;
      void bridge({ op: 'bounds', rect: r }).then((res) => { if (res.status === 'closed') setStatus('closed'); });
    };
    const ro = new ResizeObserver(sync);
    if (host.current) ro.observe(host.current);
    window.addEventListener('resize', sync);
    const timer = window.setInterval(sync, 400);
    sync();
    return () => { ro.disconnect(); window.removeEventListener('resize', sync); window.clearInterval(timer); };
  }, [bridge, status, rect]);

  const detach = async () => {
    if (!bridge) return;
    await bridge({ op: 'detach' });
    setStatus('detached');
  };

  const message = (() => {
    switch (status) {
      case 'web': return t('tabby.web');
      case 'unsupported': return t('tabby.unsupported');
      case 'missing': return t('tabby.missing');
      case 'closed': return t('tabby.closed');
      case 'detached': return t('tabby.detached');
      case 'error': return `${t('tabby.error')}${detail ? `: ${detail}` : ''}`;
      default: return '';
    }
  })();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-3 py-1.5">
        <SquareTerminal size={14} className="text-[var(--accent)]" />
        <span className="text-xs font-medium text-[var(--text-primary)]">Tabby</span>
        {project && <span className="truncate text-[11px] text-[var(--text-muted)]">{project.path}</span>}
        <span className="flex-1" />
        {status === 'ready' && <button className={btn} onClick={() => void detach()} title={t('tabby.detachHint')}><ExternalLink size={12} /> {t('tabby.detach')}</button>}
        {(status === 'closed' || status === 'detached' || status === 'error') && <button className={btn} onClick={() => void open()}><RotateCcw size={12} /> {t('tabby.reopen')}</button>}
        {onCollapse && <button className={btn} onClick={onCollapse} title={t('tabby.collapse')}><ChevronDown size={12} /></button>}
      </div>
      <div ref={host} className="relative min-h-0 flex-1 bg-[var(--bg-primary)]">
        {status === 'starting' && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-[var(--text-muted)]"><Loader2 size={14} className="animate-spin" /> {t('tabby.starting')}</div>
        )}
        {message && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-xs text-[var(--text-secondary)]">
            <span className="max-w-md">{message}</span>
            {status === 'missing' && <a className={btn} href="https://tabby.sh" target="_blank" rel="noreferrer"><ExternalLink size={12} /> tabby.sh</a>}
          </div>
        )}
      </div>
    </div>
  );
}
