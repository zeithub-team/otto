'use client';

import { useEffect, useRef, useState } from 'react';
import type { Project, ViewType } from '../../types';
import {
  MessageSquare, FolderOpen, Puzzle, ChevronDown, Code2, Boxes, Database,
  Folder, Settings2, Trash2, Pencil, Cpu, Maximize2, Minimize2, Bot, Loader2, MonitorSmartphone, Server,
} from 'lucide-react';
import { Logo } from '../brand/Logo';
import { PluginBar } from '../plugins/PluginBar';
import { AccountMenu } from './AccountMenu';
import { BranchMenu } from './BranchMenu';
import type { Account } from '../../types';
import { useServiceSummary } from '../../hooks/useServiceSummary';
import { useAgentCounts } from '../../hooks/useAgentCounts';
import { useT } from '../../lib/i18n';

interface HeaderProps {
  /** The agent is working: the Chat tab pulses and a progress line runs under the header. */
  busy?: boolean;
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
  isConnected: boolean;
  selectedProject: Project | null;
  onNewChat: () => void;
  onDeleteProject?: (projectId: number) => void;
  onEditProject?: (project: Project) => void;
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
  accounts?: Account[];
  activeAccountId?: number;
  onSelectAccount?: (id: number) => void;
  onAddAccount?: () => void;
  onCloneRepo?: () => void;
  onDeleteAccount?: (id: number) => void;
  /** Unfinished tasks of the project: a number on the Chat tab. */
  taskCount?: number;
  /** A task is being carried out right now: the Chat tab glows. */
  tasksRunning?: boolean;
}

export function Header({
  busy = false,
  currentView,
  onViewChange,
  isConnected,
  selectedProject,
  onNewChat,
  onDeleteProject,
  onEditProject,
  focusMode,
  onToggleFocusMode,
  accounts,
  activeAccountId,
  onSelectAccount,
  onAddAccount,
  onCloneRepo,
  onDeleteAccount,
  taskCount = 0,
  tasksRunning = false,
}: HeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  // numbers on Agents (running / all agents of the project) and Services (running / declared services)
  const svc = useServiceSummary()[String(selectedProject?.id ?? '')];
  const agents = useAgentCounts(selectedProject?.id);
  const counter = (id: ViewType): { text: string; live: boolean; title: string } | null => {
    if (id === 'services' && svc?.total) {
      return { text: `${svc.running}/${svc.total}`, live: svc.running > 0, title: t('svc.badge', { running: svc.running, total: svc.total, list: svc.services.map((x) => `${x.name}: ${x.state}`).join(', ') }) };
    }
    if (id === 'agents' && agents.total) {
      return { text: agents.running ? String(agents.running) : String(agents.total), live: agents.running > 0, title: t('agents.badge', { running: agents.running, total: agents.total }) };
    }
    return null;
  };
  const menuRef = useRef<HTMLDivElement>(null);
  const { t } = useT();

  // top bar keeps the everyday views; the rest live in the sidebar (see Sidebar.tsx)
  const navItems: { id: ViewType; label: string; icon: typeof MessageSquare }[] = [
    { id: 'chat', label: t('nav.chat'), icon: MessageSquare },
    { id: 'project', label: t('nav.files'), icon: FolderOpen },
    { id: 'data', label: t('nav.data'), icon: Database },
    { id: 'ssh', label: t('nav.ssh'), icon: Server },
    { id: 'agents', label: t('nav.agents'), icon: Bot },
    { id: 'services', label: t('nav.services'), icon: Boxes },
  ];

  // Close the project menu on outside click / Escape
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const go = (view: ViewType) => {
    setMenuOpen(false);
    onViewChange(view);
  };

  return (
    <header className="relative h-11 border-b border-[var(--border-color)] flex items-center justify-between px-4 bg-[var(--bg-secondary)]">
      {busy && <span className="busy-line" aria-hidden="true" />}
      <div className="flex items-center gap-4">
        <Logo />
        <div className="w-px h-5 bg-[var(--border-color)]" />
        <nav className="flex items-center gap-1">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={`px-2.5 py-1 rounded-lg text-sm transition-all flex items-center gap-1.5 ${
                currentView === item.id
                  ? 'bg-[var(--accent-glow)] text-[var(--accent)] shadow-[0_0_12px_rgba(0,245,160,0.1)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              {busy && item.id === 'chat' ? <Loader2 size={14} className="animate-spin" /> : item.id === 'chat' && taskCount > 0 ? (
                <span className={`relative flex rounded-md ${tasksRunning ? 'task-glow-strong' : 'task-glow'}`}>
                  <item.icon size={14} />
                  <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-bold leading-none text-[var(--on-accent)]">
                    {taskCount > 99 ? '99+' : taskCount}
                  </span>
                </span>
              ) : <item.icon size={14} />}
              {item.label}
              {counter(item.id) && (
                <span title={counter(item.id)!.title} className={`rounded-full px-1.5 text-[10px] font-semibold leading-4 tabular-nums ${counter(item.id)!.live ? 'bg-[var(--accent)] text-[var(--on-accent)] shadow-[0_0_10px_var(--accent)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'}`}>
                  {counter(item.id)!.text}
                </span>
              )}
              {busy && item.id === 'chat' && (
                <span className="relative flex h-1.5 w-1.5" title={t('chat.working')}>
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-70" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Project switcher */}
        {selectedProject && (
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-sm max-w-[220px] transition-colors border ${
                menuOpen
                  ? 'border-[var(--accent)]/40 bg-[var(--accent-glow)] text-[var(--accent)]'
                  : 'border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:border-[var(--accent)]/40'
              }`}
              title={t('sb.projectMenu')}
            >
              <FolderOpen size={14} className="shrink-0" />
              <span className="truncate">{selectedProject.name}</span>
              <ChevronDown size={13} className={`shrink-0 transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
            </button>

            {menuOpen && (
              <div className="absolute left-0 top-full mt-1.5 w-56 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-xl overflow-hidden animate-fade-in z-40">
                <div className="px-3 py-2 border-b border-[var(--border-color)]">
                  <div className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">{t('hd.project')}</div>
                  <div className="text-sm text-[var(--text-primary)] truncate">{selectedProject.name}</div>
                  <div className="text-[10px] text-[var(--text-muted)] font-mono truncate" title={selectedProject.path}>
                    {selectedProject.path}
                  </div>
                </div>

                <button
                  onClick={() => go('project')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                >
                  <FolderOpen size={14} />
                  {t('sb.openFiles')}
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    if (selectedProject) onEditProject?.(selectedProject);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                >
                  <Pencil size={14} />
                  {t('sb.editProject')}
                </button>

                <div className="h-px bg-[var(--border-color)]" />

                <button
                  onClick={() => {
                    setMenuOpen(false);
                    if (selectedProject) onDeleteProject?.(selectedProject.id);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--error)] hover:bg-[var(--error)]/10 transition-colors"
                >
                  <Trash2 size={14} />
                  {t('sb.deleteProject')}
                </button>
              </div>
            )}
          </div>
        )}

        {selectedProject && <BranchMenu projectId={selectedProject.id} />}
      </div>

      <div className="flex items-center gap-1.5">
        {/* plugins the user switched on (Plugins tab) */}
        <PluginBar />
        <span className="mx-0.5 h-5 w-px bg-[var(--border-color)]" />
        <HeaderIcon active={currentView === 'preview'} onClick={() => onViewChange('preview')} title={t('nav.preview')}><MonitorSmartphone size={15} /></HeaderIcon>
        <HeaderIcon active={focusMode} onClick={() => onToggleFocusMode?.()} title={focusMode ? t('hd.exitFocus') : t('hd.focus')}><Code2 size={15} /></HeaderIcon>
        {accounts && (
          <AccountMenu
            compact
            accounts={accounts}
            activeId={activeAccountId ?? 0}
            onSelect={(id) => onSelectAccount?.(id)}
            onAddAccount={() => onAddAccount?.()}
            onCloneRepo={() => onCloneRepo?.()}
            onDeleteAccount={(id) => onDeleteAccount?.(id)}
          />
        )}
      </div>
    </header>
  );
}

function HeaderIcon({ active, onClick, title, children }: { active?: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} aria-label={title}
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${active ? 'bg-[var(--accent-glow)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
      {children}
    </button>
  );
}
