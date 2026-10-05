/**
 * Task runner — executes a task's checklist stage by stage.
 *
 * Each step is a separate, headless agent run with FRESH context: the model
 * sees the overall goal, the whole checklist (done steps with their recorded
 * result) and is told to do only the current step. That keeps big jobs from
 * overflowing one conversation, and every finished step is checked off on the
 * task board as soon as it completes.
 */
import { live } from './appconfig';
import type { Db, TaskRow } from './db';
import { generateResponse } from './ollama';
import { isDirectory, resolvePath } from './paths';
import { registerRun } from './agents';
import { FileClaims, PARALLEL_RULES, nextGroup, parseStep } from './steps';

export type RunStatus = 'planning' | 'running' | 'done' | 'error' | 'stopped';

export interface TaskRun {
  taskId: number;
  projectId: number;
  status: RunStatus;
  /** Step being worked on right now (the first of `stepIds`). */
  stepId: number | null;
  /** Every step running at this moment (several when steps are marked parallel). */
  stepIds: number[];
  /** What each running step is doing right now (last tool), and when it started — for the live status. */
  activity: Record<number, { tool: string; path?: string; at: number }>;
  startedAt: Record<number, number>;
  /** Paused by the user: the agents wait between steps of their work until resumed. */
  paused: boolean;
  error: string | null;
  updatedAt: number;
}

interface InternalRun extends TaskRun {
  stopped: boolean;
}

type Deps = { db: Db; workspaceRoot: string };

const runs = new Map<number, InternalRun>();

const view = ({ stopped: _stopped, ...run }: InternalRun): TaskRun => run;

export function listTaskRuns(projectId: number): TaskRun[] {
  return Array.from(runs.values())
    .filter((r) => r.projectId === projectId)
    .map(view);
}

export function stopTaskRun(taskId: number): boolean {
  const run = runs.get(taskId);
  if (!run) return false;
  run.stopped = true;
  return true;
}

export function pauseTaskRun(taskId: number, paused?: boolean): boolean {
  const run = runs.get(taskId);
  if (!run || !isActive(run)) return false;
  run.paused = paused ?? !run.paused;
  run.updatedAt = Date.now();
  return run.paused;
}

const isActive = (run: InternalRun | undefined): boolean =>
  !!run && (run.status === 'running' || run.status === 'planning');

function projectFolder(deps: Deps, projectId: number): string {
  const raw = deps.db.getProjectPath(projectId);
  const resolved = raw ? resolvePath(raw) : null;
  if (!resolved || !isDirectory(resolved)) throw new Error('Project folder not found');
  return resolved;
}

const WRITE_OK = /^(File CREATED|File overwritten|Appended to|Deleted )/;

interface DriveResult {
  text: string;
  error: string | null;
  changed: string[];
}

/** Runs one headless agent turn to completion. */
async function drive(
  deps: Deps,
  opts: {
    projectId: number;
    projectPath: string;
    prompt: string;
    extraSystem: string;
    model: string | null;
    messageId: string;
    isStopped: () => boolean;
    isPaused?: () => boolean;
    onPlanTask?: (title: string, steps: string[]) => void;
    guardWrite?: (tool: string, path: string) => string | null;
    /** Name of the run in the Agents tab, and what stopping it there does to the task run. */
    title: string;
    onStopAll?: () => void;
    /** Live status: 'start' when the agent begins, then the tool it just used and the file it touched. */
    onActivity?: (tool: string, path?: string) => void;
  },
): Promise<DriveResult> {
  const result: DriveResult = { text: '', error: null, changed: [] };
  // every step is visible in the Agents tab with its live log
  const shown = registerRun({ projectId: opts.projectId, title: opts.title, prompt: opts.prompt, model: opts.model, onStop: opts.onStopAll });
  const stopped = (): boolean => opts.isStopped() || shown.isStopped();
  opts.onActivity?.('start');
  const stream = generateResponse({
    prompt: opts.prompt,
    messageId: opts.messageId,
    projectId: opts.projectId,
    projectPath: opts.projectPath,
    model: opts.model,
    useTools: true,
    useContext: true,
    extraSystem: opts.extraSystem,
    onPlanTask: opts.onPlanTask,
    guardWrite: opts.guardWrite,
    onCreateTask: (title, detail) => {
      try {
        deps.db.createTask(opts.projectId, title, detail, 'agent');
      } catch {
        /* ignore */
      }
    },
    onToolEvent: (name, args, output) => {
      const argStr = (() => { try { return JSON.stringify(args); } catch { return ''; } })();
      shown.log('tool', `${name}(${argStr.slice(0, 120)}) → ${String(output).slice(0, 160)}`);
      const touched = (args as { path?: unknown } | null)?.path;
      opts.onActivity?.(name, typeof touched === 'string' ? touched : undefined);
      if (!WRITE_OK.test(String(output))) return;
      const p = (args as { path?: unknown } | null)?.path;
      if (typeof p === 'string' && !result.changed.includes(p)) result.changed.push(p);
    },
  });
  try {
    for await (const chunk of stream) {
      while (opts.isPaused?.() && !stopped()) await new Promise((r) => setTimeout(r, 300));
      if (stopped()) break;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(chunk) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (parsed.role === 'assistant' && typeof parsed.content === 'string') {
        result.text = parsed.content;
        shown.setContent(result.text);
      }
      if (parsed.role === 'system' && parsed.isError) result.error = String(parsed.content ?? 'Ошибка');
    }
  } catch (exc) {
    result.error = exc instanceof Error ? exc.message : String(exc);
  }
  shown.finish(result.error ? 'error' : stopped() ? 'stopped' : 'done', result.error ?? undefined);
  if (stopped() && !opts.isStopped()) opts.onStopAll?.(); // stopped from the Agents tab
  return result;
}

function checklist(steps: TaskRow[], currentId: number, parallelIds: number[] = []): string {
  return steps
    .map((s, i) => {
      const mark = s.status === 'done' ? '[x]' : '[ ]';
      const tail =
        s.id === currentId
          ? '   ← ТЕКУЩИЙ ЭТАП'
          : parallelIds.includes(s.id)
            ? '   ← выполняется параллельно другим агентом'
            : s.status === 'done' && s.detail
              ? `\n     итог: ${s.detail}`
              : '';
      return `${i + 1}. ${mark} ${s.title}${tail}`;
    })
    .join('\n');
}

const STEP_RULES =
  'Ты выполняешь ОДИН этап плана из чек-листа. Делай только текущий этап, не переходи к следующим и не переделывай ' +
  'выполненные. Учитывай итоги предыдущих этапов (файлы уже созданы — читай их, а не пиши заново). Изменения ' +
  'применяй инструментами (write_file/append_file). В конце — короткий ИТОГ этапа (1-3 предложения): что сделано и ' +
  'в каких файлах; он будет передан следующим этапам. Не вызывай plan_task.';

/** Run the unfinished steps of a task in order. Returns immediately. */
export function startTaskRun(deps: Deps, taskId: number, model: string | null = null): TaskRun {
  const task = deps.db.getTask(taskId);
  if (!task || task.parent_id !== null) throw new Error('Task not found');
  if (isActive(runs.get(taskId))) return view(runs.get(taskId)!);
  const projectPath = projectFolder(deps, task.project_id);
  if (deps.db.listSteps(taskId).every((s) => s.status === 'done')) {
    throw new Error('Нет невыполненных этапов — добавьте этапы или составьте план');
  }

  const run: InternalRun = {
    taskId,
    projectId: task.project_id,
    status: 'running',
    stepId: null,
    stepIds: [],
    activity: {},
    startedAt: {},
    error: null,
    updatedAt: Date.now(),
    stopped: false,
    paused: false,
  };
  runs.set(taskId, run);
  const touch = (): void => {
    run.updatedAt = Date.now();
  };
  // steps marked parallel run together, up to this many at once
  const limit = Math.max(1, Math.min(4, Math.round(Number(live<number>('agent.parallelSteps')) || 1)));

  void (async () => {
    try {
      deps.db.updateTask(taskId, { status: 'in_progress' });
      let limitRetries = 0;
      let garbledRetries = 0;
      for (;;) {
        if (run.stopped) break;
        const steps = deps.db.listSteps(taskId);
        const group = nextGroup(steps, limit);
        if (group.length === 0) break;
        run.stepId = group[0].id;
        run.stepIds = group.map((s) => s.id);
        for (const step of group) {
          deps.db.updateTask(step.id, { status: 'in_progress' });
          run.startedAt[step.id] = Date.now();
        }
        touch();

        const fresh = deps.db.getTask(taskId);
        const claims = new FileClaims(); // files the steps of this group have taken
        const results = await Promise.all(
          group.map(async (step) => {
            const partners = group.filter((s) => s.id !== step.id);
            const prompt =
              `Общая задача: ${fresh?.title ?? task.title}\n` +
              (fresh?.detail ? `${fresh.detail}\n` : '') +
              `\nЧек-лист:\n${checklist(steps, step.id, partners.map((s) => s.id))}\n\n` +
              `Выполни ТОЛЬКО этап ${steps.indexOf(step) + 1}: «${step.title}».`;
            const attempt = (extra: string, n: number) => drive(deps, {
              projectId: task.project_id,
              projectPath,
              prompt: prompt + extra,
              extraSystem: partners.length ? `${STEP_RULES}\n\n${PARALLEL_RULES}` : STEP_RULES,
              model,
              messageId: `task-${taskId}-${step.id}-${n}`,
              isStopped: () => run.stopped,
              isPaused: () => run.paused,
              title: `Задача «${task.title}» · этап ${steps.indexOf(step) + 1}: ${step.title}`,
              onStopAll: () => { run.stopped = true; },
              onActivity: (tool, p) => { run.activity[step.id] = { tool, path: p, at: Date.now() }; touch(); },
              guardWrite: partners.length ? (_tool, p) => claims.claim(step.id, p) : undefined,
            });
            // weak (small local) models often paste code into the answer instead of calling write_file:
            // nothing was applied then, so ask again instead of ticking the step off
            const pasted = (o: DriveResult): boolean =>
              !o.error && o.changed.length === 0 && /файлы НЕ изменены|"name"\s*:\s*"(write_file|append_file)"/.test(o.text);
            let out = await attempt('', 1);
            for (let n = 2; n <= 3 && pasted(out) && !run.stopped; n++) {
              out = await attempt(
                '\n\nВАЖНО: в прошлый раз ты написал код текстом, и файлы НЕ изменились. ' +
                  'Не пиши код в ответе: реально вызови инструмент write_file (или append_file) с полным содержимым файла.',
                n,
              );
            }
            if (pasted(out)) out.error = 'Модель не применила изменения: прислала код текстом вместо write_file. Выберите модель посильнее.';
            return { step, out };
          }),
        );

        let failure: string | null = null;
        for (const { step, out } of results) {
          if (run.stopped) {
            deps.db.updateTask(step.id, { status: 'todo' });
          } else if (out.error) {
            deps.db.updateTask(step.id, { status: 'todo' });
            failure = failure ?? out.error;
          } else {
            const summary = out.text.replace(/\s+/g, ' ').trim().slice(0, 500);
            const files = out.changed.length ? ` [файлы: ${out.changed.slice(0, 6).join(', ')}]` : ' [файлы не менялись]';
            deps.db.updateTask(step.id, { status: 'done', detail: (summary + files).trim() });
          }
        }
        touch();
        if (run.stopped) break;
        // a local model sometimes emits a garbled tool call (Ollama: "XML syntax error … illegal character"):
        // it is random, so just run the step again
        if (failure && /XML syntax error|illegal character|invalid character|unexpected end of JSON|error parsing tool call/i.test(failure) && garbledRetries < 3) {
          garbledRetries++;
          touch();
          continue;
        }
        // a free model's request limit passes within a minute or so: wait and repeat the step instead of giving up
        if (failure && /лимит|rate.?limit|429|too many|quota|timeout|таймаут/i.test(failure) && limitRetries < 5) {
          limitRetries++;
          for (const id of run.stepIds) run.activity[id] = { tool: 'wait', at: Date.now() };
          touch();
          for (let waited = 0; waited < 60_000 && !run.stopped; waited += 500) await new Promise((r) => setTimeout(r, 500));
          if (run.stopped) break;
          continue;
        }
        if (failure) {
          run.status = 'error';
          run.error = failure;
          break;
        }
      }
      if (run.status === 'running') {
        const all = deps.db.listSteps(taskId);
        run.status = run.stopped ? 'stopped' : 'done';
        deps.db.updateTask(taskId, {
          status: all.length > 0 && all.every((s) => s.status === 'done') ? 'done' : 'todo',
        });
      }
    } catch (exc) {
      run.status = 'error';
      run.error = exc instanceof Error ? exc.message : String(exc);
    } finally {
      run.stepId = null;
      run.stepIds = [];
      run.activity = {};
      run.startedAt = {};
      touch();
    }
  })();

  return view(run);
}

/** Steps from a plain-text plan: numbered or bulleted lines (3-10 of them are taken). */
export function parseListPlan(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:\d{1,2}[.)]|[-*•])\s+(.{3,})$/.exec(line);
    if (m) items.push(m[1].replace(/[*_`]+/g, '').trim());
  }
  return items.slice(0, 10);
}

/** Ask the model to break a task into checklist steps (attached to `taskId`). */
export function startTaskPlan(deps: Deps, taskId: number, model: string | null = null): TaskRun {
  const task = deps.db.getTask(taskId);
  if (!task || task.parent_id !== null) throw new Error('Task not found');
  if (isActive(runs.get(taskId))) return view(runs.get(taskId)!);
  const projectPath = projectFolder(deps, task.project_id);

  const run: InternalRun = {
    taskId,
    projectId: task.project_id,
    status: 'planning',
    stepId: null,
    stepIds: [],
    activity: {},
    startedAt: {},
    error: null,
    updatedAt: Date.now(),
    stopped: false,
    paused: false,
  };
  runs.set(taskId, run);

  void (async () => {
    let created = 0;
    try {
      const out = await drive(deps, {
        projectId: task.project_id,
        projectPath,
        prompt:
          `Составь план для задачи: «${task.title}».\n${task.detail ? task.detail + '\n' : ''}` +
          'Изучи проект (search_files/read_file), затем ОДИН раз вызови plan_task с 3-8 конкретными ' +
          'этапами (каждый выполним отдельно, в порядке очереди). Если этап не зависит от результата ' +
          'предыдущего и правит ДРУГИЕ файлы — начни его текст с «∥ »: такие этапы выполнятся параллельно. Файлы не изменяй.',
        extraSystem:
          'Сейчас твоя единственная цель — составить план через plan_task. Не выполняй саму работу и не пиши файлы.',
        model,
        messageId: `plan-${taskId}`,
        isStopped: () => run.stopped,
        isPaused: () => run.paused,
        title: `План задачи «${task.title}»`,
        onStopAll: () => { run.stopped = true; },
        onPlanTask: (_title, steps) => {
          if (created > 0) return;
          for (const raw of steps) {
            const s = parseStep(raw);
            deps.db.createTask(task.project_id, s.title, '', 'agent', taskId, s.parallel);
          }
          created = steps.length;
        },
      });
      // small local models often skip the tool call and just write the plan as a list: accept that,
      // or ask once more for nothing but a numbered list
      if (!out.error && created === 0 && !run.stopped) {
        let list = parseListPlan(out.text);
        if (list.length < 2) {
          const again = await drive(deps, {
            projectId: task.project_id,
            projectPath,
            prompt:
              `Разбей задачу «${task.title}» на 3-8 конкретных этапов.\n${task.detail ? task.detail + '\n' : ''}` +
              'Ответь ТОЛЬКО нумерованным списком: одна строка на этап, без вступления и пояснений. Инструменты не вызывай.',
            extraSystem: 'Отвечай только нумерованным списком этапов.',
            model,
            messageId: `plan2-${taskId}`,
            isStopped: () => run.stopped,
            isPaused: () => run.paused,
            title: `План задачи «${task.title}»`,
            onStopAll: () => { run.stopped = true; },
          });
          list = parseListPlan(again.text);
        }
        for (const raw of list) {
          const st = parseStep(raw);
          deps.db.createTask(task.project_id, st.title, '', 'agent', taskId, st.parallel);
        }
        created = list.length;
      }
      if (out.error) {
        run.status = 'error';
        run.error = out.error;
      } else if (created === 0) {
        run.status = 'error';
        run.error = 'Модель не составила план — попробуйте другую модель или добавьте этапы вручную';
      } else {
        run.status = 'done';
      }
    } catch (exc) {
      run.status = 'error';
      run.error = exc instanceof Error ? exc.message : String(exc);
    } finally {
      run.updatedAt = Date.now();
    }
  })();

  return view(run);
}
