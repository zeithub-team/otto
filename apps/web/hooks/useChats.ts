'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Chat } from '../types';
import { createChat, deleteChat, fetchChats, renameChat } from '../lib/api';

/**
 * Conversations of a project. Chats are only created explicitly ("New chat" or
 * the first message sent with none selected) — opening a project never
 * creates one. Tracks the active chat so the composer targets a concrete one.
 */
export function useChats(projectId?: number) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    if (!projectId) {
      setChats([]);
      setSelectedChatId(undefined);
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        const rows = await fetchChats(projectId);
        if (cancelled.current) return;
        setChats(rows);
        setSelectedChatId(rows[0]?.id);
      } catch {
        if (!cancelled.current) { setChats([]); setSelectedChatId(undefined); }
      } finally {
        if (!cancelled.current) setLoading(false);
      }
    })();
    return () => { cancelled.current = true; };
  }, [projectId]);

  const add = useCallback(async () => {
    if (!projectId) return;
    const chat = await createChat(projectId, `Чат ${chats.length + 1}`);
    setChats((prev) => [...prev, chat]);
    setSelectedChatId(chat.id);
    return chat;
  }, [projectId, chats.length]);

  const rename = useCallback(async (chatId: number, title: string) => {
    const updated = await renameChat(chatId, title);
    setChats((prev) => prev.map((c) => (c.id === chatId ? updated : c)));
  }, []);

  const remove = useCallback(async (chatId: number) => {
    const remaining = chats.filter((c) => c.id !== chatId);
    setChats(remaining);
    if (selectedChatId === chatId) {
      setSelectedChatId(remaining[0]?.id);
    }
    try {
      await deleteChat(chatId);
    } catch { /* backend unreachable */ }
  }, [chats, selectedChatId]);

  return { chats, selectedChatId, setSelectedChatId, loading, add, rename, remove };
}
