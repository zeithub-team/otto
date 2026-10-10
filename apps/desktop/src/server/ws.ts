/**
 * WebSocket chat.
 *
 * Endpoint: `ws://<host>/api/chat/ws/chat`
 *
 * A prompt starts a run of its chat (chatruns.ts). The run does not belong to the socket: closing it
 * (switching the project, reloading) only stops watching, and a socket that attaches to the chat later
 * gets the current state replayed. One chat runs one prompt at a time; different chats run side by side.
 *
 * Client frames: a prompt `{prompt, project_id, chat_id, …}`, or a control frame
 *   {action: 'attach', chat_id}                       — watch the chat (replays a running answer)
 *   {action: 'stop', chat_id}                         — stop its run
 *   {action: 'inject', chat_id, prompt, client_msg_id} — a message for the running agent (read at its next step)
 *   {action: 'update', chat_id, model?, num_ctx?, effort?} — switch the model / context / effort mid-run
 * Server frames: the answer chunks, plus `{role: 'run_state', chat_id, running, …}` when a run starts / ends.
 */
import { randomUUID } from 'crypto';
import * as http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import type { ServerDeps } from './api';
import { errorMessage } from './http';
import { generateResponse } from './ollama';
import { parseStep } from './steps';
import { isDirectory, resolvePath } from './paths';
import { tasksNote } from './tasknote';
import { applyRole, roleFor, roleOrChat, wantsExecution } from './roles';
import { startTaskRun } from './taskrunner';
import { activeRun, beginRun, controlOf, emit, endRun, injectMessage, stopRun, updateRun } from './chatruns';
import {
  interruptTerminal,
  onTerminalExit,
  onTerminalOutput,
  replayTail,
  sessionRunning,
  writeTerminal,
} from './terminal';

/** Path registered by FastAPI: `router.websocket("/ws/chat")` + prefix. */
export const CHAT_WS_PATH = '/api/chat/ws/chat';

interface ChatPayload {
  action?: unknown;
  prompt?: unknown;
  history?: unknown;
  project_id?: unknown;
  images?: unknown;
  model?: unknown;
  use_tools?: unknown;
  use_context?: unknown;
  use_web?: unknown;
  effort?: unknown;
  num_ctx?: unknown;
  temperature?: unknown;
  client_msg_id?: unknown;
  chat_id?: unknown;
}

/** `{"role": "system", …, "id": "local"}` validation/error chunk. */
function systemChunk(content: string): string {
  return JSON.stringify({
    role: 'system',
    content,
    id: 'local',
    timestamp: Math.floor(Date.now() / 1000), // Python: int(time.time())
    isError: true,
  });
}

function sendSystem(ws: WebSocket, content: string): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(systemChunk(content));
}

/** Everyone watching a chat (one set per chat, shared with its run). */
const viewers = new Map<number, Set<(chunk: string) => void>>();
function viewersOf(chatId: number): Set<(chunk: string) => void> {
  let set = viewers.get(chatId);
  if (!set) { set = new Set(); viewers.set(chatId, set); }
  return set;
}

/** The prompts waiting in each chat (one run at a time per chat). */
const chatQueues = new Map<string, Promise<void>>();

const runState = (chatId: number, running: boolean, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ role: 'run_state', chat_id: chatId, running, ...extra });

/** One prompt → one run of its chat; messages typed meanwhile that it never read become the next prompt. */
async function handlePrompt(ws: WebSocket | null, messageData: ChatPayload, deps: ServerDeps, watch: (chatId: number) => void): Promise<void> {
  const reply = (text: string): void => { if (ws) sendSystem(ws, text); };
  const prompt = typeof messageData.prompt === 'string' ? messageData.prompt : '';
  const history = Array.isArray(messageData.history) ? messageData.history : [];
  const projectIdRaw = messageData.project_id;
  const images = Array.isArray(messageData.images) ? (messageData.images as string[]) : null;
  const model = typeof messageData.model === 'string' ? messageData.model : null;
  const useTools =
    typeof messageData.use_tools === 'boolean' ? messageData.use_tools : null;
  const useContext =
    typeof messageData.use_context === 'boolean' ? messageData.use_context : null;
  const useWeb =
    typeof messageData.use_web === 'boolean' ? messageData.use_web : null;

  if (!prompt) {
    reply('Введите сообщение.');
    return;
  }
  if (projectIdRaw === null || projectIdRaw === undefined) {
    reply('Выберите проект перед отправкой сообщения.');
    return;
  }
  const projectId = Number(projectIdRaw);

  let projectPath: string;
  try {
    const storedPath = deps.db.getProjectPath(projectId);
    if (storedPath === null) {
      reply('Выберите проект перед отправкой сообщения.');
      return;
    }
    projectPath = resolvePath(storedPath);
    if (!isDirectory(projectPath)) {
      reply('Папка проекта не найдена.');
      return;
    }
  } catch (exc) {
    reply(`Не удалось открыть проект: ${errorMessage(exc)}`);
    return;
  }

  const messageId = randomUUID();
  // Resolve the target chat (create a default one if none was supplied).
  let chatId: number;
  try {
    const raw = messageData.chat_id;
    chatId = typeof raw === 'number' && raw > 0 ? raw : deps.db.ensureChat(projectId).id;
  } catch (exc) {
    reply(`Не удалось открыть чат: ${errorMessage(exc)}`);
    return;
  }
  // a new chat made for this prompt: its window watches it (a known chat was watched on arrival)
  if (!(typeof messageData.chat_id === 'number' && messageData.chat_id > 0)) watch(chatId);
  // Persist the user's message so history survives reloads (id matches the
  // client-generated bubble id when provided).
  try {
    const clientMsgId = (messageData.client_msg_id as string | undefined) || messageId;
    deps.db.saveMessage(clientMsgId, projectId, chatId, 'user', prompt, images);
  } catch (exc) {
    console.log(`[history] failed to save user msg: ${String(exc)}`);
  }

  // model roles: plans / audits go to the planner, work to the coder (Settings → Models → Model roles)
  const ru = /[а-яё]/i.test(prompt);
  const role = useTools === false ? null : roleFor(prompt);
  const chatEffort = typeof messageData.effort === 'string' ? messageData.effort : null;
  const pick = role ? applyRole(role, model, chatEffort, ru) : { model, effort: chatEffort, label: '' };
  const run = beginRun({ chatId, projectId, messageId, prompt, model: pick.model }, viewersOf(chatId));
  const send = (chunk: string): void => emit(run, chunk);
  send(runState(chatId, true, { model, started_at: run.startedAt, prompt: prompt.slice(0, 200) }));

  const toolEvents: { name: string; args: unknown; result: string }[] = [];
  /** The task the planner made in this run (the coder may carry it out right after). */
  let planned: number | null = null;
  const stream = generateResponse({
    prompt,
    messageId,
    projectId,
    projectPath,
    history,
    images,
    model: pick.model,
    useTools,
    useContext,
    useWeb,
    effort: pick.effort,
    leadNotice: pick.label || undefined,
    numCtx: typeof messageData.num_ctx === 'number' ? messageData.num_ctx : null,
    temperature: typeof messageData.temperature === 'number' ? messageData.temperature : null,
    // a person is in the chat: run_command can ask them before running anything
    interactive: true,
    tasksNote: (() => { try { return tasksNote(deps.db.listTasks(projectId), prompt); } catch { return ''; } })(),
    signal: run.controller.signal,
    control: controlOf(run),
    onCreateTask: (title, detail) => {
      try {
        deps.db.createTask(projectId, title, detail, 'agent');
        send(JSON.stringify({ role: 'ui', action: 'tasks-changed' }));
      } catch (exc) {
        console.log(`[tasks] agent create_task failed: ${String(exc)}`);
      }
    },
    onPlanTask: (title, steps) => {
      try {
        const parent = deps.db.createTask(projectId, title, '', 'agent');
        planned = parent.id;
        for (const raw of steps) {
          const step = parseStep(raw);
          deps.db.createTask(projectId, step.title, '', 'agent', parent.id, step.parallel);
        }
        send(JSON.stringify({ role: 'ui', action: 'tasks-changed' }));
      } catch (exc) {
        console.log(`[tasks] agent plan_task failed: ${String(exc)}`);
      }
    },
    onModelSwitch: (switched) => {
      run.model = switched;
      send(JSON.stringify({ role: 'model_switch', model: switched, chat_id: chatId }));
    },
    onUi: (action) => {
      send(JSON.stringify({ role: 'ui', ...action }));
    },
    onUsage: (usage) => {
      send(JSON.stringify({ role: 'usage', ...usage }));
    },
    onToolEvent: (name, args, result) => {
      toolEvents.push({ name, args, result });
      // Surface tool activity in the chat UI (also drives Files auto-refresh).
      send(JSON.stringify({
        role: 'tool', tool: name, args, result: String(result).slice(0, 400),
        id: `tool-${randomUUID()}`, timestamp: Math.floor(Date.now() / 1000),
      }));
    },
  });

  let finalContent: Record<string, unknown> | null = null;
  const persist = (): void => {
    // Persist the final assistant answer (id matches what the client shows)
    if (finalContent === null) {
      console.log('[history] no final assistant chunk captured (not saved)');
      return;
    }
    const finalText = typeof finalContent.content === 'string' ? finalContent.content : '';
    if (!finalText.trim()) {
      // Never save an empty assistant bubble (failed/empty generation).
      console.log('[history] final assistant content empty (not saved)');
      return;
    }
    try {
      deps.db.saveMessage(
        String(finalContent.id),
        projectId,
        chatId,
        'assistant',
        finalText,
        null,
        false,
        typeof finalContent.timestamp === 'number' ? finalContent.timestamp : null,
      );
    } catch (exc) {
      console.log(`[history] failed to save assistant msg: ${String(exc)}`);
    }
    // Per-project run log: prompt, model, tool calls, final answer.
    try {
      deps.db.addProjectLog(projectId, chatId, {
        prompt,
        model: run.model,
        tools: toolEvents,
        answer: finalText,
      });
    } catch (exc) {
      console.log(`[log] failed to save project log: ${String(exc)}`);
    }
  };

  // the run goes on whether or not anyone is watching: the answer is saved at the end either way
  try {
    for await (const chunk of stream) {
      send(chunk);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(chunk) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (
        parsed.role === 'assistant' &&
        !parsed.isStreaming &&
        !parsed.isError
      ) {
        finalContent = parsed;
      }
    }
  } catch (exc) {
    send(systemChunk(errorMessage(exc)));
  } finally {
    persist();
    endRun(run);
    send(runState(chatId, false, { model: run.model }));
  }
  // "audit and fix", "make tasks and do them": the coder runs the plan stage by stage (task board, Agents tab)
  if (role === 'planner' && planned !== null && wantsExecution(prompt) && !run.controller.signal.aborted) {
    try {
      const coder = roleOrChat('coder', model, chatEffort);
      startTaskRun(deps, planned, coder.model);
      const note = JSON.stringify({
        role: 'assistant', id: `chain-${messageId}`, timestamp: Math.floor(Date.now() / 1000), projectId, isStreaming: false,
        content: ru
          ? `🔧 План передан исполнителю${coder.model ? ` (${coder.model})` : ''}: этапы выполняются по очереди — прогресс в панели задач и во вкладке «Агенты».`
          : `🔧 The plan went to the coder${coder.model ? ` (${coder.model})` : ''}: its stages run one by one — progress in the task panel and the Agents tab.`,
      });
      for (const l of viewersOf(chatId)) l(note);
      for (const l of viewersOf(chatId)) l(JSON.stringify({ role: 'ui', action: 'tasks-changed' }));
    } catch (exc) {
      console.log(`[roles] chain failed: ${String(exc)}`);
    }
  }
  // messages typed meanwhile that the agent never read (a CLI model, or the run ended first): the next prompt
  const left = run.inbox.splice(0);
  if (left.length && !run.controller.signal.aborted) {
    enqueue(String(chatId), () => handlePrompt(null, { ...messageData, prompt: left.join('\n\n'), chat_id: chatId, client_msg_id: undefined, images: undefined }, deps, () => undefined));
  }
}

function enqueue(key: string, job: () => Promise<void>): void {
  const prev = chatQueues.get(key) ?? Promise.resolve();
  const next = prev.then(() => job().catch((exc) => { console.error('[ws] message failed:', exc); }));
  chatQueues.set(key, next);
  void next.finally(() => { if (chatQueues.get(key) === next) chatQueues.delete(key); });
}

/**
 * Attach the chat WebSocket to an HTTP server (`noServer` upgrade so the
 * REST routes and the renderer stay on the same listener).
 */
export function attachChatWs(
  server: http.Server,
  deps: ServerDeps,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    const listener = (chunk: string): void => { if (ws.readyState === WebSocket.OPEN) ws.send(chunk); };
    const watching = new Set<number>();
    // a window shows one chat: watching another one stops watching the previous (its run goes on)
    const watch = (chatId: number): void => {
      if (watching.has(chatId)) return;
      for (const id of watching) viewersOf(id).delete(listener);
      watching.clear();
      watching.add(chatId);
      viewersOf(chatId).add(listener);
    };
    ws.on('error', () => {
      /* the peer went away — nothing to do */
    });
    // closing the socket only stops watching: runs go on
    ws.on('close', () => {
      for (const id of watching) viewersOf(id).delete(listener);
      watching.clear();
    });
    ws.on('message', (data) => {
      const raw = typeof data === 'string' ? data : data.toString('utf8');
      let frame: ChatPayload;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('not an object');
        frame = parsed as ChatPayload;
      } catch {
        ws.close();
        return;
      }
      const chatId = typeof frame.chat_id === 'number' ? frame.chat_id : 0;
      const action = typeof frame.action === 'string' ? frame.action : '';
      if (action === 'attach') {
        if (!chatId) return;
        watch(chatId);
        const run = activeRun(chatId);
        listener(runState(chatId, Boolean(run), run ? { model: run.model, started_at: run.startedAt, prompt: run.prompt.slice(0, 200) } : {}));
        if (run) for (const chunk of run.latest.values()) listener(chunk);
        return;
      }
      if (action === 'stop') {
        if (chatId) stopRun(chatId);
        return;
      }
      if (action === 'update') {
        if (!chatId) return;
        updateRun(chatId, {
          model: typeof frame.model === 'string' && frame.model ? frame.model : undefined,
          numCtx: typeof frame.num_ctx === 'number' ? frame.num_ctx : undefined,
          effort: typeof frame.effort === 'string' ? frame.effort : undefined,
        });
        return;
      }
      if (action === 'inject') {
        const text = typeof frame.prompt === 'string' ? frame.prompt : '';
        const run = chatId ? activeRun(chatId) : undefined;
        if (run && injectMessage(chatId, text)) {
          try {
            deps.db.saveMessage(String(frame.client_msg_id || randomUUID()), run.projectId, chatId, 'user', text, null);
          } catch (exc) {
            console.log(`[history] failed to save injected msg: ${String(exc)}`);
          }
          listener(JSON.stringify({ role: 'injected', chat_id: chatId, client_msg_id: frame.client_msg_id ?? null }));
          return;
        }
        // nothing runs any more: an ordinary prompt
      }
      if (chatId) watch(chatId);
      const key = chatId ? String(chatId) : `p${String(frame.project_id ?? '')}`;
      enqueue(key, () => handlePrompt(ws, frame, deps, watch));
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname !== CHAT_WS_PATH) {
      // Other upgrade routes (e.g. the terminal socket below) have their own
      // listeners — ignore instead of destroying.
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  return wss;
}


// ---------------------------------------------------------------------------
// Terminal socket: live stdio of a project shell session (terminal.ts).
//
// Endpoint: `ws://<host>/api/terminal/ws`
//
// Client frames (JSON):
//   {"action": "attach", "session_id": "<uuid>"}  — subscribe + replay tail
//   {"action": "input", "session_id": "<uuid>", "data": "ls\n"}
//   {"action": "interrupt", "session_id": "<uuid>"} — best-effort Ctrl+C
//   {"action": "ping"} — keepalive
//
// Server frames (JSON):
//   {"type": "attached", "session_id": …}     — subscribe ok
//   {"type": "output", "session_id": …, "data": …}
//   {"type": "exit", "session_id": …, "code": …}
//   {"type": "error", "message": …, "session_id"?: …}
//   {"type": "pong"}
export const TERMINAL_WS_PATH = '/api/terminal/ws';

interface TerminalFrame {
  action?: unknown;
  session_id?: unknown;
  data?: unknown;
}

function termSend(ws: WebSocket, frame: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function termError(ws: WebSocket, message: string, sessionId?: string): void {
  termSend(ws, { type: 'error', message, ...(sessionId ? { session_id: sessionId } : {}) });
}

export function attachTerminalWs(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    let detach: (() => void) | null = null;
    let detachExit: (() => void) | null = null;
    const cleanup = (): void => {
      if (detach) {
        detach();
        detach = null;
      }
      if (detachExit) {
        detachExit();
        detachExit = null;
      }
    };
    ws.on('error', () => {
      /* the peer went away — nothing to do */
    });
    ws.on('close', cleanup);
    ws.on('message', (data) => {
      let frame: TerminalFrame;
      try {
        const parsed: unknown = JSON.parse(
          typeof data === 'string' ? data : data.toString('utf8'),
        );
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new TypeError('not an object');
        }
        frame = parsed as TerminalFrame;
      } catch {
        termError(ws, 'Некорректный JSON-кадр.');
        return;
      }
      const action = typeof frame.action === 'string' ? frame.action : '';
      if (action === 'ping') {
        termSend(ws, { type: 'pong' });
        return;
      }
      const sessionId =
        typeof frame.session_id === 'string' ? frame.session_id : '';
      if (action === 'attach') {
        if (!sessionId) {
          termError(ws, 'Нужен session_id.');
          return;
        }
        const tail = replayTail(sessionId);
        if (tail === null) {
          termError(ws, 'Сессия не найдена (возможно, сервер перезапускался).', sessionId);
          return;
        }
        cleanup();
        detach = onTerminalOutput(sessionId, (chunk) => {
          termSend(ws, { type: 'output', session_id: sessionId, data: chunk });
        });
        detachExit = onTerminalExit(sessionId, (code) => {
          termSend(ws, { type: 'exit', session_id: sessionId, code });
        });
        termSend(ws, { type: 'attached', session_id: sessionId });
        if (tail) {
          termSend(ws, { type: 'output', session_id: sessionId, data: tail });
        }
        if (!sessionRunning(sessionId)) {
          termSend(ws, { type: 'exit', session_id: sessionId, code: null });
        }
        return;
      }
      if (action === 'input') {
        if (!sessionId || typeof frame.data !== 'string' || !frame.data) return;
        if (!writeTerminal(sessionId, frame.data)) {
          termError(ws, 'Сессия завершена — запустите новую.', sessionId);
        }
        return;
      }
      if (action === 'interrupt') {
        if (!sessionId) return;
        if (!interruptTerminal(sessionId)) {
          termError(ws, 'Сессия завершена — запустите новую.', sessionId);
        }
        return;
      }
      termError(ws, `Неизвестное действие: ${action || '—'}.`);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname !== TERMINAL_WS_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  return wss;
}
