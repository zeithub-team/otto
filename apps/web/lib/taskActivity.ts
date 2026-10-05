/** What a running task step is doing, as a short human line ("Reading src/app.tsx · 1:23"). */

export interface StepActivity { tool: string; path?: string; at: number }

const VERB: Record<string, string> = {
  read_file: 'act.reading', read_files: 'act.reading',
  write_file: 'act.writing', append_file: 'act.writing', delete_file: 'act.deleting',
  web_search: 'act.web', fetch_url: 'act.page',
  plan_task: 'act.planning', create_task: 'act.planning',
  list_files: 'act.listing', search_files: 'act.searching',
};

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function activityLine(
  t: (key: string, vars?: Record<string, string | number>) => string,
  activity: StepActivity | undefined,
  startedAt: number | undefined,
  now: number,
): string {
  const elapsed = startedAt ? ` · ${formatElapsed(now - startedAt)}` : '';
  if (activity?.tool === 'wait') return `${t('tasks.limitWait')}${elapsed}`;
  if (!activity || activity.tool === 'start') return `${t('tasks.starting')}${elapsed}`;
  const verb = t(VERB[activity.tool] ?? 'act.working');
  return `${verb}${activity.path ? ` ${activity.path}` : ''}${elapsed}`;
}
