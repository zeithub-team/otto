'use client';

import { useState } from 'react';
import {
  Bot, Check, ChevronDown, ChevronRight, Circle, CircleDot, CheckCircle2, ListTodo,
  Loader2, Play, Plus, RotateCcw, Sparkles, Square, Trash2, User,
} from 'lucide-react';
import type { Task } from '../../types';
import { useTasks } from '../../hooks/useTasks';
import { useT } from '../../lib/i18n';

const STATUS_ICON = { todo: Circle, in_progress: CircleDot, done: CheckCircle2 } as const;

interface TaskPanelProps {
  projectId?: number;
  collapsed: boolean;
  onToggle: () => void;
}

export function TaskPanel({ projectId, collapsed, onToggle }: TaskPanelProps) {
  const { t } = useT();
  const board = useTasks(projectId);
  const [draft, setDraft] = useState('');
  const [doneOpen, setDoneOpen] = useState(false);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [stepDraft, setStepDraft] = useState<Record<number, string>>({});

  if (collapsed) {
    return (
      <button
        onClick={onToggle}
        title={t('tasks.show')}
        className="w-9 border-l border-[var(--border-color)] bg-[var(--bg-secondary)] flex flex-col items-center pt-3 text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
      >
        <ListTodo size={16} />
      </button>
    );
  }

  const submit = () => {
    const value = draft.trim();
    if (!value) return;
    void board.add(value);
    setDraft('');
  };

  const active = board.tasks.filter((x) => x.status !== 'done');
  const done = board.tasks.filter((x) => x.status === 'done');

  const card = (task: Task) => {
    const steps = board.stepsOf(task.id);
    const run = board.runOf(task.id);
    const running = run?.status === 'running' || run?.status === 'planning';
    const doneCount = steps.filter((s) => s.status === 'done').length;
    const expanded = open[task.id] ?? (steps.length > 0 && task.status !== 'done');
    const Icon = STATUS_ICON[task.status];
    const pct = steps.length ? Math.round((doneCount / steps.length) * 100) : 0;

    return (
      <div key={task.id} className="group rounded-lg bg-[var(--bg-tertiary)] border border-transparent hover:border-[var(--border-color)] transition-colors">
        <div className="flex items-start gap-1.5 px-2 py-1.5">
          {steps.length > 0 ? (
            <button
              onClick={() => setOpen((o) => ({ ...o, [task.id]: !expanded }))}
              className="mt-0.5 shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : (
            <button
              onClick={() => board.cycleStatus(task)}
              title={t(`tasks.status.${task.status}`)}
              className={`mt-0.5 shrink-0 transition-colors ${
                task.status === 'done' ? 'text-[var(--success)]'
                  : task.status === 'in_progress' ? 'text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--accent)]'
              }`}
            ><Icon size={14} /></button>
          )}
          <div className="min-w-0 flex-1">
            <div className={`text-xs leading-snug ${task.status === 'done' ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
              {task.title}
            </div>
            {task.detail && steps.length === 0 && (
              <div className="text-[10px] text-[var(--text-muted)] mt-0.5 line-clamp-2">{task.detail}</div>
            )}
            {steps.length > 0 && (
              <div className="flex items-center gap-1.5 mt-1">
                <div className="h-1 flex-1 rounded-full bg-[var(--bg-hover)] overflow-hidden">
                  <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-[9px] tabular-nums text-[var(--text-muted)]">{doneCount}/{steps.length}</span>
              </div>
            )}
            {/* One clear line about where the work stands */}
            {steps.length > 0 && (() => {
              const runningIds = run?.stepIds?.length ? run.stepIds : run?.stepId ? [run.stepId] : [];
              const numbers = runningIds.map((id) => steps.findIndex((s) => s.id === id) + 1).filter((n) => n > 0);
              if (running && run?.status === 'running' && numbers.length) {
                return <div className="mt-1 text-[10px] text-[var(--accent)]">{t(numbers.length > 1 ? 'tasks.runningParallel' : 'tasks.runningStep', { n: numbers.join(', '), total: steps.length })}</div>;
              }
              if (task.status === 'done' || doneCount === steps.length) return <div className="mt-1 text-[10px] text-[var(--success)]">{t('tasks.allDone')}</div>;
              if (run?.status === 'error') return <div className="mt-1 text-[10px] text-[var(--error)]">{t('tasks.failedAt', { done: doneCount, total: steps.length })}</div>;
              return <div className="mt-1 text-[10px] text-[var(--text-muted)]">{t(run?.status === 'stopped' ? 'tasks.stoppedAt' : 'tasks.notStarted', { done: doneCount, total: steps.length })}</div>;
            })()}
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            {running ? (
              <button onClick={() => void board.stop(task.id)} title={t('tasks.stop')} className="p-0.5 text-[var(--error)] hover:opacity-80">
                <Square size={12} fill="currentColor" />
              </button>
            ) : steps.some((s) => s.status !== 'done') ? (
              <button onClick={() => void board.run(task.id)} title={t('tasks.run')} className="p-0.5 text-[var(--accent)] hover:opacity-80">
                <Play size={13} fill="currentColor" />
              </button>
            ) : null}
            <button
              onClick={() => void board.remove(task.id)}
              className="p-0.5 opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-[var(--error)] transition-all"
              title={t('tasks.delete')}
            ><Trash2 size={12} /></button>
          </div>
        </div>

        {run?.status === 'planning' && (
          <div className="flex items-center gap-1.5 px-2 pb-1.5 text-[10px] text-[var(--accent)]">
            <Loader2 size={11} className="animate-spin" /> {t('tasks.planning')}
          </div>
        )}
        {run?.status === 'error' && run.error && (
          <div className="px-2 pb-1.5 text-[10px] text-[var(--error)]">
            <div className="line-clamp-3" title={run.error}>{run.error}</div>
            <button
              onClick={() => void (steps.length > 0 ? board.run(task.id) : board.plan(task.id))}
              className="mt-1 flex items-center gap-1 rounded border border-[var(--error)]/40 px-1.5 py-0.5 hover:bg-[var(--error)]/10"
            ><RotateCcw size={10} /> {t('tasks.retry')}</button>
          </div>
        )}
        {/* interrupted (app restarted, stopped) or failed earlier: the error is gone but the work is unfinished */}
        {!running && run?.status !== 'planning' && run?.status !== 'error' && steps.length > 0 && steps.some((s) => s.status !== 'done') && (
          <div className="px-2 pb-1.5">
            <button
              onClick={() => void board.run(task.id)}
              className="flex items-center gap-1 rounded border border-[var(--accent)]/40 px-1.5 py-0.5 text-[10px] text-[var(--accent)] hover:bg-[var(--accent-glow)]"
            ><RotateCcw size={10} /> {t(steps.some((s) => s.status === 'done') ? 'tasks.continue' : 'tasks.retry')}</button>
          </div>
        )}

        {expanded && (
          <div className="px-2 pb-2 space-y-0.5">
            {steps.map((step, stepIndex) => {
              const current = running && (run?.stepIds?.includes(step.id) || run?.stepId === step.id);
              const isDone = step.status === 'done';
              return (
                <div key={step.id} className="group/step flex items-start gap-1.5">
                  <button
                    onClick={() => board.toggleStep(step)}
                    disabled={current}
                    className={`mt-[3px] shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors ${
                      isDone
                        ? 'bg-[var(--accent)] border-[var(--accent)] text-[var(--on-accent)]'
                        : current ? 'border-[var(--accent)]' : 'border-[var(--text-muted)] hover:border-[var(--accent)]'
                    }`}
                    aria-label={step.title}
                  >
                    {isDone ? <Check size={10} strokeWidth={3} /> : current ? <Loader2 size={9} className="animate-spin text-[var(--accent)]" /> : null}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className={`text-[11px] leading-snug ${isDone ? 'line-through text-[var(--text-muted)]' : current ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`}>
                      {step.title}
                    </div>
                    {isDone && step.detail && (
                      <div className="text-[9px] text-[var(--text-muted)] line-clamp-2" title={step.detail}>{step.detail}</div>
                    )}
                    {isDone && !running && /файлы не менялись|файлы НЕ изменены/.test(step.detail ?? '') && (
                      <button
                        onClick={async () => { await board.toggleStep(step); void board.run(task.id); }}
                        className="mt-0.5 flex items-center gap-1 rounded border border-[var(--accent)]/40 px-1 text-[9px] text-[var(--accent)] hover:bg-[var(--accent-glow)]"
                      ><RotateCcw size={9} /> {t('tasks.retry')}</button>
                    )}
                  </div>
                  {stepIndex > 0 && !isDone && (
                    <button
                      onClick={() => board.toggleParallel(step)}
                      disabled={running}
                      className={`shrink-0 rounded px-1 text-[10px] font-bold leading-4 transition-opacity disabled:cursor-not-allowed ${step.parallel ? 'bg-[var(--accent-glow)] text-[var(--accent)] opacity-100' : 'text-[var(--text-muted)] opacity-0 group-hover/step:opacity-100 hover:text-[var(--accent)]'}`}
                      title={t(step.parallel ? 'tasks.parallelOn' : 'tasks.parallelOff')}
                      aria-pressed={Boolean(step.parallel)}
                      aria-label={t('tasks.parallelOff')}
                    >∥</button>
                  )}
                  <button
                    onClick={() => void board.remove(step.id)}
                    className="opacity-0 group-hover/step:opacity-100 text-[var(--text-muted)] hover:text-[var(--error)]"
                    title={t('tasks.delete')}
                  ><Trash2 size={10} /></button>
                </div>
              );
            })}
            <div className="flex items-center gap-1 pt-0.5">
              <Plus size={11} className="text-[var(--text-muted)] shrink-0" />
              <input
                value={stepDraft[task.id] ?? ''}
                onChange={(e) => setStepDraft((d) => ({ ...d, [task.id]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (stepDraft[task.id] ?? '').trim()) {
                    void board.addStep(task.id, stepDraft[task.id]);
                    setStepDraft((d) => ({ ...d, [task.id]: '' }));
                  }
                }}
                placeholder={t('tasks.addStep')}
                className="flex-1 min-w-0 bg-transparent text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
              />
            </div>
          </div>
        )}

        {steps.length === 0 && task.status !== 'done' && (
          <div className="flex items-center gap-1 px-2 pb-1.5">
            <button
              onClick={() => void board.plan(task.id)}
              disabled={running}
              className="flex items-center gap-1 text-[10px] text-[var(--accent)] hover:underline disabled:opacity-50"
            >
              <Sparkles size={10} /> {t('tasks.plan')}
            </button>
            <span className="text-[var(--text-muted)] text-[10px]">·</span>
            <button
              onClick={() => { setOpen((o) => ({ ...o, [task.id]: true })); }}
              className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              {t('tasks.addStepsManual')}
            </button>
          </div>
        )}

        <div className="flex items-center gap-1 px-2 pb-1 text-[9px] text-[var(--text-muted)]">
          {task.source === 'agent' ? <Bot size={9} /> : <User size={9} />}
          {task.source === 'agent' ? t('tasks.byAgent') : t('tasks.byYou')}
        </div>
      </div>
    );
  };

  return (
    <aside className="w-[280px] border-l border-[var(--border-color)] bg-[var(--bg-secondary)] flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 h-9 border-b border-[var(--border-color)]">
        <span className="text-xs font-medium text-[var(--text-primary)] flex items-center gap-1.5">
          <ListTodo size={13} className="text-[var(--accent)]" /> {t('tasks.title')}
          {board.busy && <Loader2 size={11} className="animate-spin text-[var(--accent)]" />}
        </span>
        <button onClick={onToggle} title={t('tasks.hide')} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-sm">›</button>
      </div>

      {!projectId ? (
        <div className="p-3 text-xs text-[var(--text-muted)]">{t('tasks.selectProject')}</div>
      ) : (
        <>
          <div className="p-2 border-b border-[var(--border-color)]">
            <div className="flex gap-1.5">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                placeholder={t('tasks.new')}
                className="flex-1 min-w-0 px-2 py-1 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/50 outline-none"
              />
              <button
                onClick={submit}
                disabled={!draft.trim()}
                className="shrink-0 px-1.5 rounded-md bg-[var(--accent-glow)] text-[var(--accent)] hover:bg-[var(--accent)]/20 disabled:opacity-40 transition-colors"
                title={t('common.add')}
              ><Plus size={14} /></button>
            </div>
            {board.error && <div className="mt-1 text-[10px] text-[var(--error)]">{board.error}</div>}
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {active.length === 0 && done.length === 0 ? (
              <div className="text-xs text-[var(--text-muted)] text-center py-4">{t('tasks.empty')}</div>
            ) : (
              <>
                {active.map(card)}
                {done.length > 0 && (
                  <button
                    onClick={() => setDoneOpen((v) => !v)}
                    aria-expanded={doneOpen}
                    className="flex w-full items-center gap-1 pt-2 pb-0.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    {doneOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />} {t('tasks.done')} ({done.length})
                  </button>
                )}
                {doneOpen && done.map(card)}
              </>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
