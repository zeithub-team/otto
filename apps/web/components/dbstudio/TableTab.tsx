'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { DbConn, DbResult } from '../../lib/api';
import {
  dbxBrowse, dbxCount, dbxDeleteRow, dbxInsertRow, dbxStructure, dbxUpdateRow, download, toCsv, toJson, type TableStructure,
} from '../../lib/dbxapi';
import { useT } from '../../lib/i18n';
import { DataGrid } from './DataGrid';

const PAGE = 100;
const btn = 'inline-flex items-center gap-1.5 rounded-md border border-[var(--border-color)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40';

/** One table: data (editable), structure and DDL — the same three views DataGrip has. */
export function TableTab({ conn, schema, table, onOpenTable }: {
  conn: DbConn; schema: string; table: string; onOpenTable?: (schema: string, table: string) => void;
}) {
  const { t } = useT();
  const [view, setView] = useState<'data' | 'structure' | 'ddl'>('data');
  const [result, setResult] = useState<DbResult | null>(null);
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [applied, setApplied] = useState('');
  const [sort, setSort] = useState<{ column: string; desc: boolean } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState<Record<string, string> | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await dbxBrowse(conn, schema, table, { page, pageSize: PAGE, where: applied, orderBy: sort?.column, desc: sort?.desc });
      setResult({ ...r, rows: r.rows.slice(0, PAGE) });
      setSelected(null);
    } catch (e) { setResult(null); setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [conn, schema, table, page, applied, sort]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void dbxStructure(conn, schema, table).then(setStructure).catch(() => setStructure(null)); }, [conn, schema, table]);
  useEffect(() => { setTotal(null); void dbxCount(conn, schema, table, applied).then(setTotal).catch(() => setTotal(null)); }, [conn, schema, table, applied]);

  const pk = structure?.primaryKey ?? [];
  const editable = pk.length > 0;
  const pkOf = (row: unknown[]): Record<string, unknown> | null => {
    if (!result) return null;
    const out: Record<string, unknown> = {};
    for (const k of pk) { const i = result.columns.indexOf(k); if (i < 0) return null; out[k] = row[i]; }
    return out;
  };
  const hasMore = total !== null ? (page + 1) * PAGE < total : (result?.rowCount ?? 0) > PAGE;
  const last = total !== null ? Math.max(1, Math.ceil(total / PAGE)) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border-color)] px-3 py-1.5">
        {(['data', 'structure', 'ddl'] as const).map((v) => (
          <button key={v} onClick={() => setView(v)} className={`rounded-md px-2.5 py-1 text-xs ${view === v ? 'bg-[var(--accent-glow)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}>{t(`dx.${v}`)}</button>
        ))}
        {view === 'data' && (
          <>
            <span className="mx-1 h-4 w-px bg-[var(--border-color)]" />
            <button className={btn} onClick={() => void load()} title={t('dx.refresh')}><RefreshCw size={12} className={loading ? 'animate-spin' : ''} /></button>
            <button className={btn} disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={12} /></button>
            <span className="text-[11px] text-[var(--text-muted)]">{page + 1}{last ? ` / ${last}` : ''}{total !== null ? ` · ${total} ${t('dx.rows')}` : ''}</span>
            <button className={btn} disabled={!hasMore} onClick={() => setPage(page + 1)}><ChevronRight size={12} /></button>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { setPage(0); setApplied(filter.trim()); } }}
              placeholder={t('dx.filterPlaceholder')} className="min-w-[180px] flex-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 font-mono text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
            <button className={btn} disabled={!editable} title={editable ? undefined : t('dx.noPk')} onClick={() => setAdding({})}><Plus size={12} /> {t('dx.addRow')}</button>
            <button className={`${btn} hover:!border-[var(--error)] hover:!text-[var(--error)]`} disabled={!editable || selected === null}
              onClick={() => {
                const row = result && selected !== null ? result.rows[selected] : null;
                const key = row ? pkOf(row) : null;
                if (!key || !window.confirm(t('dx.deleteConfirm'))) return;
                void dbxDeleteRow(conn, schema, table, key).then(() => load()).catch((e) => setError(String(e.message ?? e)));
              }}><Trash2 size={12} /> {t('dx.deleteRow')}</button>
            {result && (
              <>
                <button className={btn} onClick={() => download(`${table}.csv`, toCsv(result), 'text/csv')}><Download size={12} /> CSV</button>
                <button className={btn} onClick={() => download(`${table}.json`, toJson(result), 'application/json')}><Download size={12} /> JSON</button>
              </>
            )}
          </>
        )}
      </div>
      {error && <div className="border-b border-[var(--error)]/40 bg-[var(--error)]/10 px-3 py-1.5 text-xs text-[var(--error)]">{error}</div>}
      {view === 'data' && structure && !editable && <div className="border-b border-[var(--border-color)] px-3 py-1 text-[10px] text-[var(--text-muted)]">{t('dx.readOnly')}</div>}

      {view === 'data' && adding && structure && (
        <div className="border-b border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
          <div className="mb-2 text-xs font-medium text-[var(--text-primary)]">{t('dx.newRow')}</div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {structure.columns.map((c) => (
              <label key={c.name} className="text-[10px] text-[var(--text-muted)]">{c.name} <span className="opacity-60">{c.type}{c.default ? ` = ${c.default}` : ''}</span>
                <input value={adding[c.name] ?? ''} onChange={(e) => setAdding({ ...adding, [c.name]: e.target.value })} placeholder={c.default || c.nullable ? t('dx.leaveEmpty') : ''}
                  className="mt-0.5 w-full rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 font-mono text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
              </label>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <button className="rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-[var(--on-accent)]" onClick={() => {
              const values: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(adding)) if (v !== '') values[k] = v; // empty = let the database use its default
              void dbxInsertRow(conn, schema, table, values).then(() => { setAdding(null); return load(); }).catch((e) => setError(String(e.message ?? e)));
            }}>{t('dx.insert')}</button>
            <button className={btn} onClick={() => setAdding(null)}>{t('ssh.cancel')}</button>
          </div>
        </div>
      )}

      {view === 'data' && (result ? (
        <DataGrid result={result} columns={structure?.columns} selected={selected} onSelect={setSelected}
          sort={sort} onSort={(c) => { setPage(0); setSort((s) => (s?.column === c ? (s.desc ? null : { column: c, desc: true }) : { column: c, desc: false })); }}
          onEdit={editable ? async (r, col, value) => {
            const key = pkOf(result.rows[r]);
            if (!key) throw new Error(t('dx.noPk'));
            await dbxUpdateRow(conn, schema, table, key, { [col]: value });
            await load();
          } : undefined} />
      ) : loading ? <div className="grid flex-1 place-items-center"><Loader2 className="animate-spin text-[var(--accent)]" /></div> : null)}

      {view === 'structure' && structure && (
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 text-xs">
          <section>
            <h3 className="mb-1 font-semibold text-[var(--text-primary)]">{t('dx.columns')}</h3>
            <table className="w-full border-collapse font-mono">
              <thead className="text-left text-[10px] uppercase text-[var(--text-muted)]"><tr><th className="py-1 pr-3">{t('ssh.colName')}</th><th className="pr-3">{t('dx.type')}</th><th className="pr-3">NULL</th><th className="pr-3">{t('dx.default')}</th><th>{t('dx.key')}</th></tr></thead>
              <tbody>{structure.columns.map((c) => (
                <tr key={c.name} className="border-t border-[var(--border-color)]"><td className="py-1 pr-3 text-[var(--text-primary)]">{c.name}</td><td className="pr-3 text-[var(--text-secondary)]">{c.type}</td><td className="pr-3">{c.nullable ? 'YES' : 'NO'}</td><td className="pr-3 text-[var(--text-muted)]">{c.default ?? ''}</td><td className="text-[var(--warning)]">{c.primary ? 'PK' : ''}</td></tr>
              ))}</tbody>
            </table>
          </section>
          <section>
            <h3 className="mb-1 font-semibold text-[var(--text-primary)]">{t('dx.indexes')}</h3>
            {structure.indexes.length === 0 ? <p className="text-[var(--text-muted)]">—</p> : structure.indexes.map((i) => (
              <div key={i.name} className="font-mono text-[var(--text-secondary)]">{i.name} ({i.columns.join(', ')}) {i.primary ? 'PRIMARY' : i.unique ? 'UNIQUE' : ''}</div>
            ))}
          </section>
          <section>
            <h3 className="mb-1 font-semibold text-[var(--text-primary)]">{t('dx.foreignKeys')}</h3>
            {structure.foreignKeys.length === 0 ? <p className="text-[var(--text-muted)]">—</p> : structure.foreignKeys.map((f) => (
              <div key={f.name} className="font-mono text-[var(--text-secondary)]">{f.name}: ({f.columns.join(', ')}) →{' '}
                <button className="text-[var(--accent)] hover:underline" onClick={() => onOpenTable?.(f.refSchema, f.refTable)}>{f.refSchema}.{f.refTable}</button> ({f.refColumns.join(', ')})</div>
            ))}
          </section>
        </div>
      )}
      {view === 'ddl' && structure && (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-4 font-mono text-xs text-[var(--text-secondary)] select-all">{structure.ddl}</pre>
      )}
    </div>
  );
}
