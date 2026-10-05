/**
 * Checklist steps that may run at the same time.
 *
 * A step written as `∥ Write the export module` (or `|| …`, `[parallel] …`, `[параллельно] …`) runs together with
 * the step before it: the planner marks pieces that touch different files. Everything else is sequential.
 */

const MARKER = /^\s*(?:∥|\|\||\[\s*(?:параллельно|parallel|\|\|)\s*\])\s*/i;

export interface ParsedStep { title: string; parallel: boolean }

export function parseStep(text: string): ParsedStep {
  const m = MARKER.exec(text);
  return m ? { title: text.slice(m[0].length).trim(), parallel: true } : { title: text.trim(), parallel: false };
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
