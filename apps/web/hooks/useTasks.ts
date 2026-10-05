'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task, TaskRun } from '../types';
import {
  createTask,
  deleteTask,
  fetchTaskRuns,
  fetchTasks,
  startTaskAction,
  stopTaskRun,
  updateTask,
} from '../lib/api';

/**
 * Task board state for a project: top-level tasks with checklist steps, plus
 * the state of background runs (planning / stage-by-stage execution). Polls
 * quickly while a run is active so checkboxes tick as steps complete, slowly
 * otherwise to pick up tasks the AI creates from chat.
 */
export function useTasks(projectId?: number) {
  const [all, setAll] = useState<Task[]>([]);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const load = useCallback(async () => {
    if (!projectId) {
      setAll([]);
      setRuns([]);
      return;
    }
    try {
      const [rows, runRows] = await Promise.all([fetchTasks(projectId), fetchTaskRuns(projectId)]);
      if (cancelledRef.current) return;
      setAll(rows);
      setRuns(runRows);
    } catch {
      /* backend unreachable — keep the current view */
    }
  }, [projectId]);

  const busy = runs.some((r) => r.status === 'running' || r.status === 'planning');

  useEffect(() => {
    cancelledRef.current = false;
    setLoading(true);
    void load().finally(() => {
      if (!cancelledRef.current) setLoading(false);
    });
    const timer = window.setInterval(() => void load(), busy ? 2000 : 8000);
    // the agent changed the list (otto_tasks): show it right away
    const onChanged = () => void load();
    window.addEventListener('otto:tasks-changed', onChanged);
    return () => {
      cancelledRef.current = true;
      window.clearInterval(timer);
      window.removeEventListener('otto:tasks-changed', onChanged);
    };
  }, [load, busy]);

  const tasks = useMemo(() => all.filter((t) => t.parent_id === null), [all]);
  const stepsOf = useCallback(
    (taskId: number) => all.filter((t) => t.parent_id === taskId).sort((a, b) => a.id - b.id),
    [all],
  );
  const runOf = useCallback((taskId: number) => runs.find((r) => r.taskId === taskId), [runs]);

  const add = useCallback(async (title: string, detail = '') => {
    if (!projectId || !title.trim()) return;
    const task = await createTask(projectId, title.trim(), detail);
    setAll((prev) => [task, ...prev]);
  }, [projectId]);

  const addStep = useCallback(async (taskId: number, title: string) => {
    if (!projectId || !title.trim()) return;
    const step = await createTask(projectId, title.trim(), '', taskId);
    setAll((prev) => [...prev, step]);
  }, [projectId]);

  const patch = useCallback(async (taskId: number, changes: { title?: string; detail?: string; status?: Task['status']; parallel?: boolean }) => {
    const updated = await updateTask(taskId, changes);
    setAll((prev) => prev.map((t) => (t.id === taskId ? updated : t)));
  }, []);

  const remove = useCallback(async (taskId: number) => {
    setAll((prev) => prev.filter((t) => t.id !== taskId && t.parent_id !== taskId));
    try {
      await deleteTask(taskId);
    } catch {
      void load();
    }
  }, [load]);

  const cycleStatus = useCallback((task: Task) => {
    const next: Task['status'] =
      task.status === 'todo' ? 'in_progress' : task.status === 'in_progress' ? 'done' : 'todo';
    void patch(task.id, { status: next });
  }, [patch]);

  /** Checkbox: a step is either done or not. */
  const toggleStep = useCallback((step: Task) => {
    return patch(step.id, { status: step.status === 'done' ? 'todo' : 'done' });
  }, [patch]);

  /** "Run together with the step before it" on / off. */
  const toggleParallel = useCallback((step: Task) => {
    void patch(step.id, { parallel: !step.parallel });
  }, [patch]);

  const start = useCallback(async (taskId: number, action: 'run' | 'plan') => {
    setError(null);
    try {
      const run = await startTaskAction(taskId, action);
      setRuns((prev) => [...prev.filter((r) => r.taskId !== taskId), run]);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    }
  }, []);

  const stop = useCallback(async (taskId: number) => {
    await stopTaskRun(taskId);
    void load();
  }, [load]);

  return {
    tasks, stepsOf, runOf, loading, error, busy,
    add, addStep, patch, remove, cycleStatus, toggleStep, toggleParallel,
    run: (id: number) => start(id, 'run'),
    plan: (id: number) => start(id, 'plan'),
    stop,
    reload: load,
  };
}
