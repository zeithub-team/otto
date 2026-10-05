'use client';

import { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface MenuItem {
  label: string;
  icon: LucideIcon;
  run: () => void;
  hint?: string;
  danger?: boolean;
}

/** Right-click menu of the file explorer, kept inside the window. */
export function ExplorerMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (box) setPos({ left: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)) });
  }, [x, y, items.length]);

  useEffect(() => {
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const blur = () => onClose();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    window.addEventListener('blur', blur);
    window.addEventListener('resize', blur);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', blur);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-[190px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-1 shadow-2xl"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.label}
            role="menuitem"
            onClick={item.run}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs ${item.danger ? 'text-[var(--error)] hover:bg-[var(--error)]/10' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
          >
            <Icon size={13} className="shrink-0" />
            <span className="flex-1">{item.label}</span>
            {item.hint && <span className="text-[10px] text-[var(--text-muted)]">{item.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
