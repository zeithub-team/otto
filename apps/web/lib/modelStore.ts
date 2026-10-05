/**
 * The AI model of a project. One choice per project, read by everything that talks to a model:
 * the chat, background agents and task runs. The last choice also sits under a global key that
 * tasks (which know no project) read, and that a project without its own choice starts from.
 */

const GLOBAL_KEY = 'otto-selected-model';
const projectKey = (projectId: number): string => `${GLOBAL_KEY}:${projectId}`;

export interface ModelChanged { projectId?: number | null; model: string }

/** The model chosen for the project (else the last one chosen anywhere), or null. */
export function getProjectModel(projectId?: number | null): string | null {
  try {
    return (projectId ? window.localStorage.getItem(projectKey(projectId)) : null) || window.localStorage.getItem(GLOBAL_KEY) || null;
  } catch {
    return null;
  }
}

/** Remember the model for the project and tell the other views. */
export function setProjectModel(projectId: number | null | undefined, model: string): void {
  try {
    if (projectId) window.localStorage.setItem(projectKey(projectId), model);
    window.localStorage.setItem(GLOBAL_KEY, model);
  } catch { /* storage unavailable: the choice lives in memory only */ }
  window.dispatchEvent(new CustomEvent<ModelChanged>('otto:model-changed', { detail: { projectId, model } }));
}

/** Make the global key follow the project being shown (tasks read it). */
export function syncGlobalModel(projectId?: number | null): string | null {
  const model = getProjectModel(projectId);
  try { if (model) window.localStorage.setItem(GLOBAL_KEY, model); } catch { /* ignore */ }
  return model;
}
