'use client';

import { useEffect, useState } from 'react';
import { Bot, Loader2, Pause, Play, Square } from 'lucide-react';
import { fetchTaskRuns, fetchTasks, pauseTaskRun, stopTaskRun } from '../../lib/api';
import { activityLine } from '../../lib/taskActivity';
import { useT } from '../../lib/i18n';
import type { Task, TaskRun } from '../../types';

/**
 * Sits above the chat form while a task from the task board is being carried out: which task, which step(s),
 * what the agent is doing right now and for how long, plus a way to watch the full log or stop it.
 * (The chat itself stays empty then: the steps run in the background, not as chat messages.)
 */
export function TaskRunBanner({ projectId, onOpenAgents }: { projectId?: number; onOpenAgents: () => void }) {
  const { t } = useT();
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!projectId) { setRuns([]); return; }
    let alive = true;
    const load = async () => {
      try {
        const list = (await fetchTaskRuns(projectId)).filter((r) => r.status === 'running' || r.status === 'planning');
        if (!alive) return;
        setRuns(list);
        if (list.length) setTasks(await fetchTasks(projectId));
      } catch { /* backend unreachable: keep what is shown */ }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [projectId]);

  useEffect(() => {
    if (!runs.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runs.length]);

  if (runs.length === 0) return null;
  return (
    <div className="space-y-1.5 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-2">
      {runs.map((run) => {
        const task = tasks.find((x) => x.id === run.taskId);
        const steps = tasks.filter((x) => x.parent_id === run.taskId).sort((a, b) => a.id - b.id);
        const ids = run.stepIds?.length ? run.stepIds : run.stepId ? [run.stepId] : [];
        return (
          <div key={run.taskId} className="flex items-start gap-2.5 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-glow)] px-3 py-2">
            <Loader2 size={14} className={`mt-0.5 shrink-0 ${run.paused ? '' : 'animate-spin'} text-[var(--accent)]`} data-x="" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-[var(--text-primary)]">
                {t('tasks.bannerTitle', { title: task?.title ?? '' })}
              </div>
              {ids.map((id) => {
                const index = steps.findIndex((s) => s.id === id);
                // stage name without its "[Phase]" prefix and "— после: check" tail; the live action on its own line
                const title = index >= 0 ? steps[index].title.replace(/^s*[[^]]{1,24}]s*/, '').replace(/s+[—-]s+(после|after|check)s*:.*$/i, '') : '';
                const done = steps.filter((s) => s.status === 'done').length;
                return (
                  <div key={id} className="mt-0.5">
                    {index >= 0 && (
                      <div className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
                        <span className="shrink-0 text-[var(--text-muted)]">{index + 1}/{steps.length}</span>
                        <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"><span className="block h-full bg-[var(--accent)]" style={{ width: `${Math.round((done / Math.max(1, steps.length)) * 100)}%` }} /></span>
                        <span className="truncate">{title}</span>
                      </div>
                    )}
                    <div className="truncate text-[11px] text-[var(--accent)]">{run.paused ? t('tasks.paused') : activityLine(t, run.activity?.[id], run.startedAt?.[id], now)}</div>
                  </div>
                );
              })}
            </div>
            <button onClick={onOpenAgents} className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--border-color)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]">
              <Bot size={11} /> {t('tasks.watch')}
            </button>
            <button onClick={() => void pauseTaskRun(run.taskId).then(() => fetchTaskRuns(projectId!).then((l) => setRuns(l.filter((r) => r.status === 'running' || r.status === 'planning'))))} title={run.paused ? t('tasks.resume') : t('tasks.pause')} aria-label={run.paused ? t('tasks.resume') : t('tasks.pause')} className="shrink-0 rounded-md p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-active)]">
              {run.paused ? <Play size={12} /> : <Pause size={12} />}
            </button>
            <button onClick={() => void stopTaskRun(run.taskId)} title={t('tasks.stop')} aria-label={t('tasks.stop')} className="shrink-0 rounded-md p-1 text-[var(--error)] hover:bg-[var(--error)]/10">
              <Square size={12} fill="currentColor" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
