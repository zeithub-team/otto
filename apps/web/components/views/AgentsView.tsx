'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Play, Square, Trash2, Loader2, ChevronDown, ChevronRight, Check, AlertTriangle, Wrench, MessageSquare, ListChecks, FolderOpen, Terminal } from 'lucide-react';
import type { Project, AgentRun } from '../../types';
import { startAgent, fetchAgents, stopAgent, deleteAgent, fetchModels } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { getProjectModel, setProjectModel, type ModelChanged } from '../../lib/modelStore';
import { renderMarkdown } from './ChatView';
import { ChangesCard } from './RunBlocks';

const STATUS: Record<AgentRun['status'], { label: string; cls: string }> = {
  running: { label: 'ag.running', cls: 'bg-[var(--accent-glow)] text-[var(--accent)]' },
  done: { label: 'ag.done', cls: 'bg-[var(--success)]/15 text-[var(--success)]' },
  error: { label: 'ag.error', cls: 'bg-[var(--error)]/15 text-[var(--error)]' },
  stopped: { label: 'ag.stopped', cls: 'bg-[var(--bg-active)] text-[var(--text-muted)]' },
};

/** Who started the run: the Agents tab, a task step, or a chat. */
function Origin({ a }: { a: AgentRun }) {
  const { t } = useT();
  const kind = a.origin?.kind ?? (a.source === 'task' ? 'task' : 'agents');
  const Icon = kind === 'chat' ? MessageSquare : kind === 'task' ? ListChecks : Bot;
  const label = kind === 'chat' ? t('ag.fromChat') : kind === 'task' ? t('ag.fromTask') : t('ag.fromAgents');
  return (
    <span className="flex shrink-0 items-center gap-1 rounded bg-[var(--accent-glow)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]" title={a.origin?.label ?? label}>
      <Icon size={10} />{kind === 'chat' && a.origin?.label ? a.origin.label : label}
    </span>
  );
}

/** What the run did: files, commands, number of tool calls. */
function WorkSummary({ a }: { a: AgentRun }) {
  const { t } = useT();
  const w = a.work;
  if (!w || (!w.files.length && !w.commands.length && !w.tools)) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-secondary)]">
        <span>{t('ag.files')}: <b className="text-[var(--text-primary)]">{w.files.length}</b></span>
        <span>{t('ag.commands')}: <b className="text-[var(--text-primary)]">{w.commands.length}</b></span>
        <span>{t('ag.tools')}: <b className="text-[var(--text-primary)]">{w.tools}</b></span>
      </div>
      {w.files.length > 0 && (
        <ChangesCard files={w.files.map((f) => ({ ...f, added: 0, removed: 0 }))} onPreview={(file) => window.dispatchEvent(new CustomEvent('otto:preview-file', { detail: { path: file } }))} />
      )}
      {w.commands.length > 0 && (
        <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] p-2 space-y-0.5">
          {w.commands.slice(-8).map((c, i) => <div key={i} className="flex items-start gap-1.5 font-mono text-[10px] text-[var(--text-secondary)]"><Terminal size={10} className="mt-0.5 shrink-0" />{c}</div>)}
        </div>
      )}
    </div>
  );
}

export function AgentsView({ project }: { project: Project | null }) {
  const { t } = useT();
  const [agents, setAgents] = useState<AgentRun[]>([]);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<string>('');
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [logs, setLogs] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);
  const anyRunning = agents.some((a) => a.status === 'running');

  const refresh = useCallback(async () => {
    if (!project && !all) { setAgents([]); return; }
    setAgents(await fetchAgents(project?.id ?? 0, all));
  }, [project, all]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void fetchModels().then(setModels); }, []);
  // background agents use the model chosen for the project (the same one as the chat)
  useEffect(() => {
    setModel(getProjectModel(project?.id) ?? '');
    const changed = (e: Event) => {
      const d = (e as CustomEvent<ModelChanged>).detail;
      if (d?.model && (d.projectId ?? null) === (project?.id ?? null)) setModel(d.model);
    };
    window.addEventListener('otto:model-changed', changed);
    return () => window.removeEventListener('otto:model-changed', changed);
  }, [project?.id]);

  // Poll while any agent is running (live logs).
  const runningRef = useRef(anyRunning);
  runningRef.current = anyRunning;
  // (task steps and chat runs show up here too, so the list is also checked while idle)
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), runningRef.current ? 2000 : 5000);
    return () => window.clearInterval(timer);
  }, [refresh, anyRunning]);

  const launch = async () => {
    if (!project || !prompt.trim() || busy) return;
    setBusy(true); setError('');
    try {
      await startAgent(project.id, prompt.trim(), undefined, model || null);
      setPrompt('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('ag.launchFail'));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (set: typeof setExpanded, id: string) => set((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  if (!project && !all) return <div className="flex-1 grid place-items-center text-[var(--text-muted)]">{t('ag.pickProject')}</div>;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2"><Bot size={18} className="text-[var(--accent)]" /> {t('ag.title')}</h1>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">{t('ag.subtitle')}</p>
          </div>
          <label className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--text-secondary)]">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />{t('ag.allProjects')}
          </label>
        </div>

        {/* Launch form */}
        {project && (
          <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 space-y-2">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void launch(); } }}
              placeholder={t('ag.placeholder')}
              rows={2}
              className="w-full rounded-lg bg-[var(--bg-primary)] border border-[var(--border-color)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent)]/50 resize-none"
            />
            <div className="flex items-center gap-2">
              <select
                value={model}
                onChange={(e) => { setModel(e.target.value); if (e.target.value) setProjectModel(project.id, e.target.value); }}
                className="rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs max-w-[200px]"
              >
                <option value="">{t('ag.modelAuto')}</option>
                {model && !models.includes(model) && <option value={model}>{model}</option>}
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <button onClick={() => void launch()} disabled={!prompt.trim() || busy} className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--accent)] text-[var(--on-accent)] text-sm font-medium disabled:opacity-40">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} {t('ag.launch')}
              </button>
            </div>
            {error && <div className="text-xs text-[var(--error)]">{error}</div>}
            <div className="text-[10px] text-[var(--text-muted)]">{t('ag.hint')}</div>
          </div>
        )}

        {/* Runs */}
        {agents.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--border-color)] p-6 text-sm text-[var(--text-muted)] text-center">{t('ag.none')}</div>
        ) : agents.map((a) => {
          const open = expanded.has(a.id) || a.status === 'running';
          const st = STATUS[a.status];
          const w = a.work;
          return (
            <div key={a.id} className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2.5">
                <button onClick={() => toggle(setExpanded, a.id)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] shrink-0">{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
                {a.status === 'running' ? <Loader2 size={15} className="animate-spin text-[var(--accent)] shrink-0" /> : a.status === 'done' ? <Check size={15} className="text-[var(--success)] shrink-0" /> : a.status === 'error' ? <AlertTriangle size={15} className="text-[var(--error)] shrink-0" /> : <Square size={13} className="text-[var(--text-muted)] shrink-0" />}
                <Origin a={a} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-[var(--text-primary)] truncate" title={a.prompt}>{a.title}</span>
                  <span className="flex flex-wrap gap-x-2 text-[10px] text-[var(--text-muted)]">
                    {(all || a.projectName) && a.projectName && <span className="flex items-center gap-0.5"><FolderOpen size={9} />{a.projectName}</span>}
                    {a.origin?.kind === 'task' && a.origin.label && <span className="truncate">{a.origin.label}</span>}
                    {a.model && <span>{a.model}</span>}
                    {a.status !== 'running' && w && (w.files.length > 0 || w.commands.length > 0) && <span>· {t('ag.files')} {w.files.length} · {t('ag.commands')} {w.commands.length}</span>}
                  </span>
                </span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${st.cls}`}>{t(st.label)}</span>
                {a.status === 'running' && <button onClick={() => void stopAgent(a.id).then(refresh)} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--error)]" title={t('ag.stop')}><Square size={13} /></button>}
                {a.origin?.kind !== 'chat' && <button onClick={() => void deleteAgent(a.id).then(refresh)} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--error)]" title={t('common.delete')}><Trash2 size={13} /></button>}
              </div>
              {open && (
                <div className="border-t border-[var(--border-color)] p-3 space-y-2.5">
                  {(a.summary ?? a.content) && (
                    <div className="text-sm text-[var(--text-primary)] rounded-lg bg-[var(--bg-tertiary)] p-2.5 max-h-72 overflow-auto space-y-0.5">{renderMarkdown(a.summary ?? a.content)}</div>
                  )}
                  <WorkSummary a={a} />
                  {a.error && <div className="text-xs text-[var(--error)]">{a.error}</div>}
                  {a.log.length > 0 && (
                    <>
                      <button onClick={() => toggle(setLogs, a.id)} className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1.5">
                        {logs.has(a.id) ? <ChevronDown size={11} /> : <ChevronRight size={11} />}<Wrench size={11} /> {t('ag.actions')} · {a.log.length}
                      </button>
                      {logs.has(a.id) && (
                        <div className="rounded-lg bg-[var(--bg-primary)] border border-[var(--border-color)] p-2 max-h-52 overflow-auto space-y-0.5">
                          {a.log.map((l, i) => (
                            <div key={i} className={`text-[10px] font-mono ${l.kind === 'error' ? 'text-[var(--error)]' : l.kind === 'tool' ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'}`}>{l.text}</div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
