'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Cpu, Code2, MessageSquare, Brain, Image as ImageIcon, Feather,
  Download, Trash2, RefreshCw, Check, X, Loader2,
} from 'lucide-react';
import {
  fetchModelCatalog, fetchModels, pullModel, deleteModel, fetchEnvStatus, installTool,
  type CatalogModel, type PullProgress, type ToolStatus,
} from '../../lib/api';
import { AlertTriangle } from 'lucide-react';
import { fetchHardware, fitOf, parseSizeGb, type Hardware } from '../../lib/hardware';
import { useConfirm } from '../ui/Confirm';
import { useT } from '../../lib/i18n';

const TASK_META: Record<CatalogModel['task'], { label: string; icon: typeof Cpu }> = {
  code: { label: 'models.task.code', icon: Code2 },
  general: { label: 'models.task.general', icon: MessageSquare },
  reasoning: { label: 'models.task.reasoning', icon: Brain },
  vision: { label: 'models.task.vision', icon: ImageIcon },
  lightweight: { label: 'models.task.lightweight', icon: Feather },
};
const TASK_ORDER: CatalogModel['task'][] = ['general', 'code', 'reasoning', 'vision', 'lightweight'];

interface PullState {
  percent: number;
  status: string;
  error?: string;
  abort: AbortController;
}

function formatPercent(p: PullProgress): number {
  if (p.total && p.completed) return Math.min(100, Math.round((p.completed / p.total) * 100));
  return 0;
}


export function ModelsView() {
  const confirm = useConfirm();
  const { t: tr } = useT();
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [pulls, setPulls] = useState<Record<string, PullState>>({});
  const pullsRef = useRef(pulls);
  pullsRef.current = pulls;

  const refresh = useCallback(async () => {
    const [cat, inst] = await Promise.all([fetchModelCatalog(), fetchModels()]);
    setCatalog(cat);
    setInstalled(new Set(inst));
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const [hw, setHw] = useState<Hardware | null>(null);
  useEffect(() => { void fetchHardware().then(setHw); }, []);

  // Models cannot be downloaded until Ollama itself is installed
  const [ollama, setOllama] = useState<ToolStatus | null>(null);
  const [ollamaLog, setOllamaLog] = useState<string>('');
  const [ollamaBusy, setOllamaBusy] = useState(false);
  const loadOllama = useCallback(async () => {
    const tools = await fetchEnvStatus();
    setOllama(tools.find((x) => x.id === 'ollama') ?? null);
  }, []);
  useEffect(() => { void loadOllama(); }, [loadOllama]);
  const installOllama = useCallback(async () => {
    setOllamaBusy(true);
    setOllamaLog('');
    try {
      await installTool('ollama', (line) => setOllamaLog(line.slice(0, 140)));
    } catch (exc) {
      setOllamaLog(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setOllamaBusy(false);
      await loadOllama();
      await refresh();
    }
  }, [loadOllama, refresh]);
  const noOllama = ollama !== null && !ollama.installed;
  /** The model does not fit into this machine's memory: downloading it would be pointless. */
  const blocked = (m: CatalogModel): boolean => {
    const gb = parseSizeGb(m.size);
    return Boolean(hw && gb && fitOf(gb, hw).fit === 'no');
  };
  const noteOf = (m: CatalogModel): string => {
    const text = tr(`mc.${m.name}`);
    return text === `mc.${m.name}` ? m.note : text;
  };

  const install = useCallback(async (name: string) => {
    const abort = new AbortController();
    setPulls((prev) => ({ ...prev, [name]: { percent: 0, status: tr('models.starting'), abort } }));
    try {
      await pullModel(name, (p) => {
        setPulls((prev) => {
          if (!prev[name]) return prev;
          return { ...prev, [name]: { ...prev[name], percent: formatPercent(p), status: p.status } };
        });
      }, abort.signal);
      setPulls((prev) => { const n = { ...prev }; delete n[name]; return n; });
      await refresh();
    } catch (exc) {
      if (abort.signal.aborted) {
        setPulls((prev) => { const n = { ...prev }; delete n[name]; return n; });
        return;
      }
      setPulls((prev) => ({
        ...prev,
        [name]: { ...prev[name], error: exc instanceof Error ? exc.message : tr('models.pullFail') },
      }));
    }
  }, [refresh, tr]);

  const cancel = useCallback((name: string) => {
    pullsRef.current[name]?.abort.abort();
  }, []);

  const remove = useCallback(async (name: string) => {
    if (!await confirm({ title: tr('models.delTitle'), message: tr('models.delMsg', { name }), danger: true, confirmText: tr('common.delete') })) return;
    try {
      await deleteModel(name);
      await refresh();
    } catch (exc) {
      await confirm({ title: tr('common.error'), message: exc instanceof Error ? exc.message : tr('models.delFail'), alert: true, confirmText: 'OK' });
    }
  }, [refresh, confirm, tr]);

  const grouped = useMemo(() => {
    const map = new Map<CatalogModel['task'], CatalogModel[]>();
    for (const m of catalog) {
      if (!map.has(m.task)) map.set(m.task, []);
      map.get(m.task)!.push(m);
    }
    return map;
  }, [catalog]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-7xl mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Cpu size={18} className="text-[var(--accent)]" /> {tr('models.title')}
          </h1>
          <button
            onClick={() => void refresh()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)]/40 transition-colors"
          >
            <RefreshCw size={14} /> {tr('common.refresh')}
          </button>
        </div>
        <p className="text-xs text-[var(--text-muted)] mb-6">
          {tr('models.subtitle')}
        </p>

        {noOllama && (
          <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-[var(--text-primary)]">
            <AlertTriangle size={16} className="shrink-0 text-amber-400" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{tr('models.noOllama')}</div>
              <div className="text-xs text-[var(--text-muted)]">{ollamaBusy && ollamaLog ? ollamaLog : tr('models.noOllamaHint')}</div>
            </div>
            <button
              onClick={() => void installOllama()}
              disabled={ollamaBusy}
              className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--bg-primary)] hover:opacity-90 disabled:opacity-50"
            >
              {ollamaBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} {tr('models.installOllama')}
            </button>
          </div>
        )}
        {ollama?.installed && !ollama.running && (
          <div className="mb-5 flex items-center gap-2 rounded-lg border border-[var(--border-color)] px-3 py-2 text-xs text-[var(--text-muted)]">
            <AlertTriangle size={14} className="shrink-0 text-amber-400" /> {tr('models.ollamaStopped')}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-[var(--text-muted)] text-sm">
            <Loader2 size={16} className="animate-spin" /> {tr('models.loadingCatalog')}
          </div>
        ) : catalog.length === 0 ? (
          <div className="text-sm text-[var(--text-muted)] border border-dashed border-[var(--border-color)] rounded-lg p-4">
            {tr('models.catalogDown')}
          </div>
        ) : (
          <div className="grid items-start gap-x-4 gap-y-2 md:grid-cols-2 xl:grid-cols-3">
          {TASK_ORDER.filter((t) => grouped.has(t)).map((task) => {
            const meta = TASK_META[task];
            const Icon = meta.icon;
            return (
              <section key={task} className="mb-6">
                <h2 className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-2 flex items-center gap-1.5">
                  <Icon size={13} /> {tr(meta.label)}
                </h2>
                <div className="grid gap-2">
                  {grouped.get(task)!.map((m) => {
                    const isInstalled = installed.has(m.name);
                    const pull = pulls[m.name];
                    return (
                      <div
                        key={m.name}
                        className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-[var(--text-primary)] truncate" title={m.label}>{m.label}</div>
                            {/* badges on their own line: they wrap instead of squeezing the name or running under the buttons */}
                            <div className="mt-0.5 flex flex-wrap items-center gap-1 whitespace-nowrap empty:hidden">
                              {m.recommended && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-glow)] text-[var(--accent)]">{tr('models.recommended')}</span>
                              )}
                              {(() => {
                                const gb = parseSizeGb(m.size);
                                const info = hw && gb ? fitOf(gb, hw) : null;
                                if (!info || !hw || info.fit === 'gpu') return null;
                                return (
                                  <span
                                    title={tr('mp.fit.tip', { need: info.needGb, ram: hw.ramGb, vram: hw.vramGb })}
                                    className={`text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1 ${info.fit === 'no' ? 'bg-[var(--error)]/15 text-[var(--error)]' : 'bg-amber-500/15 text-amber-400'}`}
                                  ><AlertTriangle size={10} />{tr(`mp.fit.${info.fit}`)}</span>
                                );
                              })()}
                              {isInstalled && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--success)]/15 text-[var(--success)] flex items-center gap-1"><Check size={10}/>{tr('models.installed')}</span>
                              )}
                            </div>
                            <div className="text-xs text-[var(--text-muted)] line-clamp-2">{noteOf(m)}</div>
                            <div className="text-[10px] text-[var(--text-muted)] font-mono mt-0.5">{m.name} · {m.size}</div>
                          </div>
                          <div className="shrink-0 flex items-center gap-1.5">
                            {isInstalled ? (
                              <button
                                onClick={() => void remove(m.name)}
                                className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--error)]/10 transition-colors"
                                title={tr('models.deleteModel')}
                              ><Trash2 size={15} /></button>
                            ) : pull ? (
                              <button
                                onClick={() => cancel(m.name)}
                                className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--error)]/10 transition-colors"
                                title={tr('models.cancelPull')}
                              ><X size={15} /></button>
                            ) : (
                              <button
                                onClick={() => void install(m.name)}
                                disabled={noOllama || blocked(m)}
                                title={noOllama ? tr('models.noOllama') : blocked(m) ? tr('mp.fit.no') : undefined}
                                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)]/40 transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-[var(--text-secondary)] disabled:hover:border-[var(--border-color)]"
                              ><Download size={13} /> {tr('models.download')}</button>
                            )}
                          </div>
                        </div>
                        {pull && (
                          <div className="mt-2">
                            <div className="h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
                              <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${pull.percent}%` }} />
                            </div>
                            <div className={`text-[10px] mt-1 ${pull.error ? 'text-[var(--error)]' : 'text-[var(--text-muted)]'}`}>
                              {pull.error ? pull.error : `${pull.status}${pull.percent ? ` — ${pull.percent}%` : ''}`}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
          </div>
        )}
      </div>
    </div>
  );
}
