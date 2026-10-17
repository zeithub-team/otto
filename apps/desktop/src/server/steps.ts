/**
 * Checklist steps that may run at the same time.
 *
 * A step written as `∥ Write the export module` (or `|| …`, `[parallel] …`, `[параллельно] …`) runs together with
 * the step before it: the planner marks pieces that touch different files. Everything else is sequential.
 */

const MARKER = /^\s*(?:∥|\|\||\[\s*(?:параллельно|parallel|\|\|)\s*\])\s*/i;

/**
 * A plan step as the planner writes it:
 *   `[Бэкенд] Сервис книг: поиск и фильтры — после: 4, 6 — проверка: npx tsc --noEmit`
 * `[Фаза]` groups steps (kept in the title, so the board shows it); `после:` lists the steps (1-based) whose result
 * this one needs — it starts only when they are done and gets their results; `проверка:` proves it done.
 */
export interface ParsedStep { title: string; parallel: boolean; check: string; after: number[] }

const CHECK = /\s*(?:[—–-]+\s*)?(?:проверка|check)\s*:\s*`?([^`]+?)`?\s*$/i;
const AFTER = /\s*(?:[—–-]+\s*)?(?:после|after|зависит от|depends on)\s*:?\s*((?:#?\d+\s*(?:,|и|and)?\s*)+)\s*$/i;

export function parseStep(text: string): ParsedStep {
  const m = MARKER.exec(text);
  let body = m ? text.slice(m[0].length) : text;
  const c = CHECK.exec(body);
  if (c) body = body.slice(0, c.index);
  const a = AFTER.exec(body);
  if (a) body = body.slice(0, a.index);
  const after = a ? [...new Set((a[1].match(/\d+/g) ?? []).map(Number).filter((n) => n > 0))] : [];
  return { title: body.trim(), parallel: Boolean(m), check: c ? c[1].trim() : '', after };
}

/** How a step's check and dependencies are kept in its `detail` until it is done (then its summary replaces them). */
export const stepDetail = (s: Pick<ParsedStep, 'check' | 'after'>): string =>
  [s.after.length ? `after: ${s.after.join(', ')}` : '', s.check ? `check: ${s.check}` : ''].filter(Boolean).join('\n');
/** Kept for callers that only have a check. */
export const checkDetail = (check: string): string => stepDetail({ check, after: [] });
export const checkOf = (detail: string | null | undefined): string => /^check: (.+)$/m.exec(detail ?? '')?.[1].trim() ?? '';
export const afterOf = (detail: string | null | undefined): number[] =>
  (/^after: (.+)$/m.exec(detail ?? '')?.[1].match(/\d+/g) ?? []).map(Number);
/**
 * Why a planned check cannot prove anything here, or null when it is a real command. Planners write prose
 * ("curl endpoints, сид + тесты"), tool names (preview_page) or bash that PowerShell has not (`test -f`, `grep`),
 * and a check that cannot pass would block a finished step.
 */
export function checkIssue(command: string): string | null {
  const c = command.trim();
  if (!c) return 'empty';
  if (/\b(preview_page|run_in_page|otto_preview|read_file|list_files)\b/.test(c)) return 'an Otto tool, not a command';
  if (/[а-яё]{3,}/i.test(c.replace(/(["'])[^"']*\1/g, ''))) return 'a description, not a command';
  if (/\((?:all|или|or)\b|\betc\b|\.\.\.|…/i.test(c)) return 'a description, not a command';
  if (process.platform === 'win32' && /(^|[;&|]\s*)(test\s+-[a-z]|grep\b|head\b|tail\b|wc\b|which\b|true\b)|2>\/dev\/null|\|\|/.test(c)) return 'bash, not PowerShell';
  // "cat README.md" / "ls x" only show a file: they pass whether the step was done or not
  if (/^(cat|type|ls|dir|echo)\b/i.test(c)) return 'only shows a file, proves nothing';
  return null;
}

/** A check as Windows PowerShell 5.1 runs it: `a && b` stops at the first failure, `curl` is the real curl.exe. */
export function shellCheck(command: string, platform = process.platform): string {
  if (platform !== 'win32') return command;
  const parts = command.split(/\s*&&\s*/).map((p) => p.replace(/(^|[\s;|])curl(?=\s)/g, '$1curl.exe'));
  return parts.length === 1 ? parts[0] : parts.join('; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; ');
}

/** "[Бэкенд] Сервис книг" → "Бэкенд". */
export const phaseOf = (title: string): string => /^\s*\[([^\]]{1,40})\]/.exec(title)?.[1].trim() ?? '';

interface Schedulable { status: string; parallel: boolean; detail?: string | null }

/**
 * The steps each one waits for (indexes into `steps`): its `после:` list, or — without one — every step before it
 * (a plain sequence), and a step marked ∥ waits for what the step before it waits for.
 */
export function dependencies<T extends Schedulable>(steps: T[]): number[][] {
  const deps: number[][] = [];
  steps.forEach((s, i) => {
    // a step may wait for a later one in the list (moved behind it); a cycle is broken in readyGroup
    const declared = afterOf(s.detail).map((n) => n - 1).filter((n) => n >= 0 && n < steps.length && n !== i);
    if (declared.length || afterOf(s.detail).length) deps.push(declared);
    else if (s.parallel && i > 0) deps.push(deps[i - 1]);
    else deps.push(Array.from({ length: i }, (_, k) => k));
  });
  return deps;
}

/**
 * The steps to run now: unfinished ones whose dependencies are all done, in plan order, up to `limit`. With no
 * `после:` anywhere this is exactly the old behaviour (one step, or it and the ∥ steps right after it).
 */
export function readyGroup<T extends Schedulable>(steps: T[], limit: number): T[] {
  const deps = dependencies(steps);
  const ready = steps.filter((s, i) => s.status !== 'done' && deps[i].every((d) => steps[d].status === 'done'));
  if (!ready.length) {
    // a cycle or a broken reference: never stall — take the first unfinished step
    const first = steps.find((s) => s.status !== 'done');
    return first ? [first] : [];
  }
  return ready.slice(0, Math.max(1, limit));
}

/** Steps that run together: the first unfinished step plus the unfinished ones right after it that are marked parallel. */
export function nextGroup<T extends { status: string; parallel: boolean }>(steps: T[], limit: number): T[] {
  const start = steps.findIndex((s) => s.status !== 'done');
  if (start < 0) return [];
  const group = [steps[start]];
  for (let i = start + 1; i < steps.length && group.length < Math.max(1, limit); i++) {
    if (steps[i].status === 'done' || !steps[i].parallel) break;
    group.push(steps[i]);
  }
  return group;
}

/** Rule text for the step runner: which files other running steps have claimed. */
export const PARALLEL_RULES =
  'Другие этапы плана выполняются ПАРАЛЛЕЛЬНО с твоим в этом же проекте. Не трогай файлы, которые ' +
  'изменяет другой этап: если инструмент ответил, что файл занят, — оставь его и сделай свою часть в других ' +
  'файлах, либо кратко опиши в итоге, что осталось сделать в занятом файле.';

/** Locks the files a running step writes so two parallel steps never overwrite each other. */
export class FileClaims {
  private owners = new Map<string, number>();

  private static key(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
  }

  /** Claim `path` for `stepId`; null when it is free / already ours, else the message for the model. */
  claim(stepId: number, path: string): string | null {
    const key = FileClaims.key(path);
    if (!key) return null;
    const owner = this.owners.get(key);
    if (owner !== undefined && owner !== stepId) {
      return `Файл «${path}» сейчас изменяет другой параллельный этап — не трогай его. Сделай свою часть в других файлах или опиши в итоге, что нужно доделать в этом.`;
    }
    this.owners.set(key, stepId);
    return null;
  }
}
