/**
 * Task runner — executes a task's checklist stage by stage.
 *
 * Each step is a separate, headless agent run with FRESH context: the model
 * sees the overall goal, the whole checklist (done steps with their recorded
 * result) and is told to do only the current step. That keeps big jobs from
 * overflowing one conversation, and every finished step is checked off on the
 * task board as soon as it completes.
 */
import * as fs from 'fs';
import * as path from 'path';
import { live } from './appconfig';
import { dangerReason, describeResult, normalizeMode, runCommand } from './shell';
import type { Db, TaskRow } from './db';
import { generateResponse } from './ollama';
import { isDirectory, resolvePath } from './paths';
import { registerRun } from './agents';
import { roleOrChat } from './roles';
import { FileClaims, PARALLEL_RULES, afterOf, checkIssue, checkOf, nextGroup, parseStep, phaseOf, readyGroup, shellCheck, stepDetail } from './steps';

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

const WRITE_OK = /^(File CREATED|File overwritten|Appended to|Replaced in|Deleted )/;
/** A command or Docker action that ran and succeeded (a step can be done without changing files). */
const ranOk = (name: string, output: string): boolean =>
  (name === 'run_command' || name === 'otto_docker') &&
  !/^(Otto Docker action failed|Refused|The user declined|Running commands|Commands need|This needs|Repeated call)/.test(output) &&
  !/\((exit code [1-9]|exit code unknown|stopped: time limit)/.test(output);

interface DriveResult {
  text: string;
  error: string | null;
  changed: string[];
  /** A command / Docker action succeeded during the step. */
  ran: boolean;
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
    taskId: number;
    /** Reasoning effort of the role (planner: high, coder: low by default). */
    effort?: string | null;
    onStopAll?: () => void;
    /** Live status: 'start' when the agent begins, then the tool it just used and the file it touched. */
    onActivity?: (tool: string, path?: string) => void;
    /** A plan step: skills are chosen for the step (focus) within the task's stack (goal). */
    skillGoal?: string;
    skillFocus?: string;
    readBudget?: number;
  },
): Promise<DriveResult> {
  const result: DriveResult = { text: '', error: null, changed: [], ran: false };
  // every step is visible in the Agents tab with its live log
  const shown = registerRun({ projectId: opts.projectId, title: opts.title, prompt: opts.prompt, model: opts.model, origin: { kind: 'task', label: opts.title, taskId: opts.taskId }, onStop: opts.onStopAll });
  const stopped = (): boolean => opts.isStopped() || shown.isStopped();
  // Stop cuts the model request off too (not only between chunks)
  const abort = new AbortController();
  const watchStop = setInterval(() => { if (stopped()) abort.abort(); }, 300);
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
    effort: opts.effort ?? null,
    signal: abort.signal,
    onPlanTask: opts.onPlanTask,
    guardWrite: opts.guardWrite,
    skillGoal: opts.skillGoal,
    skillFocus: opts.skillFocus,
    readBudget: opts.readBudget,
    onCreateTask: (title, detail) => {
      try {
        deps.db.createTask(opts.projectId, title, detail, 'agent');
      } catch {
        /* ignore */
      }
    },
    onToolEvent: (name, args, output) => {
      shown.tool(name, args, String(output));
      const touched = (args as { path?: unknown } | null)?.path;
      opts.onActivity?.(name, typeof touched === 'string' ? touched : undefined);
      if (ranOk(name, String(output))) result.ran = true;
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
  } finally {
    clearInterval(watchStop);
  }
  shown.finish(result.error ? 'error' : stopped() ? 'stopped' : 'done', result.error ?? undefined);
  if (stopped() && !opts.isStopped()) opts.onStopAll?.(); // stopped from the Agents tab
  return result;
}

/** The project's blueprint: written by the first step of a plan, given to every later one. */
export const BLUEPRINT = '.otto/blueprint.md';
const MAX_BLUEPRINT = 4000;

export function readBlueprint(projectPath: string): string {
  try {
    const text = fs.readFileSync(path.join(projectPath, BLUEPRINT), 'utf8').trim();
    return text.length > MAX_BLUEPRINT ? `${text.slice(0, MAX_BLUEPRINT)}\n… (обрезано; полный текст — read_file ${BLUEPRINT})` : text;
  } catch {
    return '';
  }
}

/** Files a finished step recorded in its summary ("[файлы: a, b]"). */
const stepFiles = (detail: string | null): string[] => {
  const m = /\[файлы: ([^\]]+)\]/.exec(detail ?? '');
  return m ? m[1].split(',').map((f) => f.trim()).filter(Boolean) : [];
};

/**
 * What one step of a plan is told. Not the whole history: the goal, the blueprint, a compact view of the plan
 * (the last finished steps with their results, the files made so far, the next steps not to do yet) and the
 * step itself with its check. Long plans (30-100 steps) stay small enough for a 32K local model.
 */
export function stepPrompt(
  goal: { title: string; detail: string | null },
  steps: TaskRow[],
  step: TaskRow,
  blueprint: string,
  partners: TaskRow[] = [],
  containers = '',
): string {
  const at = steps.indexOf(step);
  const done = steps.filter((s) => s.status === 'done');
  const result = (s: TaskRow): string => (s.detail && !/^(check|after): /m.test(s.detail) ? ` → ${s.detail.slice(0, 400)}` : '');
  // the steps this one needs: their results in full, whatever their place in the plan
  const needs = afterOf(step.detail).map((n) => steps[n - 1]).filter((s): s is TaskRow => Boolean(s) && s.status === 'done');
  const recent = done.filter((s) => !needs.includes(s)).slice(-Math.max(2, 5 - needs.length));
  const files = [...new Set(done.flatMap((s) => stepFiles(s.detail)))];
  const next = steps.slice(at + 1).filter((s) => s.status !== 'done' && !partners.includes(s)).slice(0, 3);
  const check = checkOf(step.detail);
  // the plan's phases with their progress: where this step sits in the whole job
  const phases = new Map<string, { done: number; all: number }>();
  for (const s of steps) {
    const p = phaseOf(s.title);
    if (!p) continue;
    const e = phases.get(p) ?? { done: 0, all: 0 };
    e.all++;
    if (s.status === 'done') e.done++;
    phases.set(p, e);
  }
  const phase = phaseOf(step.title);
  const parts = [
    `Общая задача: ${goal.title}${goal.detail ? `\n${goal.detail.slice(0, 1500)}` : ''}`,
    blueprint ? `Каркас проекта (${BLUEPRINT}) — имена, структура и договорённости, им следуй:\n${blueprint}` : '',
    `План: ${steps.length} этапов, выполнено ${done.length}.` +
      (phases.size > 1 ? `\nФазы: ${[...phases].map(([p, e]) => `${p === phase ? '▶ ' : ''}${p} ${e.done}/${e.all}`).join(' → ')}` : ''),
    needs.length ? `Этот этап опирается на результаты этапов:\n${needs.map((s) => `- ${steps.indexOf(s) + 1}. ${s.title}${result(s)}`).join('\n')}` : '',
    recent.length ? `Последние выполненные:\n${recent.map((s) => `- ${steps.indexOf(s) + 1}. ${s.title}${result(s)}`).join('\n')}` : '',
    files.length ? `Уже созданы/изменены файлы (${files.length}): ${files.slice(0, 60).join(', ')}` : '',
    containers ? `Запущенные контейнеры проекта (работай с ними, свои не поднимай):\n${containers}` : '',
    partners.length ? `Параллельно с тобой выполняются: ${partners.map((s) => `«${s.title}»`).join(', ')}` : '',
    next.length ? `Следующие этапы (НЕ делай их сейчас): ${next.map((s) => `«${s.title}»`).join('; ')}` : '',
    `Выполни ТОЛЬКО этап ${at + 1} из ${steps.length}: «${step.title}»` +
      (check ? `\nЭтап считается выполненным, только когда проходит проверка: \`${check}\` — Otto запустит её сам после тебя.` : ''),
  ];
  return parts.filter(Boolean).join('\n\n');
}

/** Reads in a row a plan step may make without a change before reads are refused (see LoopGuard.setReadBudget). */
export const STEP_READ_BUDGET = 25;

/** The step's summary says it is not done ("Итог этапа 20 (не завершен)", "not finished", "осталось сделать…"). */
export function saysUnfinished(text: string): boolean {
  const head = text.replace(/:::changes[\s\S]*?:::/g, '').slice(0, 400);
  return /\b(не\s+(завершен|завершён|выполнен|доделан|готов)|не\s+удалось\s+(завершить|доделать)|not\s+(finished|complete|completed|done)|incomplete|unfinished)\b/i.test(head) ||
    /(не\s+(завершен|завершён|выполнен|доделан))/i.test(head);
}

/** Result of a step's check command. */
interface CheckResult { ok: boolean; skipped: string | null; output: string }

/**
 * Run a step's check. Only when commands may run without asking (agent.shell = auto: a task run has nobody to ask)
 * and never a command from the danger list; otherwise the step is judged by its changes as before.
 */
async function runCheck(projectPath: string, command: string, isStopped: () => boolean): Promise<CheckResult> {
  if (!command) return { ok: true, skipped: 'no check', output: '' };
  const issue = checkIssue(command);
  if (issue) return { ok: true, skipped: issue, output: '' };
  if (normalizeMode(live<string>('agent.shell')) !== 'auto') return { ok: true, skipped: 'commands need approval', output: '' };
  const danger = dangerReason(command);
  if (danger) return { ok: true, skipped: `refused: ${danger}`, output: '' };
  if (isStopped()) return { ok: true, skipped: 'stopped', output: '' };
  const r = await runCommand(projectPath, shellCheck(command), 300);
  return { ok: r.code === 0 && !r.timedOut && !r.cancelled, skipped: null, output: describeResult(command, r) };
}

const STEP_RULES =
  'Ты выполняешь ОДИН этап плана из чек-листа. Делай только текущий этап, не переходи к следующим и не переделывай ' +
  'выполненные. Учитывай итоги предыдущих этапов (файлы уже созданы — читай их, а не пиши заново). Изменения ' +
  'применяй инструментами (write_file/append_file). В конце — короткий ИТОГ этапа (1-3 предложения): что сделано и ' +
  'в каких файлах; он будет передан следующим этапам. Не вызывай plan_task.\n' +
  'Работай с сервисами САМОГО проекта (его docker compose: база, приложение — см. «Запущенные контейнеры»): миграции и сид ' +
  'запускай в них (docker compose exec <сервис> …). НЕ поднимай свои отдельные контейнеры и базы «для проверки» — результат ' +
  'в них проекту не достаётся. Временные файлы проверок удаляй.';

/**
 * The project's running containers (compose project = folder name), so a step works with them instead of
 * starting a database of its own. Empty when Docker is not there.
 */
export async function projectContainers(projectPath: string): Promise<string> {
  const project = path.basename(projectPath).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!project) return '';
  // no quotes inside the format: PowerShell 5.1 mangles nested quotes in arguments to native programs
  const r = await runCommand(projectPath, `docker ps --filter "label=com.docker.compose.project=${project}" --format "{{.Names}}: {{.Status}} {{.Ports}}"`, 20);
  return r.code === 0 ? r.output.trim().split('\n').filter(Boolean).slice(0, 10).join('\n') : '';
}

/**
 * Run the unfinished steps of a task in order. Returns immediately.
 * `single`: only the next stage (or parallel group), then stop — step-by-step mode from the task board.
 */
export function startTaskRun(deps: Deps, taskId: number, chatModel: string | null = null, single = false): TaskRun {
  // the steps are the coder's work (Settings → Models → Model roles)
  const { model, effort } = roleOrChat('coder', chatModel);
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
        const group = readyGroup(steps, limit);
        if (group.length === 0) break;
        run.stepId = group[0].id;
        run.stepIds = group.map((s) => s.id);
        for (const step of group) {
          deps.db.updateTask(step.id, { status: 'in_progress' });
          run.startedAt[step.id] = Date.now();
        }
        touch();

        const fresh = deps.db.getTask(taskId);
        const goal = { title: fresh?.title ?? task.title, detail: fresh?.detail ?? task.detail };
        const blueprint = readBlueprint(projectPath);
        const containers = await projectContainers(projectPath).catch(() => '');
        const claims = new FileClaims(); // files the steps of this group have taken
        const results = await Promise.all(
          group.map(async (step) => {
            const partners = group.filter((s) => s.id !== step.id);
            const prompt = stepPrompt(goal, steps, step, blueprint, partners, containers);
            const check = checkOf(step.detail);
            const attempt = (extra: string, n: number) => drive(deps, {
              projectId: task.project_id,
              projectPath,
              prompt: prompt + extra,
              skillGoal: `${goal.title}\n${goal.detail ?? ''}\n${blueprint.slice(0, 600)}`,
              skillFocus: `${step.title}\n${check}`,
              readBudget: STEP_READ_BUDGET,
              extraSystem: partners.length ? `${STEP_RULES}\n\n${PARALLEL_RULES}` : STEP_RULES,
              model,
              messageId: `task-${taskId}-${step.id}-${n}`,
              taskId,
              effort,
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
            // a step is done only when something really happened: Otto stopped a looping model, or the model
            // only talked (an apology, "skill not found") without changing a file or running a command
            else if (!out.error && /Otto остановил работу|Otto stopped the run/.test(out.text)) out.error = 'Этап не выполнен: модель пошла по кругу и была остановлена.';
            // nothing changed because the work was already there (e.g. written by the chat before the plan ran) is done, not failed
            else if (!out.error && out.changed.length === 0 && !out.ran && !/(уже\s+(есть|существует|создан|сделан|выполнен|готов|настроен|содержит)|already\s+(exists|done|in place|created|has|contains|set up))/i.test(out.text)) out.error = 'Этап не выполнен: модель не изменила ни одного файла и не выполнила ни одной команды.';
            // the model's own word that the step is unfinished outweighs the files it touched: one more go, then stop
            if (!out.error && saysUnfinished(out.text) && !run.stopped) {
              const again = await attempt(
                `\n\nВ прошлый раз ты сам написал, что этап НЕ завершён:\n${out.text.slice(0, 1200)}\nДоделай именно этот этап до конца (файлы уже частично есть — читай их и дописывай).`,
                6,
              );
              if (again.error) out.error = again.error;
              else {
                out.changed.push(...again.changed.filter((f) => !out.changed.includes(f)));
                out.text = again.text;
                if (saysUnfinished(out.text)) out.error = `Этап не выполнен: модель сама сообщает, что он не завершён.\n${out.text.slice(0, 600)}`;
              }
            }
            // the step's own check decides, not the model's words: a failed check goes back with its output (twice)
            let verdict: CheckResult = { ok: true, skipped: 'no check', output: '' };
            if (!out.error && check) {
              verdict = await runCheck(projectPath, check, () => run.stopped);
              for (let n = 4; !verdict.ok && n <= 5 && !run.stopped; n++) {
                run.activity[step.id] = { tool: 'check', at: Date.now() };
                const retry = await attempt(
                  `\n\nПРОВЕРКА ЭТАПА НЕ ПРОШЛА — этап не засчитан. Исправь причину (только то, что относится к этому этапу), Otto проверит снова:\n${verdict.output.slice(-2500)}`,
                  n,
                );
                if (retry.error) { out.error = retry.error; break; }
                out.changed.push(...retry.changed.filter((f) => !out.changed.includes(f)));
                out.text = retry.text;
                verdict = await runCheck(projectPath, check, () => run.stopped);
              }
              if (!out.error && !verdict.ok) out.error = `Этап не выполнен: проверка \`${check}\` не проходит.\n${verdict.output.slice(-800)}`;
            }
            return { step, out, verdict };
          }),
        );

        let failure: string | null = null;
        for (const { step, out, verdict } of results) {
          if (run.stopped) {
            deps.db.updateTask(step.id, { status: 'todo' });
          } else if (out.error) {
            deps.db.updateTask(step.id, { status: 'todo' });
            failure = failure ?? out.error;
          } else {
            // the chat's files card (":::changes {json} :::") is for the UI, not for the next steps
            const summary = out.text.replace(/:::changes[\s\S]*?:::/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
            const files = out.changed.length ? ` [файлы: ${out.changed.slice(0, 12).join(', ')}]` : ' [файлы не менялись]';
            const check = checkOf(step.detail);
            const proof = !check ? '' : verdict.skipped ? ` [проверка не запускалась: ${verdict.skipped}]` : ` [проверка ✓ ${check}]`;
            deps.db.updateTask(step.id, { status: 'done', detail: (summary + files + proof).trim() });
          }
        }
        touch();
        if (run.stopped) break;
        if (single && !failure) break;
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

/** Steps from a plain-text plan: numbered or bulleted lines (up to 40 are taken). */
export function parseListPlan(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:\d{1,2}[.)]|[-*•])\s+(.{3,})$/.exec(line);
    // backticks stay: a check command may be quoted in them
    if (m) items.push(m[1].replace(/\*\*|__/g, '').trim());
  }
  return items.slice(0, 40);
}

const PLANNING_ONLY = 'REJECTED: this run only makes the plan — files are written later, step by step, by the plan itself. Nothing was written. Call plan_task now.';

/** How the planner is asked to break a big job down: phases, small steps, dependencies, checks, a blueprint first. */
export const PLAN_RULES =
  'Разбей работу на 8-40 МАЛЕНЬКИХ этапов (каждый — 1-3 файла, выполним отдельной моделью со свежим контекстом). Формат строки этапа:\n' +
  '[Фаза] Что сделать (конкретно, с именами файлов) — после: 2, 5 — проверка: <команда>\n' +
  '- [Фаза] — группа этапов: Каркас, Бэкенд, Фронтенд, Данные, Docker, Тесты, Проверка… (иерархия задачи).\n' +
  '- «после: N, M» — номера этапов, результат которых нужен этому (их итоги он получит). Без «после:» этап ждёт все предыдущие. ' +
  'Независимые этапы (разные файлы, не нужны результаты друг друга) указывай с «после:» только на общие основы — тогда они могут идти параллельно.\n' +
  '- «проверка:» — ОДНА команда, которая падает (ненулевой код), если этап не сделан: npx tsc --noEmit, npm test -- books, npm run build, ' +
  'php artisan route:list, docker compose config, curl.exe -f http://127.0.0.1:3000/api/books. Не cat/ls/test -f/grep и не описания словами. ' +
  'Если проверить нечем (README, вёрстка) — без «проверка:».\n' +
  `- ЭТАП 1 всегда: «[Каркас] Записать ${BLUEPRINT}»: стек и версии, дерево папок, ТОЧНЫЕ имена файлов, модулей и классов, ` +
  'поля сущностей, маршруты API, переменные окружения, дизайн-токены. Все остальные этапы следуют этому каркасу.\n' +
  '- Затем этапы, которые ставят зависимости и конфиг (package.json / composer.json, npm install), — до кода, который их использует.\n' +
  '- Этап, которому нужна работающая база или сервер (миграции, сид, curl к API, e2e), — «после:» этапа, который их поднимает (docker compose up / serve). ' +
  'Без базы такие команды не проверить: не ставь их раньше.';

/** Ask the model to break a task into checklist steps (attached to `taskId`). */
export function startTaskPlan(deps: Deps, taskId: number, chatModel: string | null = null): TaskRun {
  // planning is the planner's work
  const { model, effort } = roleOrChat('planner', chatModel);
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
          `Изучи проект (list_files/read_file, если в нём что-то есть), затем ОДИН раз вызови plan_task.\n${PLAN_RULES}\nФайлы не изменяй.`,
        extraSystem:
          'Сейчас твоя единственная цель — составить план через plan_task. Не выполняй саму работу и не пиши файлы.',
        model,
        messageId: `plan-${taskId}`,
        taskId,
        effort,
        isStopped: () => run.stopped || created > 0,
        isPaused: () => run.paused,
        guardWrite: () => PLANNING_ONLY,
        title: `План задачи «${task.title}»`,
        onStopAll: () => { run.stopped = true; },
        onPlanTask: (_title, steps) => {
          if (created > 0) return;
          for (const raw of steps) {
            const s = parseStep(raw);
            deps.db.createTask(task.project_id, s.title, stepDetail(s), 'agent', taskId, s.parallel);
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
              `Разбей задачу «${task.title}» на этапы.\n${task.detail ? task.detail + '\n' : ''}${PLAN_RULES}\n` +
              'Ответь ТОЛЬКО нумерованным списком: одна строка на этап, без вступления и пояснений. Инструменты не вызывай.',
            extraSystem: 'Отвечай только нумерованным списком этапов.',
            model,
            messageId: `plan2-${taskId}`,
            taskId,
            effort,
            isStopped: () => run.stopped,
            isPaused: () => run.paused,
            title: `План задачи «${task.title}»`,
            onStopAll: () => { run.stopped = true; },
          });
          list = parseListPlan(again.text);
        }
        for (const raw of list) {
          const st = parseStep(raw);
          deps.db.createTask(task.project_id, st.title, stepDetail(st), 'agent', taskId, st.parallel);
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
