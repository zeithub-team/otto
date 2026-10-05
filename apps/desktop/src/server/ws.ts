/**
 * WebSocket chat — port of `backend/api/chat.py` (`websocket_endpoint`).
 *
 * Endpoint: `ws://<host>/api/chat/ws/chat`
 *
 * Messages are processed strictly sequentially (the Python `while True`
 * loop `await`s one generation before reading the next frame — the frontend
 * queues its own messages behind that), a generation is stopped by closing
 * the socket (`useChat.stopGeneration()`), and the final assistant answer is
 * persisted whether the stream finished, failed or the client disconnected.
 */
import { randomUUID } from 'crypto';
import * as http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import type { ServerDeps } from './api';
import { errorMessage } from './http';
import { generateResponse } from './ollama';
import { parseStep } from './steps';
import { isDirectory, resolvePath } from './paths';
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

/** One incoming frame → zero or more outgoing chunks. */
async function handleFrame(ws: WebSocket, raw: string, deps: ServerDeps): Promise<void> {
  let messageData: ChatPayload;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('not an object');
    }
    messageData = parsed as ChatPayload;
  } catch {
    // Python: `json.loads` raises inside the endpoint → connection is closed.
    ws.close();
    return;
  }

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
    sendSystem(ws, 'Введите сообщение.');
    return;
  }
  if (projectIdRaw === null || projectIdRaw === undefined) {
    sendSystem(ws, 'Выберите проект перед отправкой сообщения.');
    return;
  }
  const projectId = Number(projectIdRaw);

  let projectPath: string;
  try {
    const storedPath = deps.db.getProjectPath(projectId);
    if (storedPath === null) {
      sendSystem(ws, 'Выберите проект перед отправкой сообщения.');
      return;
    }
    projectPath = resolvePath(storedPath);
    if (!isDirectory(projectPath)) {
      sendSystem(ws, 'Папка проекта не найдена.');
      return;
    }
  } catch (exc) {
    sendSystem(ws, `Не удалось открыть проект: ${errorMessage(exc)}`);
    return;
  }

  const messageId = randomUUID();
  // Resolve the target chat (create a default one if none was supplied).
  let chatId: number;
  try {
    const raw = messageData.chat_id;
    chatId = typeof raw === 'number' && raw > 0 ? raw : deps.db.ensureChat(projectId).id;
  } catch (exc) {
    sendSystem(ws, `Не удалось открыть чат: ${errorMessage(exc)}`);
    return;
  }
  // Persist the user's message so history survives reloads (id matches the
  // client-generated bubble id when provided).
  try {
    const clientMsgId = (messageData.client_msg_id as string | undefined) || messageId;
    deps.db.saveMessage(clientMsgId, projectId, chatId, 'user', prompt, images);
  } catch (exc) {
    console.log(`[history] failed to save user msg: ${String(exc)}`);
  }

  const toolEvents: { name: string; args: unknown; result: string }[] = [];
  const stream = generateResponse({
    prompt,
    messageId,
    projectId,
    projectPath,
    history,
    images,
    model,
    useTools,
    useContext,
    useWeb,
    effort: typeof messageData.effort === 'string' ? messageData.effort : null,
    numCtx: typeof messageData.num_ctx === 'number' ? messageData.num_ctx : null,
    temperature: typeof messageData.temperature === 'number' ? messageData.temperature : null,
    // a person is in the chat: run_command can ask them before running anything
    interactive: true,
    onCreateTask: (title, detail) => {
      try {
        deps.db.createTask(projectId, title, detail, 'agent');
      } catch (exc) {
        console.log(`[tasks] agent create_task failed: ${String(exc)}`);
      }
    },
    onPlanTask: (title, steps) => {
      try {
        const parent = deps.db.createTask(projectId, title, '', 'agent');
        for (const raw of steps) {
          const step = parseStep(raw);
          deps.db.createTask(projectId, step.title, '', 'agent', parent.id, step.parallel);
        }
      } catch (exc) {
        console.log(`[tasks] agent plan_task failed: ${String(exc)}`);
      }
    },
    onModelSwitch: (switched) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ role: 'model_switch', model: switched }));
    },
    onUi: (action) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ role: 'ui', ...action }));
    },
    onUsage: (usage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ role: 'usage', ...usage }));
    },
    onToolEvent: (name, args, result) => {
      toolEvents.push({ name, args, result });
      // Surface tool activity in the chat UI (also drives Files auto-refresh).
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          role: 'tool', tool: name, args, result: String(result).slice(0, 400),
          id: `tool-${randomUUID()}`, timestamp: Math.floor(Date.now() / 1000),
        }));
      }
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
        model: typeof model === 'string' ? model : null,
        tools: toolEvents,
        answer: finalText,
      });
    } catch (exc) {
      console.log(`[log] failed to save project log: ${String(exc)}`);
    }
  };

  try {
    for await (const chunk of stream) {
      if (ws.readyState !== WebSocket.OPEN) {
        // The client often closes right after the final chunk — save first.
        persist();
        return;
      }
      ws.send(chunk);
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
    persist();
    sendSystem(ws, errorMessage(exc));
    return;
  }
  persist();
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
  let queue: Promise<void> = Promise.resolve();

  wss.on('connection', (ws) => {
    ws.on('error', () => {
      /* the peer went away — nothing to do */
    });
    ws.on('message', (data) => {
      const raw = typeof data === 'string' ? data : data.toString('utf8');
      // Python handles frames one at a time: chain onto the running task.
      queue = queue.then(() =>
        handleFrame(ws, raw, deps).catch((exc) => {
          console.error('[ws] message failed:', exc);
        }),
      );
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
