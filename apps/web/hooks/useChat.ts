'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import type { ChatMessage, SendOptions } from '../types';
import { getProjectModel } from '../lib/modelStore';

/** How the last agent run ended. */
export interface RunSummary {
  ms: number;
  tokens: number;
  outcome: 'done' | 'stopped' | 'error' | 'limit';
}

export interface UsageInfo {
  model: string;
  used: number;
  ctx: number;
  generated: number;
  tps: number;
  estimated: boolean;
  compacted: number;
}
import { clearChatHistory, createChatSocket, deleteChatMessage, fetchChatHistory } from '../lib/api';

export interface QueuedMessage {
  id: string;
  content: string;
  images?: string[];
  options?: SendOptions;
}

const storageKey = (chatId?: number) => `otto-chat-${chatId ?? 'none'}`;

function loadStoredMessages(chatId?: number): ChatMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKey(chatId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // activity markers are transient - never restore them from cache
    return Array.isArray(parsed)
      ? parsed.filter((m: ChatMessage) => m?.role !== 'activity')
      : [];
  } catch {
    return [];
  }
}

export function useChat(projectId?: number, chatId?: number) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  // this run's clock and generated tokens (the live status line)
  const [runStats, setRunStats] = useState<{ startedAt: number; tokens: number } | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const messageIdCounter = useRef(0);
  const isProcessingRef = useRef(false);

  // Load persisted history from the backend when switching projects;
  // fall back to the local cache if the API is unreachable.
  useEffect(() => {
    let cancelled = false;
    setQueuedMessages([]);
    setIsProcessing(false);
    if (!projectId || !chatId) {
      messagesRef.current = [];
      setMessages([]);
      return;
    }
    messagesRef.current = [];
    setMessages([]);
    fetchChatHistory(chatId)
      .then((history) => {
        if (cancelled) return;
        // the first message of a brand-new chat is sent while its (empty) history is still loading:
        // keep what was added meanwhile instead of overwriting it with the loaded history
        setMessages((prev) => {
          const added = prev.filter((m) => !history.some((h) => h.role === m.role && h.content === m.content));
          const merged = added.length ? [...history, ...added] : history;
          messagesRef.current = merged;
          return merged;
        });
      })
      .catch(() => {
        if (!cancelled) {
          const history = loadStoredMessages(chatId);
          messagesRef.current = history;
          setMessages(history);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, chatId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Cache a copy locally (fallback when backend is down)
  useEffect(() => {
    if (typeof window === 'undefined' || messages.length === 0) return;
    // activity markers are transient - never cached
    const cacheable = messages.filter((m) => m.role !== 'activity');
    if (cacheable.length === 0) return;
    try {
      window.localStorage.setItem(storageKey(chatId), JSON.stringify(cacheable));
    } catch {
      // quota exceeded — keep only the second half
      try {
        const trimmed = cacheable.slice(Math.floor(cacheable.length / 2));
        window.localStorage.setItem(storageKey(chatId), JSON.stringify(trimmed));
      } catch {
        /* give up silently */
      }
    }
  }, [messages, chatId]);

  const generateId = useCallback(() => {
    messageIdCounter.current += 1;
    return `${Date.now()}-${messageIdCounter.current}`;
  }, []);

  // Keep ref in sync with state
  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  // a new run starts the clock; the end clears it
  useEffect(() => {
    setRunStats((prev) => (isProcessing ? prev ?? { startedAt: Date.now(), tokens: 0 } : null));
  }, [isProcessing]);

  // How the last run ended — shown under the messages so it is clear whether the agent is finished
  const runStatsRef = useRef(runStats);
  runStatsRef.current = runStats;
  const stoppedRef = useRef(false);
  const [lastRun, setLastRun] = useState<RunSummary | null>(null);
  useEffect(() => {
    if (isProcessing) {
      stoppedRef.current = false;
      setLastRun(null);
      return;
    }
    const stats = runStatsRef.current;
    if (!stats) return;
    const tail = [...messagesRef.current].reverse().find((m) => m.role === 'assistant' || m.role === 'system');
    const outcome: RunSummary['outcome'] = stoppedRef.current
      ? 'stopped'
      : tail?.isError
        ? 'error'
        : /лимит шагов|limit of file-work steps|adımlarının limitinə|ნაბიჯების ლიმიტს|limite di passaggi|límite de pasos/i.test(tail?.content ?? '')
          ? 'limit'
          : 'done';
    setLastRun({ ms: Date.now() - stats.startedAt, tokens: stats.tokens, outcome });
  }, [isProcessing]);

  const connect = useCallback(() => {
    if (!projectId) return;
    // Already connected — reuse the live socket (must be checked BEFORE close()).
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    // Tear down a stale socket that is still connecting/closing.
    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
      wsRef.current.close();
    }

    const ws = createChatSocket(
      (msg) => {
        // Tool activity frame: show it in chat and refresh Files after writes.
        const toolMsg = msg as unknown as { id?: string; role: string; tool?: string; result?: string };
        // the agent operates the app: open a tab, the preview, switch theme / language (page.tsx carries it out)
        if ((msg as unknown as { role: string }).role === 'ui') {
          window.dispatchEvent(new CustomEvent('otto:ui', { detail: msg }));
          return;
        }
        if ((msg as unknown as { role: string }).role === 'model_switch') {
          window.dispatchEvent(new CustomEvent('otto:model-switch', { detail: { model: (msg as unknown as { model: string }).model } }));
          return;
        }
        if ((msg as unknown as { role: string }).role === 'usage') {
          const info = msg as unknown as UsageInfo;
          setUsage(info);
          setRunStats((prev) => (prev ? { ...prev, tokens: prev.tokens + (info.generated || 0) } : prev));
          return;
        }
        if (toolMsg.role === 'tool') {
          const toolName = toolMsg.tool ?? '';
          if (['write_file', 'create_file', 'create_folder', 'move', 'delete_file', 'delete_path'].includes(toolName) && typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('otto:files-changed', { detail: { projectId } }));
          }
          // Rolling single activity line — replaces the previous one so the
          // chat doesn't bloat with dozens of "Reading/Listing/…" entries.
          setMessages((prev) => {
            const entry: ChatMessage = {
              id: 'activity-live',
              role: 'activity',
              event: 'tool_end',
              content: `${toolName} — ${String(toolMsg.result ?? '').slice(0, 140)}`,
              tool: toolName,
              timestamp: Date.now(),
            };
            const last = prev[prev.length - 1];
            if (last && last.role === 'activity' && last.id === 'activity-live') {
              const u = [...prev]; u[u.length - 1] = entry; return u;
            }
            return [...prev, entry];
          });
          return;
        }
        if (!msg.id) return;
        setMessages((prev) => {
          // Assistant answer arriving — drop the rolling activity line.
          const base = msg.role === 'assistant' ? prev.filter((m) => m.id !== 'activity-live') : prev;
          const idx = base.findIndex((m) => m.id === msg.id);
          if (idx >= 0) {
            const updated = [...base];
            updated[idx] = msg;
            return updated;
          }
          return [...base, msg];
        });
        if (msg.isStreaming === false || msg.isError || (msg.role === 'assistant' && !msg.isStreaming)) {
          setIsProcessing(false);
        }
      },
      (error) => {
        setMessages((prev) => [
          ...prev,
          {
            id: generateId(),
            role: 'system',
            content: error,
            timestamp: Date.now(),
            isError: true,
          },
        ]);
        setIsProcessing(false);
      },
      () => {
        setIsConnected(false);
        setIsProcessing(false);
      },
    );

    ws.onopen = () => {
      console.log('[WS] Connected to backend');
      setIsConnected(true);
    };
    wsRef.current = ws;
  }, [projectId, generateId]);

  // Auto-connect when projectId changes, with cleanup
  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  // Low-level WS dispatch (shared by send and regenerate)
  const dispatchPrompt = useCallback((prompt: string, images: string[] | undefined, clientMsgId: string, options?: SendOptions) => {
    let historyBudget = 12000;
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    const candidates = messagesRef.current
      .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.id !== clientMsgId)
      .slice(-12);
    for (let i = candidates.length - 1; i >= 0 && historyBudget > 0; i--) {
      const message = candidates[i];
      const fullContent = message.content || (message.images?.length ? '[Изображение приложено]' : '');
      if (!fullContent.trim()) continue;
      const content = fullContent.slice(-Math.min(4000, historyBudget));
      history.unshift({ role: message.role as 'user' | 'assistant', content });
      historyBudget -= content.length;
    }
    const payload = JSON.stringify({
      prompt,
      history,
      project_id: projectId,
      chat_id: chatId,
      images,
      client_msg_id: clientMsgId,
      // a message that carries no options (suggestion cards, "ask the AI" buttons, Retry) still uses
      // the model chosen for the project — never the server's default (Ollama)
      model: options?.model ?? getProjectModel(projectId) ?? undefined,
      use_tools: options?.useTools,
      use_context: options?.useContext,
      use_web: options?.useWeb,
      effort: options?.effort,
      num_ctx: options?.numCtx,
      temperature: options?.temperature,
    });

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(payload);
    } else {
      connect();
      setTimeout(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(payload);
        }
      }, 1000);
    }
  }, [projectId, chatId, connect]);

  // Internal send helper
  const sendRaw = useCallback((content: string, images?: string[], options?: SendOptions) => {
    if (!projectId) return;

    const userMsg: ChatMessage = {
      id: generateId(),
      role: 'user',
      content,
      timestamp: Date.now(),
      projectId,
      images,
      sendOptions: options,
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsProcessing(true);

    dispatchPrompt(content, images, userMsg.id, options);
  }, [projectId, generateId, dispatchPrompt]);

  // Send with queue support (queue=true forces waiting behind the current reply)
  const sendMessage = useCallback((content: string, images?: string[], options?: SendOptions, queue?: boolean) => {
    if (!projectId || !content.trim()) return;

    if (isProcessingRef.current || queue) {
      const qId = generateId();
      setQueuedMessages((prev) => [...prev, { id: qId, content: content.trim(), images, options }]);
      return;
    }
    sendRaw(content, images, options);
  }, [projectId, generateId, sendRaw]);

  // Watch isProcessing to drain queue
  useEffect(() => {
    if (isProcessing || queuedMessages.length === 0) return;
    const [next, ...rest] = queuedMessages;
    setQueuedMessages(rest);
    sendRaw(next.content, next.images, next.options);
  }, [isProcessing, queuedMessages, sendRaw]);

  // Stop generation
  const stopGeneration = useCallback(() => {
    stoppedRef.current = true;
    setIsProcessing(false);
    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
      wsRef.current.close();
    }
    // Reconnect for next message
    setTimeout(() => connect(), 100);
  }, [connect]);

  const disconnect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
      wsRef.current.close();
    }
    wsRef.current = null;
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setQueuedMessages([]);
  }, []);

  // Start a fresh conversation: drop local state and wipe server-side history.
  const newChat = useCallback(async () => {
    messagesRef.current = [];
    setMessages([]);
    setQueuedMessages([]);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(storageKey(chatId));
      } catch { /* ignore */ }
    }
    if (!chatId) return;
    try {
      await clearChatHistory(chatId);
    } catch {
      // backend unreachable — local view is already cleared
    }
  }, [chatId]);

  // Regenerate an assistant reply: drop it (and anything after it), then
  // re-send the original user prompt without adding a duplicate bubble.
  const regenerate = useCallback((assistantMsgId: string) => {
    if (!projectId || isProcessingRef.current) return;

    const target = messages.findIndex((m) => m.id === assistantMsgId);
    if (target < 0) return;

    // A user message is retried in place: its reply (if any) is dropped and
    // the same prompt is sent again.
    let userIdx = -1;
    let idx = target;
    if (messages[target].role === 'user') {
      userIdx = target;
      idx = target + 1;
    } else {
      for (let i = target - 1; i >= 0; i--) {
        if (messages[i].role === 'user') { userIdx = i; break; }
      }
    }
    if (userIdx < 0) return;
    const userMsg = messages[userIdx];

    const dropped = messages.slice(idx);
    const kept = messages.slice(0, idx);
    messagesRef.current = kept;
    setMessages(kept);
    setIsProcessing(true);

    // Remove the stale replies from persisted history (best effort).
    for (const m of dropped) {
      void deleteChatMessage(m.id).catch(() => { /* backend unreachable */ });
    }

    dispatchPrompt(userMsg.content, userMsg.images, userMsg.id, userMsg.sendOptions);
  }, [projectId, messages, dispatchPrompt]);

  return {
    messages,
    isConnected,
    isProcessing,
    queuedMessages,
    usage,
    runStats,
    lastRun,
    sendMessage,
    stopGeneration,
    disconnect,
    clearMessages,
    newChat,
    regenerate,
    connect,
  };
}
