'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, KeyRound } from 'lucide-react';
import type { DbResult } from '../../lib/api';
import type { ColumnInfo } from '../../lib/dbxapi';
import { useT } from '../../lib/i18n';

const show = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Result table. With `onEdit` the cells can be changed in place (double click), like in DataGrip. */
export function DataGrid({ result, columns, selected, onSelect, sort, onSort, onEdit, dirty }: {
  result: DbResult;
  /** Structure info: marks key columns and gives types as tooltips. */
  columns?: ColumnInfo[];
  selected?: number | null;
  onSelect?: (row: number) => void;
  sort?: { column: string; desc: boolean } | null;
  onSort?: (column: string) => void;
  /** Commit an edit: row index, column name, new value (null = SQL NULL). Reject to keep the editor open. */
  onEdit?: (row: number, column: string, value: string | null) => Promise<void>;
  dirty?: Set<string>;
}) {
  const { t } = useT();
  const [editing, setEditing] = useState<{ row: number; col: number; text: string } | null>(null);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, [editing?.row, editing?.col]);
  useEffect(() => { setEditing(null); setError(''); }, [result]);

  const info = (name: string): ColumnInfo | undefined => columns?.find((c) => c.name === name);
  const commit = async (value: string | null) => {
    if (!editing || !onEdit) return;
    try { await onEdit(editing.row, result.columns[editing.col], value); setEditing(null); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {error && <div className="sticky left-0 top-0 z-20 border-b border-[var(--error)]/40 bg-[var(--error)]/10 px-3 py-1 text-[11px] text-[var(--error)]">{error}</div>}
      <table className="min-w-full border-collapse font-mono text-xs">
        <thead className="sticky top-0 z-10 bg-[var(--bg-secondary)]">
          <tr>
            <th className="w-10 border-b border-[var(--border-color)] px-2 py-1.5 text-right font-normal text-[var(--text-muted)]">#</th>
            {result.columns.map((c, i) => {
              const ci = info(c);
              return (
                <th key={`${c}-${i}`} title={ci ? `${ci.type}${ci.nullable ? '' : ' NOT NULL'}${ci.default ? ` default ${ci.default}` : ''}${ci.comment ? `\n${ci.comment}` : ''}` : undefined}
                  onClick={() => onSort?.(c)}
                  className={`whitespace-nowrap border-b border-l border-[var(--border-color)] px-2.5 py-1.5 text-left font-semibold text-[var(--text-primary)] ${onSort ? 'cursor-pointer hover:bg-[var(--bg-tertiary)]' : ''}`}>
                  <span className="inline-flex items-center gap-1">
                    {ci?.primary && <KeyRound size={10} className="text-[var(--warning)]" />}
                    {c}
                    {sort?.column === c && (sort.desc ? <ArrowDown size={10} /> : <ArrowUp size={10} />)}
                    {ci && <span className="text-[9px] font-normal text-[var(--text-muted)]">{ci.type.replace(/\(.*\)/, '')}</span>}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, r) => (
            <tr key={r} onClick={() => onSelect?.(r)} className={selected === r ? 'bg-[var(--accent-glow)]' : 'hover:bg-[var(--bg-hover)]'}>
              <td className="border-b border-[var(--border-color)] px-2 py-1 text-right text-[var(--text-muted)]">{r + 1}</td>
              {row.map((v, c) => {
                const isEditing = editing?.row === r && editing.col === c;
                return (
                  <td key={c} onDoubleClick={() => { if (onEdit) setEditing({ row: r, col: c, text: show(v) }); }}
                    className={`max-w-[360px] border-b border-l border-[var(--border-color)] px-2.5 py-1 text-[var(--text-secondary)] ${dirty?.has(`${r}:${c}`) ? 'bg-[var(--warning)]/15' : ''} ${isEditing ? 'p-0' : 'truncate'}`}>
                    {isEditing ? (
                      <div className="flex items-center">
                        <input ref={inputRef} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Enter') void commit(editing.text); else if (e.key === 'Escape') { setEditing(null); setError(''); } }}
                          className="min-w-[140px] flex-1 border border-[var(--accent)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none" />
                        <button onMouseDown={(e) => e.preventDefault()} onClick={() => void commit(null)} title={t('dx.setNull')} className="border border-[var(--border-color)] bg-[var(--bg-secondary)] px-1.5 py-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--accent)]">NULL</button>
                      </div>
                    ) : v === null || v === undefined ? <span className="italic text-[var(--text-muted)]">NULL</span> : (
                      <span title={show(v).length > 60 ? show(v) : undefined}>{show(v).length > 200 ? `${show(v).slice(0, 200)}…` : show(v)}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
          {result.rows.length === 0 && <tr><td colSpan={result.columns.length + 1} className="p-6 text-center text-[var(--text-muted)]">{t('dx.noRows')}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
