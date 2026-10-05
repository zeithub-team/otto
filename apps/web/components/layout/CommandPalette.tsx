'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, MessageSquare, FolderOpen, Puzzle, SquarePen,
  Folder, CornerDownLeft, Clock,
} from 'lucide-react';
import type { Project, ViewType } from '../../types';
import { matchHotkey } from '../../lib/keys';
import { useT } from '../../lib/i18n';

interface CommandPaletteProps {
  projects: Project[];
  selectedProject: Project | null;
  onSelectProject: (project: Project) => void;
  onViewChange: (view: ViewType) => void;
  onNewChat: () => void;
}

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  icon: typeof MessageSquare;
  run: () => void;
}

/**
 * Ctrl/Cmd+K quick search: jump between views, start a new chat,
 * or switch projects without touching the mouse.
 */
export function CommandPalette({
  projects,
  selectedProject,
  onSelectProject,
  onViewChange,
  onNewChat,
}: CommandPaletteProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Global hotkey
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && matchHotkey(e, 'KeyK', 'k', 'л')) {
        e.preventDefault();
        setOpen((prev) => !prev);
        setQuery('');
        setActive(0);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Focus the input when opened
  useEffect(() => {
    if (open) {
      // let the modal paint first
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const commands: PaletteItem[] = [
      { id: 'cmd-chat', label: t('pal.chat'), icon: MessageSquare, run: () => onViewChange('chat') },
      { id: 'cmd-files', label: t('pal.files'), icon: FolderOpen, run: () => onViewChange('project') },
      { id: 'cmd-context', label: t('pal.context'), icon: Puzzle, run: () => onViewChange('context') },
      { id: 'cmd-new', label: t('pal.newChat'), icon: SquarePen, run: () => { onViewChange('chat'); onNewChat(); } },
    ];
    const projectItems: PaletteItem[] = projects.map((p) => ({
      id: `project-${p.id}`,
      label: p.name,
      hint: p.path,
      icon: Folder,
      run: () => { onViewChange('chat'); onSelectProject(p); },
    }));
    const all = [...commands, ...projectItems];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        (item.hint ?? '').toLowerCase().includes(q),
    );
  }, [projects, query, onViewChange, onNewChat, onSelectProject, t]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  const close = () => setOpen(false);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (items.length ? (i + 1) % items.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[active];
      if (item) {
        item.run();
        close();
      }
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center z-50 animate-fade-in pt-[15vh]"
      onMouseDown={close}
    >
      <div
        className="glass rounded-xl w-[480px] max-w-[92vw] overflow-hidden glow"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--border-color)]">
          <Search size={15} className="text-[var(--text-muted)] shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('pal.search')}
            className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
          />
          <kbd className="text-[10px] text-[var(--text-muted)] border border-[var(--border-color)] rounded px-1.5 py-0.5">
            Esc
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-72 overflow-y-auto p-1.5">
          {items.length === 0 && (
            <div className="p-4 text-xs text-[var(--text-muted)] text-center">
              Nothing matches &ldquo;{query}&rdquo;
            </div>
          )}
          {items.map((item, i) => {
            const Icon = item.icon;
            const isActive = i === active;
            return (
              <button
                key={item.id}
                onMouseEnter={() => setActive(i)}
                onClick={() => { item.run(); close(); }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors ${
                  isActive
                    ? 'bg-[var(--accent-glow)] text-[var(--accent)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                <Icon size={14} className="shrink-0" />
                <span className="text-sm truncate">{item.label}</span>
                {item.hint && (
                  <span className="ml-auto text-[10px] text-[var(--text-muted)] truncate max-w-[45%] text-right" title={item.hint}>
                    {item.hint}
                  </span>
                )}
                {isActive && !item.hint && (
                  <CornerDownLeft size={12} className="ml-auto shrink-0 opacity-60" />
                )}
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-[var(--border-color)] flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
          <span className="flex items-center gap-1">
            <Clock size={10} /> {t('pal.projects', { n: projects.length })}
          </span>
          <span className="ml-auto">{t('pal.help')}</span>
        </div>
      </div>
    </div>
  );
}
