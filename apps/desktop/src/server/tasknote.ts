/**
 * The project's task list as every model sees it (system prompt): "do the remaining ones", "continue",
 * "next task" mean these tasks, worked through in order and ticked off with otto_tasks.
 */

import type { TaskRow } from './db';

/** "выполни оставшиеся", "продолжай задачи", "next task"… */
export const asksForTasks = (prompt: string): boolean =>
  /(оставш|остальн|следующ\w* (задач|этап|шаг)|продолж\w*( работ| задач| выполн)?|доделай|по (списку|плану|задачам)|все задачи|remaining|the rest|next (task|step)|continue( the)? (tasks?|work|plan)|todo list|task list|qalan|növbəti|rimanent|restant|siguiente tarea)/i.test(prompt);

/** The note, or '' when the project has no tasks (and the request is not about them). */
export function tasksNote(tasks: TaskRow[], prompt: string): string {
  const wanted = asksForTasks(prompt);
  if (!tasks.length) return wanted ? 'The project task list (Tasks panel) is empty: say so, and offer to make a plan (otto_tasks action=add).' : '';
  const top = tasks.filter((t) => t.parent_id === null);
  const lines: string[] = [];
  for (const t of top) {
    lines.push(`#${t.id} [${t.status}] ${t.title}`);
    for (const s of tasks.filter((x) => x.parent_id === t.id)) lines.push(`   #${s.id} [${s.status}] ${s.title}`);
    if (lines.length > 40) { lines.push('…'); break; }
  }
  const open = tasks.filter((t) => t.status !== 'done').length;
  return [
    `Project task list (Otto's Tasks panel; ${open} not done):`,
    ...lines,
    wanted
      ? 'THE USER ASKS FOR THESE TASKS. Work through the unfinished ones in order (the steps of an in_progress task first): before each call otto_tasks action=update status=in_progress, do the work with tools, then mark it done. Do not invent other work; when all are done, say what was done per task.'
      : 'When the user says "do the remaining / continue / next task", they mean this list: take the unfinished items in order and tick them off with otto_tasks (in_progress → done).',
  ].join('\n');
}
