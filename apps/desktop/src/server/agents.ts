/**
 * Background agent runner — autonomous file-working agents on free (Ollama)
 * models. Each run drives the same tool loop as the chat (read/search/write
 * files, create tasks) but headless, streaming its activity into an in-memory
 * log. Multiple runs execute concurrently.
 */
import { randomUUID } from 'crypto';
import type { Db } from './db';
import { generateResponse } from './ollama';
import { parseStep } from './steps';
import { isDirectory, resolvePath } from './paths';

export type AgentStatus = 'running' | 'done' | 'error' | 'stopped';

export interface LogEntry { ts: number; kind: 'tool' | 'note' | 'error'; text: string }

export interface AgentRun {
  id: string;
  projectId: number;
  title: string;
  prompt: string;
  model: string | null;
  status: AgentStatus;
  content: string;
  log: LogEntry[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
  stopped: boolean;
  /** Who started it: the Agents tab, or the task board running a step. */
  source: 'agent' | 'task';
  /** Stopping a task step stops the whole task run. */
  onStop?: () => void;
}

const runs = new Map<string, AgentRun>();

/** Public (serialisable) view of a run. */
function view(r: AgentRun) {
  return {
    id: r.id, projectId: r.projectId, title: r.title, prompt: r.prompt, model: r.model,
    status: r.status, content: r.content, log: r.log, error: r.error,
    createdAt: r.createdAt, updatedAt: r.updatedAt, source: r.source,
  };
}

/** Handle for work done by another module (the task runner) that should show up in the Agents tab. */
export interface ExternalRun {
  id: string;
  log(kind: LogEntry['kind'], text: string): void;
  setContent(text: string): void;
  isStopped(): boolean;
  finish(status: 'done' | 'error' | 'stopped', error?: string): void;
}

/** Show a run driven elsewhere (a task step) in the Agents tab, with its live log. */
export function registerRun(opts: { projectId: number; title: string; prompt: string; model: string | null; onStop?: () => void }): ExternalRun {
  const now = Date.now();
  const run: AgentRun = {
    id: randomUUID(),
    projectId: opts.projectId,
    title: opts.title.slice(0, 120),
    prompt: opts.prompt.slice(0, 2000),
    model: opts.model,
    status: 'running',
    content: '',
    log: [{ ts: now, kind: 'note', text: 'Этап задачи запущен' }],
    error: null,
    createdAt: now,
    updatedAt: now,
    stopped: false,
    source: 'task',
    onStop: opts.onStop,
  };
  runs.set(run.id, run);
  // keep the list short: the oldest finished task-step runs go first
  const finished = [...runs.values()].filter((r) => r.source === 'task' && r.status !== 'running').sort((a, b) => a.createdAt - b.createdAt);
  for (const old of finished.slice(0, Math.max(0, finished.length - 30))) runs.delete(old.id);
  return {
    id: run.id,
    log: (kind, text) => { run.log.push({ ts: Date.now(), kind, text: text.slice(0, 400) }); run.updatedAt = Date.now(); },
    setContent: (text) => { run.content = text; run.updatedAt = Date.now(); },
    isStopped: () => run.stopped,
    finish: (status, error) => {
      if (run.status !== 'running') return;
      run.status = status;
      if (error) { run.error = error; run.log.push({ ts: Date.now(), kind: 'error', text: error }); }
      else run.log.push({ ts: Date.now(), kind: 'note', text: status === 'done' ? 'Готово' : 'Остановлено' });
      run.updatedAt = Date.now();
    },
  };
}

export function listAgents(projectId?: number) {
  return Array.from(runs.values())
    .filter((r) => projectId === undefined || r.projectId === projectId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(view);
}

export function getAgent(id: string) {
  const r = runs.get(id);
  return r ? view(r) : null;
}

export function stopAgent(id: string): boolean {
  const r = runs.get(id);
  if (!r) return false;
  if (r.status === 'running') {
    r.stopped = true;
    r.status = 'stopped';
    r.updatedAt = Date.now();
    r.onStop?.();
  }
  return true;
}

export function deleteAgent(id: string): boolean {
  const r = runs.get(id);
  if (r && r.status === 'running') { r.stopped = true; r.onStop?.(); }
  return runs.delete(id);
}

/** Start an agent run in the background; returns its initial view. */
export function startAgent(
  deps: { db: Db; workspaceRoot: string },
  opts: { projectId: number; prompt: string; title?: string; model?: string | null },
) {
  const projectPathRaw = deps.db.getProjectPath(opts.projectId);
  const projectPath = projectPathRaw ? resolvePath(projectPathRaw) : null;
  if (!projectPath || !isDirectory(projectPath)) {
    throw new Error('Project folder not found');
  }

  const now = Date.now();
  const run: AgentRun = {
    id: randomUUID(),
    projectId: opts.projectId,
    title: (opts.title || opts.prompt).slice(0, 80),
    prompt: opts.prompt,
    model: opts.model ?? null,
    status: 'running',
    content: '',
    log: [{ ts: now, kind: 'note', text: 'Агент запущен' }],
    error: null,
    createdAt: now,
    updatedAt: now,
    stopped: false,
    source: 'agent',
  };
  runs.set(run.id, run);

  // Fire-and-forget: drive the tool loop and stream activity into the log.
  void (async () => {
    let runError = '';
    try {
      const stream = generateResponse({
        prompt: opts.prompt,
        messageId: run.id,
        projectId: opts.projectId,
        projectPath,
        model: opts.model ?? null,
        useTools: true,
        useContext: true,
    onPlanTask: (title, steps) => {
      try {
        const parent = deps.db.createTask(opts.projectId, title, '', 'agent');
        for (const raw of steps) {
          const step = parseStep(raw);
          deps.db.createTask(opts.projectId, step.title, '', 'agent', parent.id, step.parallel);
        }
      } catch (exc) {
        console.log(`[tasks] agent plan_task failed: ${String(exc)}`);
      }
    },
        onToolEvent: (name, args, result) => {
          const argStr = (() => { try { return JSON.stringify(args); } catch { return ''; } })();
          run.log.push({ ts: Date.now(), kind: 'tool', text: `${name}(${argStr.slice(0, 120)}) → ${String(result).slice(0, 160)}` });
          run.updatedAt = Date.now();
        },
        onCreateTask: (title, detail) => {
          try { deps.db.createTask(opts.projectId, title, detail, 'agent'); } catch { /* ignore */ }
          run.log.push({ ts: Date.now(), kind: 'note', text: `Создана задача: ${title}` });
        },
      });

      for await (const chunk of stream) {
        if (run.stopped) break;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(chunk) as Record<string, unknown>; } catch { continue; }
        if (parsed.role === 'assistant' && typeof parsed.content === 'string') {
          run.content = parsed.content;
          run.updatedAt = Date.now();
        }
        if (parsed.role === 'system' && parsed.isError) {
          runError = String(parsed.content ?? 'Ошибка');
          run.log.push({ ts: Date.now(), kind: 'error', text: runError });
        }
      }

      if (run.status === 'running') {
        // an error chunk ends the stream: that is a failed run, not a finished one
        if (runError) {
          run.status = 'error';
          run.error = runError;
        } else {
          run.status = 'done';
          run.log.push({ ts: Date.now(), kind: 'note', text: 'Готово' });
        }
      }
    } catch (exc) {
      run.status = 'error';
      run.error = exc instanceof Error ? exc.message : String(exc);
      run.log.push({ ts: Date.now(), kind: 'error', text: run.error });
    } finally {
      run.updatedAt = Date.now();
    }
  })();

  return view(run);
}
