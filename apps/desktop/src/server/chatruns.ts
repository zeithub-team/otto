/**
 * Chat runs that live apart from the socket that started them.
 *
 * A run belongs to a chat: switching the project or reloading the window only detaches the viewer, the
 * agent keeps working, and an attached socket gets the current state replayed. While it works the chat can
 * stop it, add a message (a clarification the model reads at its next step) or switch the model / context
 * (RunControl in ollama.ts). Runs of different chats work side by side; one chat runs one prompt at a time.
 */

import type { RunControl } from './ollama';

export interface ChatRun {
  chatId: number;
  projectId: number;
  messageId: string;
  prompt: string;
  model: string | null;
  startedAt: number;
  controller: AbortController;
  /** Messages typed meanwhile, not yet read by the model. */
  inbox: string[];
  overrides: { model?: string; numCtx?: number; effort?: string } | null;
  /** The latest chunk of every message id (assistant, thinking, approvals…): replayed to a new viewer. */
  latest: Map<string, string>;
  listeners: Set<(chunk: string) => void>;
}

const runs = new Map<number, ChatRun>();

export const activeRun = (chatId: number): ChatRun | undefined => runs.get(chatId);
export const listChatRuns = (): ChatRun[] => [...runs.values()];

export function beginRun(r: Omit<ChatRun, 'controller' | 'inbox' | 'overrides' | 'latest' | 'listeners' | 'startedAt'>, listeners: Set<(chunk: string) => void>): ChatRun {
  const run: ChatRun = { ...r, startedAt: Date.now(), controller: new AbortController(), inbox: [], overrides: null, latest: new Map(), listeners };
  runs.set(r.chatId, run);
  return run;
}

export function endRun(run: ChatRun): void {
  if (runs.get(run.chatId) === run) runs.delete(run.chatId);
}

/** Sends a chunk to everyone watching the chat and keeps it for a later viewer. */
export function emit(run: ChatRun, chunk: string): void {
  try {
    const id = (JSON.parse(chunk) as { id?: unknown }).id;
    if (typeof id === 'string' && id) {
      run.latest.delete(id); // keep arrival order
      run.latest.set(id, chunk);
      // tool lines are many and short-lived: only the last few are replayed
      const tools = [...run.latest.keys()].filter((k) => k.startsWith('tool-'));
      if (tools.length > 20) run.latest.delete(tools[0]);
    }
  } catch { /* not JSON */ }
  for (const l of run.listeners) l(chunk);
}

export function stopRun(chatId: number): boolean {
  const run = runs.get(chatId);
  if (!run) return false;
  run.controller.abort();
  return true;
}

/** A message for the running agent; false when nothing runs in the chat. */
export function injectMessage(chatId: number, text: string): boolean {
  const run = runs.get(chatId);
  if (!run || !text.trim()) return false;
  run.inbox.push(text.trim());
  return true;
}

export function updateRun(chatId: number, patch: { model?: string; numCtx?: number; effort?: string }): boolean {
  const run = runs.get(chatId);
  if (!run) return false;
  run.overrides = { ...(run.overrides ?? {}), ...patch };
  if (patch.model) run.model = patch.model;
  return true;
}

export function controlOf(run: ChatRun): RunControl {
  return {
    takeMessages: () => run.inbox.splice(0),
    takeOverrides: () => { const o = run.overrides; run.overrides = null; return o; },
  };
}
