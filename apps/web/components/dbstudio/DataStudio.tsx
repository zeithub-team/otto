'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Database, Eye, Loader2, Plug, Plus, RefreshCw, Table2, Terminal, Trash2, X } from 'lucide-react';
import type { Project } from '../../types';
import { dbQuery, dbSchema, type DbConn, type DbSchema } from '../../lib/api';
import { detectDatabases, loadSaved, storeSaved, type SavedConn } from '../../lib/dbxapi';
import { useT } from '../../lib/i18n';
import { ConsoleTab } from './ConsoleTab';
import { TableTab } from './TableTab';

interface Source { id: string; label: string; origin: 'services' | 'env' | 'saved'; note: string; conn: DbConn }
interface Tab { id: string; source: string; kind: 'table' | 'console'; schema?: string; table?: string; title: string; text?: string }

const DEFAULT_PORT: Record<DbConn['kind'], number> = { postgres: 5432, mysql: 3306 };
const connKey = (c: DbConn) => `${c.kind}:${c.host}:${c.port}:${c.user}:${c.database}`;

interface ServiceInstance { key: string; name: string; ports?: Array<{ host: number }>; env?: Record<string, string> }

function servicesSources(projectId: number | undefined): Source[] {
  if (!projectId) return [];
  try {
    const saved = JSON.parse(window.localStorage.getItem(`otto-services:${projectId}`) ?? '{}') as { instances?: ServiceInstance[] };
    const out: Source[] = [];
    for (const inst of saved.instances ?? []) {
      const port = inst.ports?.[0]?.host;
      const env = inst.env ?? {};
      if (!port) continue;
      if (inst.key === 'postgres') out.push({ id: `svc:${inst.name}`, label: inst.name, origin: 'services', note: `PostgreSQL :${port}`, conn: { kind: 'postgres', host: '127.0.0.1', port, user: env.POSTGRES_USER ?? 'postgres', password: env.POSTGRES_PASSWORD ?? '', database: env.POSTGRES_DB ?? '' } });
      else if (inst.key === 'mysql' || inst.key === 'mariadb') {
        const p = inst.key === 'mysql' ? 'MYSQL' : 'MARIADB';
        out.push({ id: `svc:${inst.name}`, label: inst.name, origin: 'services', note: `${inst.key === 'mysql' ? 'MySQL' : 'MariaDB'} :${port}`, conn: { kind: 'mysql', host: '127.0.0.1', port, user: env[`${p}_USER`] ?? 'root', password: env[`${p}_PASSWORD`] ?? env[`${p}_ROOT_PASSWORD`] ?? '', database: env[`${p}_DATABASE`] ?? '' } });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function DataStudio({ project, onOpenServices }: { project: Project | null; onOpenServices?: () => void }) {
  const { t } = useT();
  const [detected, setDetected] = useState<Source[]>([]);
  const [saved, setSaved] = useState<SavedConn[]>([]);
  const [adding, setAdding] = useState<DbConn | null>(null);
  const [addName, setAddName] = useState('');
  const svc = useMemo(() => (typeof window === 'undefined' ? [] : servicesSources(project?.id)), [project?.id]);

  useEffect(() => { setSaved(loadSaved()); }, []);
  useEffect(() => {
    setDetected([]);
    if (!project) return;
    void detectDatabases(project.id).then((list) => setDetected(list.map((d, i) => ({ id: `env:${i}:${connKey(d.conn)}`, label: d.label, origin: 'env' as const, note: d.source, conn: d.conn }))));
  }, [project]);

  // services first (they are what the project runs), then what .env says, then the user's own; same server = one entry
  const sources = useMemo(() => {
    const seen = new Set<string>();
    const all: Source[] = [...svc, ...detected, ...saved.map((s) => ({ id: `saved:${s.id}`, label: s.name, origin: 'saved' as const, note: `${s.conn.kind === 'postgres' ? 'PostgreSQL' : 'MySQL'} :${s.conn.port}`, conn: s.conn }))];
    return all.filter((s) => { const k = `${s.conn.kind}:${s.conn.port}:${s.conn.user}:${s.conn.database}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }, [svc, detected, saved]);

  const [open, setOpen] = useState<Set<string>>(new Set());
  const [schemas, setSchemas] = useState<Record<string, DbSchema[] | 'loading' | { error: string }>>({});
  const [columns, setColumns] = useState<Record<string, Record<string, string[]>>>({});
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const consoleCount = useRef(0);

  const connectSource = useCallback(async (s: Source) => {
    setSchemas((m) => ({ ...m, [s.id]: 'loading' }));
    try {
      const list = await dbSchema(s.conn);
      setSchemas((m) => ({ ...m, [s.id]: list }));
      // completion data for the console: table → columns (plain and schema-qualified)
      try {
        const cols = await dbQuery(s.conn, s.conn.kind === 'postgres'
          ? `select table_schema, table_name, column_name from information_schema.columns where table_schema not in ('pg_catalog','information_schema') order by table_schema, table_name, ordinal_position`
          : `select table_schema, table_name, column_name from information_schema.columns where table_schema not in ('information_schema','mysql','performance_schema','sys') order by table_schema, table_name, ordinal_position`);
        const map: Record<string, string[]> = {};
        for (const [sch, tab, col] of cols.rows as string[][]) { (map[tab] ??= []).push(col); (map[`${sch}.${tab}`] ??= []).push(col); }
        setColumns((m) => ({ ...m, [s.id]: map }));
      } catch { /* completion then only knows table names */ }
    } catch (exc) {
      const text = exc instanceof Error ? exc.message : String(exc);
      setSchemas((m) => ({ ...m, [s.id]: { error: /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|timeout/i.test(text) ? t('data.notRunning') : text } }));
    }
  }, [t]);

  // everything found connects by itself: no button to press
  const tried = useRef(new Set<string>());
  useEffect(() => {
    for (const s of sources) {
      if (tried.current.has(s.id)) continue;
      tried.current.add(s.id);
      setOpen((o) => new Set(o).add(s.id));
      void connectSource(s);
    }
  }, [sources, connectSource]);

  const source = (id: string) => sources.find((s) => s.id === id);
  const openTable = (sourceId: string, schema: string, table: string) => {
    const id = `t:${sourceId}:${schema}.${table}`;
    setTabs((ts) => (ts.some((x) => x.id === id) ? ts : [...ts, { id, source: sourceId, kind: 'table', schema, table, title: table }]));
    setActiveTab(id);
  };
  const openConsole = (sourceId: string) => {
    const id = `c:${sourceId}:${++consoleCount.current}`;
    setTabs((ts) => [...ts, { id, source: sourceId, kind: 'console', title: `${t('dx.console')} ${consoleCount.current}`, text: 'select 1;' }]);
    setActiveTab(id);
  };
  const closeTab = (id: string) => setTabs((ts) => {
    const i = ts.findIndex((x) => x.id === id);
    const next = ts.filter((x) => x.id !== id);
    setActiveTab((cur) => (cur === id ? (next[Math.min(i, next.length - 1)]?.id ?? null) : cur));
    return next;
  });

  const active = tabs.find((x) => x.id === activeTab) ?? null;
  const activeSource = active ? source(active.source) : null;
  const input = 'w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]';

  return (
    <div className="relative flex min-h-0 flex-1">
      <aside className="flex w-72 shrink-0 flex-col border-r border-[var(--border-color)] bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-1.5 border-b border-[var(--border-color)] px-3 py-2.5">
          <Database size={14} className="text-[var(--accent)]" />
          <span className="flex-1 text-sm font-medium text-[var(--text-primary)]">{t('data.title')}</span>
          <button className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--accent)]" title={t('dx.rescan')} onClick={() => { tried.current.clear(); setSchemas({}); if (project) void detectDatabases(project.id).then((l) => setDetected(l.map((d, i) => ({ id: `env:${i}:${connKey(d.conn)}`, label: d.label, origin: 'env' as const, note: d.source, conn: d.conn })))); }}><RefreshCw size={13} /></button>
          <button className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--accent)]" title={t('dx.addConnection')} onClick={() => { setAdding({ kind: 'postgres', host: '127.0.0.1', port: 5432, user: '', password: '', database: '' }); setAddName(''); }}><Plus size={14} /></button>
        </div>
        <div className="px-2 pt-2"><input className={input} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('dx.filterTables')} /></div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 text-xs">
          {sources.length === 0 && (
            <div className="space-y-2 p-3 text-center text-[var(--text-muted)]">
              <p>{t('dx.noSources')}</p>
              {onOpenServices && <button className="rounded-md border border-[var(--border-color)] px-2.5 py-1 hover:border-[var(--accent)] hover:text-[var(--accent)]" onClick={onOpenServices}>{t('dx.openServices')}</button>}
            </div>
          )}
          {sources.map((s) => {
            const state = schemas[s.id];
            const isOpen = open.has(s.id);
            return (
              <div key={s.id} className="mb-1">
                <div className="group flex items-center gap-1 rounded-md px-1 py-1 hover:bg-[var(--bg-tertiary)]">
                  <button className="text-[var(--text-muted)]" onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })}>{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
                  <Database size={13} className={state && typeof state === 'object' && !Array.isArray(state) && 'error' in state ? 'text-[var(--error)]' : Array.isArray(state) ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'} />
                  <button className="min-w-0 flex-1 text-left" onDoubleClick={() => openConsole(s.id)} onClick={() => { if (!Array.isArray(state) && state !== 'loading') void connectSource(s); }}>
                    <span className="block truncate text-[var(--text-primary)]">{s.label}</span>
                    <span className="block truncate text-[10px] text-[var(--text-muted)]">{s.note} · {s.conn.user}</span>
                  </button>
                  <button className="opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-[var(--accent)]" title={t('dx.newConsole')} onClick={() => openConsole(s.id)}><Terminal size={12} /></button>
                  {s.origin === 'saved' && <button className="opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-[var(--error)]" title={t('ssh.delete')} onClick={() => { const next = saved.filter((x) => `saved:${x.id}` !== s.id); setSaved(next); storeSaved(next); }}><Trash2 size={12} /></button>}
                </div>
                {isOpen && (
                  <div className="ml-4 border-l border-[var(--border-color)] pl-2">
                    {state === 'loading' && <div className="flex items-center gap-1.5 py-1 text-[var(--text-muted)]"><Loader2 size={11} className="animate-spin" /> {t('dx.connecting')}</div>}
                    {state && typeof state === 'object' && !Array.isArray(state) && 'error' in state && (
                      <div className="py-1 text-[11px] text-[var(--error)]">{state.error}<button className="ml-2 underline" onClick={() => void connectSource(s)}>{t('dx.retry')}</button></div>
                    )}
                    {Array.isArray(state) && state.map((sch) => {
                      const tables = sch.tables.filter((tb) => !filter || tb.name.toLowerCase().includes(filter.toLowerCase()));
                      if (filter && tables.length === 0) return null;
                      return (
                        <div key={sch.schema} className="py-0.5">
                          <div className="px-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{sch.schema}</div>
                          {tables.map((tb) => (
                            <button key={tb.name} onDoubleClick={() => openTable(s.id, sch.schema, tb.name)} onClick={() => openTable(s.id, sch.schema, tb.name)}
                              className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-[var(--bg-tertiary)] ${active?.id === `t:${s.id}:${sch.schema}.${tb.name}` ? 'bg-[var(--bg-active)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                              {tb.type === 'view' ? <Eye size={11} className="shrink-0 text-[var(--text-muted)]" /> : <Table2 size={11} className="shrink-0 text-[var(--text-muted)]" />}
                              <span className="truncate">{tb.name}</span>
                            </button>
                          ))}
                          {sch.tables.length === 0 && <div className="px-1 text-[10px] text-[var(--text-muted)]">{t('dx.noTables')}</div>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center overflow-x-auto border-b border-[var(--border-color)] bg-[var(--bg-secondary)]">
          {tabs.map((tb) => (
            <div key={tb.id} className={`group flex shrink-0 items-center gap-1.5 border-r border-[var(--border-color)] px-3 py-1.5 text-xs ${tb.id === activeTab ? 'bg-[var(--bg-primary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}>
              <button className="flex items-center gap-1.5" onClick={() => setActiveTab(tb.id)}>
                {tb.kind === 'console' ? <Terminal size={11} className="text-[var(--accent)]" /> : <Table2 size={11} className="text-[var(--text-muted)]" />}
                {tb.title}<span className="text-[10px] text-[var(--text-muted)]">{source(tb.source)?.label}</span>
              </button>
              <button className="text-[var(--text-muted)] hover:text-[var(--error)]" onClick={() => closeTab(tb.id)}><X size={11} /></button>
            </div>
          ))}
        </div>
        {active && activeSource ? (
          active.kind === 'console' ? (
            <ConsoleTab key={active.id} conn={activeSource.conn} schema={columns[activeSource.id] ?? {}} text={active.text ?? ''}
              onText={(v) => setTabs((ts) => ts.map((x) => (x.id === active.id ? { ...x, text: v } : x)))} />
          ) : (
            <TableTab key={active.id} conn={activeSource.conn} schema={active.schema!} table={active.table!} onOpenTable={(sc, tb) => openTable(active.source, sc, tb)} />
          )
        ) : (
          <div className="grid flex-1 place-items-center p-8 text-center text-sm text-[var(--text-muted)]">
            <div><Plug size={28} className="mx-auto mb-3 opacity-40" />{t('dx.empty')}</div>
          </div>
        )}
      </main>

      {adding && (
        <div className="absolute inset-0 z-40 grid place-items-center bg-black/50 p-4" onClick={() => setAdding(null)}>
          <div className="w-full max-w-md space-y-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('dx.addConnection')}</h3>
            <input className={input} value={addName} onChange={(e) => setAddName(e.target.value)} placeholder={t('ssh.name')} />
            <select className={input} value={adding.kind} onChange={(e) => { const kind = e.target.value as DbConn['kind']; setAdding({ ...adding, kind, port: DEFAULT_PORT[kind] }); }}>
              <option value="postgres">PostgreSQL</option><option value="mysql">MySQL / MariaDB</option>
            </select>
            <div className="grid grid-cols-[1fr_90px] gap-2">
              <input className={input} value={adding.host} onChange={(e) => setAdding({ ...adding, host: e.target.value })} placeholder={t('ssh.host')} />
              <input className={input} type="number" value={adding.port} onChange={(e) => setAdding({ ...adding, port: Number(e.target.value) || DEFAULT_PORT[adding.kind] })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input className={input} value={adding.user} onChange={(e) => setAdding({ ...adding, user: e.target.value })} placeholder={t('ssh.user')} />
              <input className={input} type="password" value={adding.password} onChange={(e) => setAdding({ ...adding, password: e.target.value })} placeholder={t('ssh.password')} autoComplete="off" />
            </div>
            <input className={input} value={adding.database} onChange={(e) => setAdding({ ...adding, database: e.target.value })} placeholder={t('dx.database')} />
            <p className="text-[10px] text-[var(--text-muted)]">{t('dx.localOnly')}</p>
            <div className="flex gap-2">
              <button className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--on-accent)] disabled:opacity-40" disabled={!adding.user.trim()}
                onClick={() => { const entry: SavedConn = { id: crypto.randomUUID(), name: addName.trim() || `${adding.user}@${adding.host}:${adding.port}`, conn: adding }; const next = [...saved, entry]; setSaved(next); storeSaved(next); setAdding(null); }}>{t('ssh.save')}</button>
              <button className="rounded-md border border-[var(--border-color)] px-3 py-1.5 text-xs text-[var(--text-secondary)]" onClick={() => setAdding(null)}>{t('ssh.cancel')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
