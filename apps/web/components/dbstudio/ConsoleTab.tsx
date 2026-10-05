'use client';

import { useRef, useState } from 'react';
import { Download, History, Loader2, Play, Search } from 'lucide-react';
import { dbQuery, type DbConn, type DbResult } from '../../lib/api';
import { dbxCheck, dbxExplain, download, loadHistory, pushHistory, statementAt, toCsv, toJson } from '../../lib/dbxapi';
import { useT } from '../../lib/i18n';
import { DataGrid } from './DataGrid';
import { SqlEditorBox, type SqlEditorHandle } from './SqlEditorBox';

const btn = 'inline-flex items-center gap-1.5 rounded-md border border-[var(--border-color)] px-2.5 py-1 text-xs text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40';

/** SQL console: run the statement under the cursor or the selection (Ctrl+Enter), EXPLAIN, history, export. */
export function ConsoleTab({ conn, schema, text, onText }: {
  conn: DbConn; schema: Record<string, string[]>; text: string; onText: (v: string) => void;
}) {
  const { t } = useT();
  const editor = useRef<SqlEditorHandle | null>(null);
  const [result, setResult] = useState<DbResult | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>(() => (typeof window === 'undefined' ? [] : loadHistory()));
  const [showHistory, setShowHistory] = useState(false);
  const [note, setNote] = useState('');

  const run = async (mode: 'run' | 'explain') => {
    const e = editor.current;
    if (!e || running) return;
    const { from, to } = e.getRange();
    const statement = statementAt(e.getValue(), from, to);
    if (!statement) return;
    setRunning(true); setError(''); setNote('');
    try {
      const r = mode === 'explain' ? await dbxExplain(conn, statement) : await dbQuery(conn, statement);
      setResult(r);
      setNote(r.columns.length ? t('dx.rowsIn', { n: r.rowCount, ms: r.ms }) + (r.truncated ? ` · ${t('dx.truncated')}` : '') : t('dx.affected', { n: r.rowCount, ms: r.ms }));
      if (mode === 'run') setHistory(pushHistory(statement));
    } catch (exc) { setResult(null); setError(exc instanceof Error ? exc.message : String(exc)); }
    finally { setRunning(false); }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-[var(--border-color)] px-3 py-1.5">
        <button className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-[var(--on-accent)] disabled:opacity-40" disabled={running} onClick={() => void run('run')}>
          {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} {t('dx.run')} <span className="opacity-70">Ctrl+↵</span>
        </button>
        <button className={btn} disabled={running} onClick={() => void run('explain')}><Search size={12} /> EXPLAIN</button>
        <div className="relative">
          <button className={btn} onClick={() => setShowHistory((v) => !v)}><History size={12} /> {t('dx.history')}</button>
          {showHistory && (
            <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-[420px] overflow-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-1 shadow-xl">
              {history.length === 0 && <div className="p-3 text-center text-[11px] text-[var(--text-muted)]">{t('dx.noHistory')}</div>}
              {history.map((h, i) => (
                <button key={i} className="block w-full truncate rounded px-2 py-1 text-left font-mono text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]" title={h}
                  onClick={() => { onText(h); setShowHistory(false); }}>{h.replace(/\s+/g, ' ')}</button>
              ))}
            </div>
          )}
        </div>
        <span className="ml-2 text-[11px] text-[var(--text-muted)]">{note}</span>
        {result && result.columns.length > 0 && (
          <span className="ml-auto flex gap-1.5">
            <button className={btn} onClick={() => download('result.csv', toCsv(result), 'text/csv')}><Download size={12} /> CSV</button>
            <button className={btn} onClick={() => download('result.json', toJson(result), 'application/json')}><Download size={12} /> JSON</button>
          </span>
        )}
      </div>
      <div className="h-[38%] min-h-[110px] border-b border-[var(--border-color)]">
        <SqlEditorBox value={text} kind={conn.kind} schema={schema} onChange={onText} onRun={() => void run('run')} handle={editor} check={(sql) => dbxCheck(conn, sql)} />
      </div>
      {error && <div className="whitespace-pre-wrap border-b border-[var(--error)]/40 bg-[var(--error)]/10 px-3 py-2 font-mono text-xs text-[var(--error)]">{error}</div>}
      {result ? (result.columns.length ? <DataGrid result={result} /> : <div className="p-4 text-xs text-[var(--text-secondary)]">{note}</div>)
        : !error && <div className="grid flex-1 place-items-center text-xs text-[var(--text-muted)]">{t('dx.consoleHint')}</div>}
    </div>
  );
}
