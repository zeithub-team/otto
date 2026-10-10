/**
 * Background agent runner — autonomous file-working agents. Each run drives the same tool loop as the
 * chat (read/search/write files, create tasks) but headless, streaming its activity into an in-memory
 * log. Multiple runs execute concurrently.
 *
 * Every run says who started it (the Agents tab, a task step, a chat) and keeps a record of what it did:
 * files created / changed / deleted, commands run, the final answer. The Agents tab also lists the chat
 * runs going on right now (chatruns.ts), so everything that works in the background is in one place.
 */
import { randomUUID } from 'crypto';
import type { Db } from './db';
import { generateResponse } from './ollama';
import { parseStep } from './steps';
import { isDirectory, resolvePath } from './paths';
import { listChatRuns, stopRun as stopChatRun } from './chatruns';
import { stripChangesMarker } from './changes';
import { tasksNote } from './tasknote';

export type AgentStatus = 'running' | 'done' | 'error' | 'stopped';

export interface LogEntry { ts: number; kind: 'tool' | 'note' | 'error'; text: string }

/** Who started a run. */
export interface AgentOrigin {
  kind: 'agents' | 'task' | 'chat';
  /** The task or the chat, by name ("Задача «…» · этап 2", "Чат «…»"). */
  label?: string;
  taskId?: number;
  chatId?: number;
}

/** What a run did, for the summary card. */
export interface AgentWork {
  files: Array<{ path: string; action: 'created' | 'modified' | 'deleted' }>;
  commands: string[];
  tools: number;
}

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
  origin: AgentOrigin;
  work: AgentWork;
  /** Stopping a task step stops the whole task run. */
  onStop?: () => void;
  abort?: AbortController;
}

const runs = new Map<string, AgentRun>();

/** Names of projects / chats for the list (set from the API layer). */
export interface Names { project(id: number): string | null; chat(id: number): string | null }

const cleanAnswer = (text: string): string => stripChangesMarker(text).trim();

/** Public (serialisable) view of a run. */
function view(r: AgentRun, names?: Names) {
  return {
    id: r.id, projectId: r.projectId, projectName: names?.project(r.projectId) ?? null, title: r.title, prompt: r.prompt, model: r.model,
    status: r.status, content: r.content, summary: cleanAnswer(r.content), log: r.log, error: r.error,
    createdAt: r.createdAt, updatedAt: r.updatedAt, source: r.source, origin: r.origin, work: r.work,
  };
}

const WRITE = /^(File CREATED|File overwritten|Appended to|Deleted |Replaced )/;

/** Keeps what a tool call changed (files, commands) in the run's record. */
function record(run: AgentRun, name: string, args: unknown, result: string): void {
  run.work.tools++;
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  if (name === 'run_command' && typeof a.command === 'string' && !/declined|Refused|turned off|need the user/i.test(result)) {
    run.work.commands.push(a.command.slice(0, 200));
  }
  const p = typeof a.path === 'string' ? a.path.replace(/\\/g, '/') : '';
  if (!p || !WRITE.test(result)) return;
  const action = /^Deleted /.test(result) ? 'deleted' : /^File CREATED/.test(result) ? 'created' : 'modified';
  const hit = run.work.files.find((f) => f.path === p);
  if (hit) { if (action === 'deleted' || hit.action !== 'created') hit.action = action; } else run.work.files.push({ path: p, action });
}

const emptyWork = (): AgentWork => ({ files: [], commands: [], tools: 0 });

/** Handle for work done by another module (the task runner) that should show up in the Agents tab. */
export interface ExternalRun {
  id: string;
  log(kind: LogEntry['kind'], text: string): void;
  /** A tool call of the run (also kept in its record of changes). */
  tool(name: string, args: unknown, result: string): void;
  setContent(text: string): void;
  isStopped(): boolean;
  finish(status: 'done' | 'error' | 'stopped', error?: string): void;
}

/** Show a run driven elsewhere (a task step) in the Agents tab, with its live log. */
export function registerRun(opts: { projectId: number; title: string; prompt: string; model: string | null; origin?: AgentOrigin; onStop?: () => void }): ExternalRun {
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
    origin: opts.origin ?? { kind: 'task', label: opts.title },
    work: emptyWork(),
    onStop: opts.onStop,
  };
  runs.set(run.id, run);
  // keep the list short: the oldest finished task-step runs go first
  const finished = [...runs.values()].filter((r) => r.source === 'task' && r.status !== 'running').sort((a, b) => a.createdAt - b.createdAt);
  for (const old of finished.slice(0, Math.max(0, finished.length - 30))) runs.delete(old.id);
  return {
    id: run.id,
    log: (kind, text) => { run.log.push({ ts: Date.now(), kind, text: text.slice(0, 400) }); run.updatedAt = Date.now(); },
    tool: (name, args, result) => {
      const argStr = (() => { try { return JSON.stringify(args); } catch { return ''; } })();
      run.log.push({ ts: Date.now(), kind: 'tool', text: `${name}(${argStr.slice(0, 120)}) → ${String(result).slice(0, 160)}` });
      record(run, name, args, String(result));
      run.updatedAt = Date.now();
    },
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

/** The chat runs going on right now, in the same shape (they are stopped like any other run). */
function chatRunViews(projectId: number | undefined, names?: Names) {
  return listChatRuns()
    .filter((c) => projectId === undefined || c.projectId === projectId)
    .map((c) => {
      const latest = [...c.latest.values()].map((chunk) => { try { return JSON.parse(chunk) as Record<string, unknown>; } catch { return {}; } });
      const answer = latest.filter((m) => m.role === 'assistant').pop();
      const tools = latest.filter((m) => m.role === 'tool');
      const chatName = names?.chat(c.chatId) ?? null;
      return {
        id: `chat-${c.chatId}`, projectId: c.projectId, projectName: names?.project(c.projectId) ?? null,
        title: c.prompt.slice(0, 80), prompt: c.prompt, model: c.model, status: 'running' as AgentStatus,
        content: String(answer?.content ?? ''), summary: cleanAnswer(String(answer?.content ?? '')),
        log: tools.map((m) => ({ ts: Number(m.timestamp ?? 0) * 1000, kind: 'tool' as const, text: `${String(m.tool)} → ${String(m.result ?? '').slice(0, 160)}` })),
        error: null, createdAt: c.startedAt, updatedAt: Date.now(), source: 'agent' as const,
        origin: { kind: 'chat' as const, chatId: c.chatId, label: chatName ? `Чат «${chatName}»` : `Чат #${c.chatId}` },
        work: emptyWork(),
      };
    });
}

/** Runs of a project (or of every project), newest first, chat runs included. */
export function listAgents(projectId?: number, names?: Names) {
  const own = Array.from(runs.values())
    .filter((r) => projectId === undefined || r.projectId === projectId)
    .map((r) => view(r, names));
  return [...chatRunViews(projectId, names), ...own].sort((a, b) => b.createdAt - a.createdAt);
}

export function getAgent(id: string) {
  const r = runs.get(id);
  return r ? view(r) : null;
}

export function stopAgent(id: string): boolean {
  if (id.startsWith('chat-')) return stopChatRun(Number(id.slice(5)));
  const r = runs.get(id);
  if (!r) return false;
  if (r.status === 'running') {
    r.stopped = true;
    r.status = 'stopped';
    r.updatedAt = Date.now();
    r.abort?.abort();
    r.onStop?.();
  }
  return true;
}

export function deleteAgent(id: string): boolean {
  if (id.startsWith('chat-')) return false;
  const r = runs.get(id);
  if (r && r.status === 'running') { r.stopped = true; r.abort?.abort(); r.onStop?.(); }
  return runs.delete(id);
}

/** Start an agent run in the background; returns its initial view. */
export function startAgent(
  deps: { db: Db; workspaceRoot: string },
  opts: { projectId: number; prompt: string; title?: string; model?: string | null; origin?: AgentOrigin },
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
    origin: opts.origin ?? { kind: 'agents', label: 'Вкладка «Агенты»' },
    work: emptyWork(),
    abort: new AbortController(),
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
        signal: run.abort!.signal,
        tasksNote: (() => { try { return tasksNote(deps.db.listTasks(opts.projectId), opts.prompt); } catch { return ''; } })(),
        onPlanTask: (title, steps) => {
          try {
            const parent = deps.db.createTask(opts.projectId, title, '', 'agent');
            for (const raw of steps) {
              const step = parseStep(raw);
              deps.db.createTask(opts.projectId, step.title, '', 'agent', parent.id, step.parallel);
            }
            run.log.push({ ts: Date.now(), kind: 'note', text: `План: ${title} (${steps.length} этапов)` });
          } catch (exc) {
            console.log(`[tasks] agent plan_task failed: ${String(exc)}`);
          }
        },
        onToolEvent: (name, args, result) => {
          const argStr = (() => { try { return JSON.stringify(args); } catch { return ''; } })();
          run.log.push({ ts: Date.now(), kind: 'tool', text: `${name}(${argStr.slice(0, 120)}) → ${String(result).slice(0, 160)}` });
          record(run, name, args, String(result));
          run.updatedAt = Date.now();
        },
        onCreateTask: (title, detail) => {
          try { deps.db.createTask(opts.projectId, title, detail, 'agent'); } catch { /* ignore */ }
          run.log.push({ ts: Date.now(), kind: 'note', text: `Создана задача: ${title}` });
        },
      });

      for await (const chunk of stream) {
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
          const w = run.work;
          run.log.push({ ts: Date.now(), kind: 'note', text: `Готово: файлов ${w.files.length}, команд ${w.commands.length}, вызовов инструментов ${w.tools}` });
        }
      }
    } catch (exc) {
      if (run.status === 'running') {
        run.status = 'error';
        run.error = exc instanceof Error ? exc.message : String(exc);
        run.log.push({ ts: Date.now(), kind: 'error', text: run.error });
      }
    } finally {
      run.updatedAt = Date.now();
    }
  })();

  return view(run);
}
