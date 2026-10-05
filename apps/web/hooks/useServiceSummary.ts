'use client';

import { useEffect, useState } from 'react';
import { fetchServiceSummary, type ProjectServices } from '../lib/api';

/**
 * Running / total services per project. Refreshed every 15 s, when the window gets focus and right
 * after a start / stop anywhere in the app (`otto:services-changed`).
 */
export function useServiceSummary(): Record<string, ProjectServices> {
  const [summary, setSummary] = useState<Record<string, ProjectServices>>({});
  useEffect(() => {
    let alive = true;
    const load = (fresh = false) => { void fetchServiceSummary(fresh).then((r) => { if (alive) setSummary(r.projects); }).catch(() => undefined); };
    const onChange = () => load(true);
    const onFocus = () => load();
    load();
    const timer = window.setInterval(() => load(), 15_000);
    window.addEventListener('otto:services-changed', onChange);
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('otto:services-changed', onChange);
      window.removeEventListener('focus', onFocus);
    };
  }, []);
  return summary;
}
