'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Account } from '../types';
import { addAccount, deleteAccount, fetchAccounts } from '../lib/api';

/** Built-in bucket for projects not tied to any Git account. */
export const LOCAL_ACCOUNT: Account = {
  id: 0, provider: 'local', username: 'Локально', display_name: 'Локально', avatar_url: '', created_at: 0,
};

const ACTIVE_KEY = 'otto-active-account';

export function useAccounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeId, setActiveId] = useState<number>(0);

  const reload = useCallback(async () => {
    try {
      setAccounts(await fetchAccounts());
    } catch { /* backend unreachable */ }
  }, []);

  useEffect(() => {
    void reload();
    try {
      const saved = Number(window.localStorage.getItem(ACTIVE_KEY));
      if (Number.isFinite(saved) && saved > 0) setActiveId(saved);
    } catch { /* ignore */ }
  }, [reload]);

  const setActive = useCallback((id: number) => {
    setActiveId(id);
    try { window.localStorage.setItem(ACTIVE_KEY, String(id)); } catch { /* ignore */ }
  }, []);

  const add = useCallback(async (token: string, provider = 'github') => {
    const account = await addAccount(token, provider);
    setAccounts((prev) => [...prev.filter((a) => a.id !== account.id), account]);
    setActive(account.id);
    return account;
  }, [setActive]);

  const remove = useCallback(async (id: number) => {
    await deleteAccount(id);
    setAccounts((prev) => prev.filter((a) => a.id !== id));
    setActiveId((cur) => (cur === id ? 0 : cur));
  }, []);

  const all = [LOCAL_ACCOUNT, ...accounts];
  const active = all.find((a) => a.id === activeId) ?? LOCAL_ACCOUNT;

  return { accounts: all, activeId, active, setActive, add, remove, reload };
}
