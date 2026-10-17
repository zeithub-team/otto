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
    const declared = afterOf(s.detail).map((n) => n - 1).filter((n) => n >= 0 && n < i);
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
