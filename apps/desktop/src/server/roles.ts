/**
 * Model roles: one model thinks, another one does.
 *
 *   planner — plans, task lists, audits, reviews, architecture ("create tasks", "audit the project", "why…")
 *   coder   — the work itself (writing code, fixing, running the steps of a plan)
 *
 * Settings → Models → Model roles: `roles.mode` auto | off, and per role a model (empty = the chat's
 * model) and an effort. The default — the same model thinking on high and working on low — needs no
 * setup; a strong local model planning for a fast local coder, or a cloud planner with a local coder,
 * are a click away (the schemes in the settings card).
 */

import { live } from './appconfig';

export type Role = 'planner' | 'coder';

/** Plans, task lists, audits, reviews, analysis. */
const PLAN = /(созда[а-яёa-z]*|состав[а-яёa-z]*|сделай|напиши|распиши|подготов[а-яёa-z]*|набросай)\s+(\S+\s+)?(задач|план|чек.?лист|этап|roadmap|роадмап|бэклог|backlog)|(аудит|audit|ревью|review|code review|проанализ|анализ|analy[sz]|разбер(и|ись)|изучи проект|оцени|архитектур|architect|спланир|plan\b|planning|break (it )?down|разбей на|декомпоз|найди (проблем|баг|ошибк|уязвим)|find (bugs|issues|problems)|что (не так|улучшить)|tapşırıq yarat|planla)/i;
/** Work to be done with tools. */
const WORK = /(созда|напиш|сделай|исправ|почин|добав|удал|замени|поменя|перепиш|рефактор|реализ|внедр|подключ|настро|запуст|выполни|доделай|продолж|build|create|write|make|fix|add|remove|delete|replace|refactor|implement|run\b|start|do the|continue|apply)/i;
/** The planner was asked to also carry the plan out ("…and fix it", "create tasks and do them"). */
const AND_DO = /(и|затем|потом|после чего|,)\s*(сразу\s+)?(исправ|почин|сделай|выполни|реализ|внедр|доделай|примени|напиши код)|(and|then)\s+(fix|do|implement|apply|execute|carry)/i;

/** The role a chat message needs, or null (a plain question, or roles are off). */
export function roleFor(prompt: string): Role | null {
  if (live<string>('roles.mode') !== 'auto') return null;
  const p = prompt.trim();
  if (PLAN.test(p)) return 'planner';
  if (WORK.test(p)) return 'coder';
  return null;
}

/** "Audit and fix", "make tasks and do them": after the plan, the coder runs it. */
export const wantsExecution = (prompt: string): boolean => live<boolean>('roles.chain') !== false && AND_DO.test(prompt);

export interface RolePick { model: string | null; effort: string | null; label: string }

/** The model and effort of a role; the chat's own choice fills what the role leaves empty. */
export function applyRole(role: Role, chatModel: string | null, chatEffort: string | null, ru = false): RolePick {
  const model = String(live<string>(`roles.${role}.model`) || '').trim() || chatModel;
  const eff = String(live<string>(`roles.${role}.effort`) || 'auto');
  const effort = eff === 'auto' ? chatEffort : eff;
  const icon = role === 'planner' ? '🧠' : '🔧';
  const name = role === 'planner' ? (ru ? 'Планировщик' : 'Planner') : (ru ? 'Исполнитель' : 'Coder');
  return { model, effort, label: `${icon} ${name} · ${model ?? (ru ? 'модель по умолчанию' : 'default model')}${effort ? ` · ${effort}` : ''}` };
}

/** For runs that know their role (task board: plan = planner, steps = coder) whatever the prompt says. */
export function roleOrChat(role: Role, chatModel: string | null, chatEffort: string | null = null): RolePick {
  if (live<string>('roles.mode') !== 'auto') return { model: chatModel, effort: chatEffort, label: '' };
  return applyRole(role, chatModel, chatEffort);
}
