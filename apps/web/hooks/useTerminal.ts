'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createTerminalSocket, listTerminals, startTerminal, stopTerminal,
  type TerminalFrame,
} from '../lib/api';
import type { TerminalSessionMeta } from '../types';
import { tt } from '../lib/i18n';

export interface TermLine {
  id: number;
  kind: 'in' | 'out' | 'sys';
  text: string;
}

/** Strip ANSI color/cursor sequences; normalize \r\n and lone \r. */
function cleanChunk(data: string): string {
  return data
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

const MAX_LINES = 2000;
const quickKey = (pid?: number) => `otto-quickcmds-${pid ?? 'none'}`;

function loadQuick(pid?: number): string[] {
  if (typeof window === 'undefined' || !pid) return [];
  try {
    const raw = window.localStorage.getItem(quickKey(pid));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string').slice(0, 20) : [];
  } catch {
    return [];
  }
}

let lineId = 0;
const nextId = () => ++lineId;

export type UseTerminal = ReturnType<typeof useTerminal>;

export function useTerminal(projectId?: number) {
  const [sessions, setSessions] = useState<TerminalSessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [lines, setLines] = useState<Record<string, TermLine[]>>({});
  const [connected, setConnected] = useState(false);
  const [starting, setStarting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [quick, setQuick] = useState<string[]>(() => loadQuick(projectId));
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Record<string, string>>({});
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  const pushLines = useCallback((sid: string, kind: TermLine['kind'], text: string) => {
    const parts = text.split('\n');
    setLines((prev) => {
      const cur = prev[sid] ?? [];
      const add = parts
        .filter((p, i) => i < parts.length - 1 || p.length > 0)
        .map((p) => ({ id: nextId(), kind, text: p || ' ' }));
      if (!add.length) return prev;
      return { ...prev, [sid]: [...cur, ...add].slice(-MAX_LINES) };
    });
  }, []);

  const pushData = useCallback((sid: string, data: string) => {
    const cleaned = cleanChunk(data);
    const buf = (pendingRef.current[sid] ?? '') + cleaned;
    const idx = buf.lastIndexOf('\n');
    if (idx < 0) {
      pendingRef.current[sid] = buf.slice(-4000);
      return;
    }
    pendingRef.current[sid] = buf.slice(idx + 1);
    pushLines(sid, 'out', buf.slice(0, idx + 1));
  }, [pushLines]);

  const sysLine = useCallback((sid: string, text: string) => {
    const rest = pendingRef.current[sid];
    if (rest) {
      pendingRef.current[sid] = '';
      pushLines(sid, 'out', rest);
    }
    pushLines(sid, 'sys', text);
  }, [pushLines]);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setSessions([]);
      setActiveId(null);
      return;
    }
    const list = await listTerminals(projectId).catch(() => []);
    setSessions(list);
    setActiveId((prev) => {
      if (prev && list.some((s) => s.id === prev)) return prev;
      const running = list.find((s) => s.running);
      return (running ?? list[0])?.id ?? null;
    });
    // drop buffers of forgotten sessions
    setLines((prev) => {
      const ids = new Set(list.map((s) => s.id));
      const next: Record<string, TermLine[]> = {};
      for (const [k, v] of Object.entries(prev)) if (ids.has(k)) next[k] = v;
      return next;
    });
  }, [projectId]);

  useEffect(() => {
    setLines({});
    pendingRef.current = {};
    void refresh();
    setQuick(loadQuick(projectId));
  }, [projectId, refresh]);

  // Live socket for the active session.
  useEffect(() => {
    wsRef.current?.close();
    setConnected(false);
    if (!activeId) return;
    let dead = false;
    let ws: WebSocket | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    const sid = activeId;
    const connect = () => {
      if (dead) return;
      ws = createTerminalSocket(
        (frame: TerminalFrame) => {
          if (frame.session_id && frame.session_id !== sid) return;
          if (frame.type === 'attached') setConnected(true);
          else if (frame.type === 'output' && typeof frame.data === 'string') pushData(sid, frame.data);
          else if (frame.type === 'exit') {
            sysLine(sid, tt('term.ended', { code: frame.code ?? '?' }));
            setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, running: false, exit_code: frame.code ?? null } : s)));
          } else if (frame.type === 'error') sysLine(sid, `— ${frame.message ?? tt('term.errorWord')} —`);
        },
        () => { if (!dead) sysLine(sid, tt('term.connError')); },
        () => {
          if (dead) return;
          setConnected(false);
          window.setTimeout(() => { if (!dead && activeRef.current === sid) connect(); }, 1500);
        },
      );
      wsRef.current = ws;
      ws.onopen = () => {
        try {
          ws?.send(JSON.stringify({ action: 'attach', session_id: sid }));
        } catch { /* retry on close */ }
      };
      pingTimer = setInterval(() => {
        try {
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'ping' }));
        } catch { /* ignore */ }
      }, 25000);
    };
    connect();
    return () => {
      dead = true;
      if (pingTimer) clearInterval(pingTimer);
      try {
        ws?.close();
      } catch { /* ignore */ }
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [activeId, pushData, sysLine]);

  const send = useCallback((text: string) => {
    const sid = activeRef.current;
    const ws = wsRef.current;
    if (!sid || !ws || ws.readyState !== WebSocket.OPEN) return false;
    const data = text.endsWith('\n') ? text : text + '\n';
    try {
      ws.send(JSON.stringify({ action: 'input', session_id: sid, data }));
    } catch {
      return false;
    }
    pushLines(sid, 'in', `❯ ${text.replace(/\n+$/, '')}`);
    return true;
  }, [pushLines]);

  const start = useCallback(async () => {
    if (!projectId || starting) return;
    setStarting(true);
    setLastError(null);
    try {
      const meta = await startTerminal(projectId);
      await refresh();
      setActiveId(meta.id);
      sysLine(meta.id, tt('term.session', { shell: meta.shell }));
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : tt('term.errorWord');
      setLastError(msg);
      // surface via a transient line on the active session, if any
      if (activeRef.current) sysLine(activeRef.current, tt('term.startFailed', { msg }));
    } finally {
      setStarting(false);
    }
  }, [projectId, starting, refresh, sysLine]);

  const stop = useCallback(async (id: string) => {
    try {
      await stopTerminal(id);
    } catch { /* already gone */ }
    if (activeRef.current === id) {
      sysLine(id, tt('term.stopped'));
    }
    await refresh();
  }, [refresh, sysLine]);

  const interrupt = useCallback(() => {
    const sid = activeRef.current;
    const ws = wsRef.current;
    if (!sid || !ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ action: 'interrupt', session_id: sid }));
    } catch { /* ignore */ }
  }, []);

  const clear = useCallback((id: string) => {
    pendingRef.current[id] = '';
    setLines((prev) => ({ ...prev, [id]: [] }));
  }, []);

  const addQuick = useCallback((cmd: string) => {
    const c = cmd.trim();
    if (!c || !projectId) return;
    setQuick((prev) => {
      if (prev.includes(c)) return prev;
      const next = [...prev, c].slice(-20);
      try {
        window.localStorage.setItem(quickKey(projectId), JSON.stringify(next));
      } catch { /* ignore */ }
      return next;
    });
  }, [projectId]);

  const removeQuick = useCallback((cmd: string) => {
    if (!projectId) return;
    setQuick((prev) => {
      const next = prev.filter((c) => c !== cmd);
      try {
        window.localStorage.setItem(quickKey(projectId), JSON.stringify(next));
      } catch { /* ignore */ }
      return next;
    });
  }, [projectId]);

  return {
    sessions, activeId, setActiveId, lines, connected, starting, lastError, quick,
    send, start, stop, interrupt, clear, addQuick, removeQuick, refresh,
  };
}
