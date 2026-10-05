'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Search } from 'lucide-react';
import { fetchQuickOpen, type QuickOpenHit } from '../../lib/api';
import { useT } from '../../lib/i18n';

interface Props {
  projectId: number;
  /** Files already open in tabs (shown first for an empty query). */
  recent: string[];
  onPick: (path: string, line?: number) => void;
  onClose: () => void;
}

/** `path/to/file.ts` with the characters matched by the query highlighted. */
function Highlighted({ path, positions }: { path: string; positions: number[] }) {
  const set = new Set(positions);
  const slash = path.lastIndexOf('/') + 1;
  const parts: Array<{ text: string; hit: boolean }> = [];
  for (let i = 0; i < path.length; i++) {
    const hit = set.has(i);
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += path[i]; else parts.push({ text: path[i], hit });
  }
  let offset = 0;
  return (
    <span className="min-w-0 truncate">
      {parts.map((p, i) => {
        const start = offset;
        offset += p.text.length;
        const inName = start >= slash;
        return <span key={i} className={`${p.hit ? 'font-semibold text-[var(--accent)]' : inName ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>{p.text}</span>;
      })}
    </span>
  );
}

/** Ctrl+P: open any file of the project by typing a few letters of its name or path (`name:42` jumps to a line). */
export function QuickOpenModal({ projectId, recent, onPick, onClose }: Props) {
  const { t } = useT();
  const [input, setInput] = useState('');
  const [hits, setHits] = useState<QuickOpenHit[]>([]);
  const [total, setTotal] = useState(0);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  const { query, line } = useMemo(() => {
    const m = /^(.*?)(?::(\d+))?$/.exec(input.trim());
    return { query: (m?.[1] ?? '').trim(), line: m?.[2] ? Number(m[2]) : undefined };
  }, [input]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      const result = await fetchQuickOpen(projectId, query, 60);
      if (mine !== seq.current) return;
      let files = result.files;
      if (!query && recent.length) {
        const known = new Set(recent);
        files = [...recent.map((p) => ({ path: p, score: 0, positions: [] as number[] })), ...files.filter((f) => !known.has(f.path))];
      }
      setHits(files);
      setTotal(result.total);
      setActive(0);
    }, 50);
    return () => clearTimeout(timer);
  }, [projectId, query, recent]);

  useEffect(() => {
    document.querySelector<HTMLElement>(`[data-qo="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = (hit: QuickOpenHit | undefined) => { if (hit) onPick(hit.path, line); };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('qo.title')}
        className="w-[640px] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-3 py-2.5">
          <Search size={15} className="shrink-0 text-[var(--accent)]" />
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); onClose(); }
              else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === 'Enter') { e.preventDefault(); pick(hits[active]); }
            }}
            placeholder={t('qo.placeholder')}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
          <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-muted)]">{total ? t('qo.count', { n: total }) : ''}</span>
        </div>
        <div className="max-h-[52vh] overflow-y-auto p-1.5">
          {hits.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">{query ? t('qo.none') : t('qo.empty')}</p>
          ) : hits.map((hit, i) => (
            <button
              key={hit.path}
              data-qo={i}
              onClick={() => pick(hit)}
              onMouseMove={() => setActive(i)}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left font-mono text-xs ${i === active ? 'bg-[var(--accent-glow)]' : 'hover:bg-[var(--bg-hover)]'}`}
            >
              <FileText size={13} className="shrink-0 text-[var(--text-muted)]" />
              <Highlighted path={hit.path} positions={hit.positions} />
            </button>
          ))}
        </div>
        <div className="flex items-center gap-4 border-t border-[var(--border-color)] px-3 py-1.5 text-[10px] text-[var(--text-muted)]">
          <span>↑↓ {t('qo.navigate')}</span><span>↵ {t('qo.open')}</span><span>Esc {t('common.close')}</span><span className="ml-auto">name:42 — {t('qo.line')}</span>
        </div>
      </div>
    </div>
  );
}
