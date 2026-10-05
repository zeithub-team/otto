'use client';

import { useEffect, useState } from 'react';
import { Brain, ChevronRight, FilePlus2, FileEdit, FileX2, MonitorSmartphone } from 'lucide-react';
import { LogoMark } from '../brand/Logo';
import { useT } from '../../lib/i18n';

export interface FileChange {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  added: number;
  removed: number;
}

const MARKER = /\n*:::changes\n([\s\S]*?)\n:::\s*$/;

/** Split an assistant message into its text and the "files changed" card the agent appended. */
export function parseChanges(content: string): { text: string; files: FileChange[] } {
  const match = MARKER.exec(content);
  if (!match) return { text: content, files: [] };
  try {
    const files = JSON.parse(match[1]) as FileChange[];
    if (Array.isArray(files)) return { text: content.slice(0, match.index), files };
  } catch {
    /* half-streamed or damaged card: show the text as it is */
  }
  return { text: content.slice(0, match.index), files: [] };
}

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n));

/** Collapsible reasoning of the model. Open while it thinks, folded once the answer is there. */
export function ThinkingBlock({ content, streaming }: { content: string; streaming: boolean }) {
  const { t } = useT();
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? streaming;
  return (
    <div className="pl-9 animate-fade-in">
      <button
        type="button"
        onClick={() => setManual(!open)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
      >
        <Brain size={13} className={streaming ? 'text-[var(--accent)] animate-pulse' : ''} />
        <span>{streaming ? t('think.working') : t('think.title')}</span>
        <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="mt-1.5 ml-1.5 max-h-72 overflow-y-auto whitespace-pre-wrap border-l-2 border-[var(--border-color)] pl-3 text-xs italic leading-relaxed text-[var(--text-muted)]">
          {content.trim()}
        </div>
      )}
    </div>
  );
}

const ACTION_STYLE = {
  created: { icon: FilePlus2, color: 'var(--success, #10b981)', key: 'chg.created' },
  modified: { icon: FileEdit, color: 'var(--warning, #f59e0b)', key: 'chg.modified' },
  deleted: { icon: FileX2, color: 'var(--error, #ef4444)', key: 'chg.deleted' },
} as const;

/** The end-of-run summary: which files were created, changed or deleted, with line counts. */
export function ChangesCard({ files, onPreview }: { files: FileChange[]; onPreview?: (path: string) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(true);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)]/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--bg-hover)]"
      >
        <ChevronRight size={13} className={`shrink-0 text-[var(--text-muted)] transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="font-semibold text-[var(--text-primary)]">{t('chg.title')}</span>
        <span className="text-[var(--text-muted)]">{t('chg.count', { n: files.length })}</span>
        <span className="ml-auto tabular-nums">
          {added > 0 && <span className="text-[var(--success,#10b981)]">+{added}</span>}
          {added > 0 && removed > 0 && ' '}
          {removed > 0 && <span className="text-[var(--error,#ef4444)]">−{removed}</span>}
        </span>
      </button>
      {open && (
        <ul className="divide-y divide-[var(--border-color)] border-t border-[var(--border-color)]">
          {files.map((file) => {
            const style = ACTION_STYLE[file.action];
            const Icon = style.icon;
            return (
              <li key={file.path} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <Icon size={13} className="shrink-0" style={{ color: style.color }} />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-primary)]" title={file.path}>
                  {file.path}
                </span>
                <span className="shrink-0 rounded px-1.5 py-px text-[10px]" style={{ color: style.color, background: `color-mix(in srgb, ${style.color} 14%, transparent)` }}>
                  {t(style.key)}
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums text-[10px] text-[var(--text-muted)]">
                  {file.added > 0 && <span className="text-[var(--success,#10b981)]">+{file.added}</span>}
                  {file.added > 0 && file.removed > 0 && ' '}
                  {file.removed > 0 && <span className="text-[var(--error,#ef4444)]">−{file.removed}</span>}
                </span>
                {onPreview && file.action !== 'deleted' && /\.(html?|svg)$/i.test(file.path) && (
                  <button
                    type="button"
                    onClick={() => onPreview(file.path)}
                    className="shrink-0 rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]"
                    title={t('prev.previewFile')}
                    aria-label={t('prev.previewFile')}
                  >
                    <MonitorSmartphone size={12} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Live status while the agent works: the animated otto mark, what it does now, time and tokens. */
export function RunStatus({ startedAt, tokens, title, phase }: { startedAt: number; tokens: number; title: string; phase: string }) {
  const { t } = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const secs = Math.max(0, Math.round((now - startedAt) / 1000));
  const time = secs >= 60 ? `${Math.floor(secs / 60)}${t('unit.min')} ${String(secs % 60).padStart(2, '0')}${t('unit.sec')}` : `${secs}${t('unit.sec')}`;
  return (
    <div className="flex items-start gap-3 pl-1 animate-fade-in" role="status" aria-live="polite">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-glow)]">
        <LogoMark size={17} live />
      </div>
      <div className="min-w-0 pt-px">
        <div className="truncate text-sm font-medium text-[var(--text-primary)]">{title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs tabular-nums text-[var(--text-muted)]">
          <span>{time}</span>
          {tokens > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>{fmtTokens(tokens)} {t('run.tokens')}</span>
            </>
          )}
          {phase !== title && (
            <>
              <span aria-hidden="true">·</span>
              <span>{phase}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
