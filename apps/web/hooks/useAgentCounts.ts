'use client';

import { useEffect, useState } from 'react';
import { fetchAgents } from '../lib/api';

/** Agents of the selected project: how many there are and how many are working right now (polled). */
export function useAgentCounts(projectId?: number): { running: number; total: number } {
  const [counts, setCounts] = useState({ running: 0, total: 0 });
  useEffect(() => {
    setCounts({ running: 0, total: 0 });
    if (!projectId) return;
    let alive = true;
    const load = () => {
      void fetchAgents(projectId).then((list) => {
        if (alive) setCounts({ running: list.filter((a) => a.status === 'running').length, total: list.length });
      }).catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 5000);
    window.addEventListener('focus', load);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener('focus', load); };
  }, [projectId]);
  return counts;
}
