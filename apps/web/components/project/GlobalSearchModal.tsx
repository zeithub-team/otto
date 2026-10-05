'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CaseSensitive, FileSearch, Regex, ReplaceAll, Search, WholeWord, X,
} from 'lucide-react';
import {
  replaceInFiles, searchContent,
  type SearchFileResult, type SearchFlags, type SearchResponse,
} from '../../lib/api';
import { useConfirm } from '../ui/Confirm';
import { useT } from '../../lib/i18n';

export interface SearchHighlight {
  paths: string[];
  totalMatches: number;
  totalFiles: number;
}

interface GlobalSearchModalProps {
  projectId: number;
  /** PhpStorm-style: Ctrl+Alt+F opens Find, Ctrl+Alt+R opens Replace. */
  mode: 'find' | 'replace';
  onClose: () => void;
  /** Push matched files into the Explorer tree (null = reset). */
  onResults: (info: SearchHighlight | null) => void;
  onOpenFile: (path: string, line: number) => void;
}

const MASK_PRESETS = ['*', '*.{ts,tsx,js,jsx}', '*.py', 'src/**'];

/** Match highlighter with the same flags as the server search. */
function highlight(text: string, query: string, flags: SearchFlags): React.ReactNode[] {
  if (!query.trim()) return [text];
  let src = flags.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (flags.wholeWord) src = `(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])`;
  let re: RegExp;
  try {
    re = new RegExp(src, flags.caseSensitive ? 'gu' : 'gui');
  } catch {
    return [text];
  }
  const parts: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push(text.slice(last, idx));
    parts.push(
      <mark key={key++} className="bg-[var(--accent)]/30 text-[var(--text-primary)] rounded-[2px] px-px">
        {m[0]}
      </mark>,
    );
    last = idx + m[0].length;
    if (m[0] === '') break;
    if (parts.length > 40) break;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : [text];
}

export function GlobalSearchModal({ projectId, mode, onClose, onResults, onOpenFile }: GlobalSearchModalProps) {
  const confirm = useConfirm();
  const { t: tr } = useT();
  const [tab, setTab] = useState<'find' | 'replace'>(mode);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [flags, setFlags] = useState<SearchFlags>({});
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => { setTab(mode); }, [mode]);
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q || searching) return;
    const my = ++seq.current;
    setSearching(true);
    setError('');
    setSummary('');
    try {
      const r = await searchContent(projectId, q, flags);
      if (seq.current !== my) return;
      setResult(r);
      onResults({ paths: r.files.map((f) => f.path), totalMatches: r.totalMatches, totalFiles: r.totalFiles });
    } catch (exc) {
      if (seq.current !== my) return;
      setError(exc instanceof Error ? exc.message : tr('search.failed'));
      setResult(null);
    } finally {
      if (seq.current === my) setSearching(false);
    }
  }, [projectId, query, flags, searching, onResults, tr]);

  const reset = useCallback(() => {
    seq.current++;
    setQuery('');
    setReplacement('');
    setFlags({});
    setResult(null);
    setError('');
    setSummary('');
    onResults(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [onResults]);

  const doReplace = useCallback(async (
    scope: Array<{ path: string; lines?: number[] }> | undefined,
    ask: string,
  ) => {
    const q = query.trim();
    if (!q || busy) return;
    if (!await confirm({ title: tr('search.replaceTitle'), message: ask, confirmText: tr('search.replaceAll') })) return;
    setBusy(true);
    setError('');
    setSummary('');
    try {
      const r = await replaceInFiles(projectId, q, replacement, flags, scope);
      setSummary(tr('search.replaced')
        .replace('{n}', String(r.totalReplaced))
        .replace('{f}', String(r.totalFiles)));
      const fresh = await searchContent(projectId, q, flags);
      setResult(fresh);
      onResults({ paths: fresh.files.map((f) => f.path), totalMatches: fresh.totalMatches, totalFiles: fresh.totalFiles });
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : tr('search.replaceFailed'));
    } finally {
      setBusy(false);
    }
  }, [projectId, query, replacement, flags, busy, confirm, tr, onResults]);

  const replaceAll = () => {
    if (!result || !result.files.length) return;
    void doReplace(
      result.files.map((f) => ({ path: f.path })),
      tr('search.confirmAll')
        .replace('{n}', String(result.totalMatches))
        .replace('{f}', String(result.files.length)),
    );
  };

  const flagBtn = (
    active: boolean | undefined,
    onClick: () => void,
    title: string,
    Icon: typeof CaseSensitive,
  ) => (
    <button
      onClick={onClick}
      title={title}
      className={`p-1.5 rounded-md transition-colors ${
        active
          ? 'bg-[var(--accent-glow)] text-[var(--accent)]'
          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
      }`}
    >
      <Icon size={15} />
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] bg-black/40" onMouseDown={onClose}>
      <div
        className="w-[640px] max-w-[92vw] max-h-[76vh] flex flex-col rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* tabs */}
        <div className="flex items-center gap-1 px-3 pt-2">
          {(['find', 'replace'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded-t-lg text-sm transition-colors ${
                tab === t
                  ? 'bg-[var(--bg-tertiary)] text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {t === 'find' ? tr('search.find') : tr('search.replaceAll')}
            </button>
          ))}
          <span className="flex-1" />
          <button
            onClick={reset}
            title={tr('search.reset')}
            className="px-2 py-1 rounded-md text-xs text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            {tr('search.reset')}
          </button>
          <button onClick={onClose} className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--bg-hover)]" title="Esc">
            <X size={14} />
          </button>
        </div>

        {/* query */}
        <div className="px-3 py-2 bg-[var(--bg-tertiary)] space-y-2">
          <div className="flex items-center gap-1.5">
            <div className="flex items-center gap-1.5 flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-[var(--bg-primary)] border border-[var(--border-color)] focus-within:border-[var(--accent)]/50">
              <Search size={14} className="text-[var(--text-muted)] shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runSearch();
                  if (e.key === 'Escape') onClose();
                }}
                placeholder={tr('search.queryPh')}
                spellCheck={false}
                autoComplete="off"
                className="flex-1 min-w-0 bg-transparent text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
              />
            </div>
            {flagBtn(flags.caseSensitive, () => setFlags((f) => ({ ...f, caseSensitive: !f.caseSensitive })), tr('search.matchCase'), CaseSensitive)}
            {flagBtn(flags.wholeWord, () => setFlags((f) => ({ ...f, wholeWord: !f.wholeWord })), tr('search.words'), WholeWord)}
            {flagBtn(flags.regex, () => setFlags((f) => ({ ...f, regex: !f.regex })), tr('search.regex'), Regex)}
            <button
              onClick={() => void runSearch()}
              disabled={searching || !query.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-[var(--accent-glow)] text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors disabled:opacity-40"
            >
              <FileSearch size={14} /> {tr('search.find')}
            </button>
          </div>
          {tab === 'replace' && (
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-1.5 flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-[var(--bg-primary)] border border-[var(--border-color)] focus-within:border-[var(--accent)]/50">
                <ReplaceAll size={14} className="text-[var(--text-muted)] shrink-0" />
                <input
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') replaceAll();
                    if (e.key === 'Escape') onClose();
                  }}
                  placeholder={tr('search.replacePh')}
                  spellCheck={false}
                  autoComplete="off"
                  className="flex-1 min-w-0 bg-transparent text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
                />
              </div>
              <button
                onClick={replaceAll}
                disabled={busy || searching || !result?.files.length || !query.trim()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-[var(--error)]/15 border border-[var(--error)]/40 text-[var(--error)] hover:bg-[var(--error)]/25 transition-colors disabled:opacity-40"
              >
                <ReplaceAll size={14} /> {tr('search.replaceAll')}
              </button>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <input
              value={flags.mask ?? ''}
              onChange={(e) => setFlags((f) => ({ ...f, mask: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runSearch();
                if (e.key === 'Escape') onClose();
              }}
              placeholder={tr('search.maskPh')}
              spellCheck={false}
              autoComplete="off"
              className="w-44 px-2.5 py-1 rounded-md font-mono text-xs bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-secondary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]/50"
            />
            {MASK_PRESETS.map((m) => (
              <button
                key={m}
                onClick={() => setFlags((f) => ({ ...f, mask: m }))}
                className={`px-2 py-1 rounded-md font-mono text-[11px] border transition-colors ${
                  (flags.mask ?? '') === m
                    ? 'border-[var(--accent)]/40 bg-[var(--accent-glow)] text-[var(--accent)]'
                    : 'border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* status */}
        {(error || summary || result) && (
          <div className="px-4 py-1.5 text-xs border-t border-[var(--border-color)]">
            {error && <span className="text-[var(--error)]">{error}</span>}
            {!error && summary && <span className="text-[var(--accent)]">{summary}</span>}
            {!error && !summary && result && (
              <span className="text-[var(--text-muted)]">
                {tr('search.results')
                  .replace('{n}', String(result.totalMatches))
                  .replace('{f}', String(result.totalFiles))}
                {result.truncated && ` — ${tr('search.truncated')}`}
              </span>
            )}
          </div>
        )}

        {/* results */}
        <div className="flex-1 min-h-[120px] overflow-y-auto px-3 py-2">
          {searching && (
            <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] py-3">
              <div className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
              {tr('search.find')}…
            </div>
          )}
          {!searching && result && result.files.length === 0 && (
            <div className="text-sm text-[var(--text-muted)] py-3">{tr('search.noResults')}</div>
          )}
          {!searching && !result && !error && (
            <div className="text-sm text-[var(--text-muted)] py-3">{tr('search.modalHint')}</div>
          )}
          {result?.files.map((f: SearchFileResult) => (
            <div key={f.path} className="mb-2">
              <div className="flex items-center gap-1.5 py-0.5">
                <span className="font-mono text-xs text-[var(--accent)] truncate">{f.path}</span>
                <span className="text-[11px] text-[var(--text-muted)] shrink-0">({f.matches.length})</span>
                {tab === 'replace' && (
                  <button
                    onClick={() => void doReplace(
                      [{ path: f.path }],
                      tr('search.confirmFile')
                        .replace('{n}', String(f.matches.length))
                        .replace('{f}', f.path),
                    )}
                    disabled={busy}
                    className="ml-auto px-2 py-0.5 rounded-md text-[11px] text-[var(--error)] hover:bg-[var(--error)]/15 border border-transparent hover:border-[var(--error)]/40 transition-colors disabled:opacity-40"
                  >
                    {tr('search.replaceInFile')}
                  </button>
                )}
              </div>
              {f.matches.map((m, i) => (
                <div
                  key={`${m.line}:${m.col}:${i}`}
                  className="flex items-start gap-2 pl-4 pr-2 py-0.5 rounded text-[13px] group hover:bg-[var(--bg-hover)]"
                >
                  <button
                    onClick={() => onOpenFile(f.path, m.line)}
                    className="font-mono text-[11px] text-[var(--text-muted)] hover:text-[var(--accent)] shrink-0 w-14 text-right pt-[2px]"
                  >
                    {m.line}:{m.col}
                  </button>
                  <button
                    onClick={() => onOpenFile(f.path, m.line)}
                    className="font-mono text-xs text-[var(--text-primary)] whitespace-pre-wrap break-all flex-1 min-w-0 text-left"
                  >
                    {highlight(m.text, query, flags)}
                  </button>
                  {tab === 'replace' && (
                    <button
                      onClick={() => void doReplace(
                        [{ path: f.path, lines: [m.line] }],
                        tr('search.confirmOne')
                          .replace('{f}', f.path)
                          .replace('{l}', String(m.line)),
                      )}
                      disabled={busy}
                      title={tr('search.replaceOne')}
                      className="shrink-0 px-1.5 py-0.5 rounded text-[11px] text-[var(--error)] opacity-0 group-hover:opacity-100 hover:bg-[var(--error)]/15 transition-all disabled:opacity-40"
                    >
                      {tr('search.replace')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
