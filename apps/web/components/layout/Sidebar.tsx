'use client';

import { useEffect, useRef, useState } from 'react';
import type { Account, Project, ViewType } from '../../types';
import {
  Plus, Folder, FolderOpen, X, ChevronRight, Link2, FilePlus2,
  Clock, Star, MoreHorizontal, MessageSquare, Home, Trash2, Pencil,
  Settings as SettingsIcon, BookOpen, Loader2, Search, ExternalLink, PanelLeftClose, PanelLeftOpen,
  Boxes, Puzzle, Cpu, Database, Server, Bot, Cable,
} from 'lucide-react';
import { FolderBrowser } from './FolderBrowser';
import type { Chat } from '../../types';
import { useConfirm } from '../ui/Confirm';
import { useT } from '../../lib/i18n';
import { matchHotkey } from '../../lib/keys';
import { fetchAccountOwners, fetchTemplates,type NewProjectOptions, type StarterTemplates } from '../../lib/api';

interface SidebarProps {
  projects: Project[];
  selectedProject: Project | null;
  onSelectProject: (project: Project) => void;
  onCreateProject: (name: string, folder?: string, options?: NewProjectOptions) => Promise<Project | void>;
  /** Organizations (Git accounts) a new project can be filed under. */
  accounts?: Account[];
  activeAccountId?: number;
  onDeleteProject: (projectId: number) => void;
  onViewChange: (view: ViewType) => void;
  onEditProject?: (project: Project) => void;
  // Chats of the selected project (hierarchy under it)
  chats?: Chat[];
  selectedChatId?: number;
  /** The selected chat has a running agent: its row shows a spinner. */
  busy?: boolean;
  onSelectChat?: (chatId: number) => void;
  onAddChat?: () => void;
  onRenameChat?: (chatId: number, title: string) => void;
  onDeleteChat?: (chatId: number) => void;
  /** The active view, to highlight the matching nav button. */
  currentView?: ViewType;
}

const STARRED_KEY = 'otto-starred-projects';
const RAIL_KEY = 'otto-sidebar-rail';

/** A stable colour per project name for its avatar tile. */
function avatarColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 48% 38%)`;
}

/** Compact "5m ago" in the UI language; `epoch` is in seconds (or milliseconds). */
function ago(epoch: number, locale: string): string {
  if (!epoch) return '';
  const ms = epoch > 1e12 ? epoch : epoch * 1000;
  const diff = Math.round((ms - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale === 'ge' ? 'ka' : locale === 'sp' ? 'es' : locale, { numeric: 'auto', style: 'narrow' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(0, 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return rtf.format(Math.round(diff / (86400 * 30)), 'month');
}

function loadStarred(): number[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STARRED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function Sidebar({
  projects,
  selectedProject,
  onSelectProject,
  onCreateProject,
  accounts = [],
  activeAccountId = 0,
  onDeleteProject,
  onViewChange,
  onEditProject,
  chats = [],
  selectedChatId,
  busy = false,
  onSelectChat,
  onAddChat,
  onRenameChat,
  onDeleteChat,
  currentView,
}: SidebarProps) {
  const [isCreating, setIsCreating] = useState(false);
  // Projects whose chat list is folded; a click on the open project toggles it
  const [collapsed, setCollapsed] = useState<number[]>([]);
  const [newProjectName, setNewProjectName] = useState('');
  const [linkedFolder, setLinkedFolder] = useState<string | null>(null);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [section, setSection] = useState<'recent' | 'starred'>('recent');
  const [starred, setStarred] = useState<number[]>([]);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [renamingChat, setRenamingChat] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  const { t, locale } = useT();
  const [filter, setFilter] = useState('');
  // starter files for a new project
  const [templates, setTemplates] = useState<StarterTemplates | null>(null);
  const [gitignore, setGitignore] = useState('none');
  const [license, setLicense] = useState('none');
  const [holder, setHolder] = useState('');
  const [gitInit, setGitInit] = useState(false);
  // organization the new project is filed under (0 = local)
  const [ownerId, setOwnerId] = useState<number | null>(null);
  const owner = ownerId ?? activeAccountId;
  // names offered as the license holder: the GitHub user + organizations of the chosen account
  const [holders, setHolders] = useState<string[]>([]);
  useEffect(() => {
    if (!isCreating || owner <= 0) { setHolders([]); return; }
    let live = true;
    void fetchAccountOwners(owner).then((list) => { if (live) setHolders(list); });
    return () => { live = false; };
  }, [isCreating, owner]);
  // compact icon rail (remembered)
  const [rail, setRail] = useState(false);
  useEffect(() => {
    try { setRail(window.localStorage.getItem(RAIL_KEY) === '1'); } catch { /* ignore */ }
  }, []);
  const toggleRail = () =>
    setRail((prev) => {
      try { window.localStorage.setItem(RAIL_KEY, prev ? '0' : '1'); } catch { /* ignore */ }
      return !prev;
    });

  // Restore starred projects
  useEffect(() => {
    setStarred(loadStarred());
  }, []);

  // Close the project row menu on outside click / Escape
  useEffect(() => {
    if (menuFor === null) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuFor(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuFor(null);
      // Command palette hotkey — dismiss the row menu behind it
      if ((e.ctrlKey || e.metaKey) && matchHotkey(e, 'KeyK', 'k', 'л')) setMenuFor(null);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuFor]);

  const toggleStar = (projectId: number) => {
    setStarred((prev) => {
      const next = prev.includes(projectId)
        ? prev.filter((id) => id !== projectId)
        : [...prev, projectId];
      try {
        window.localStorage.setItem(STARRED_KEY, JSON.stringify(next));
      } catch { /* ignore */ }
      return next;
    });
  };

  // Recent = all projects (backend order); Starred = starred only
  const needle = filter.trim().toLowerCase();
  const visibleProjects = (section === 'starred' ? projects.filter((p) => starred.includes(p.id)) : projects).filter(
    (p) => !needle || p.name.toLowerCase().includes(needle),
  );

  const openCreate = () => {
    try {
      setHolder(window.localStorage.getItem('otto-license-holder') ?? '');
      setGitignore(window.localStorage.getItem('otto-gitignore') ?? 'none');
      setLicense(window.localStorage.getItem('otto-license') ?? 'none');
      setGitInit(window.localStorage.getItem('otto-git-init') === '1');
    } catch { /* ignore */ }
    if (!templates) void fetchTemplates().then(setTemplates).catch(() => undefined);
    setNewProjectName('');
    setLinkedFolder(null);
    setIsBrowsing(false);
    setCreateError(null);
    setIsCreating(true);
  };

  const closeCreate = () => {
    setIsCreating(false);
    setIsBrowsing(false);
    setCreateError(null);
  };

  // Folder browser for binding an existing folder
  const handleCreate = async () => {
    const name = newProjectName.trim();
    if ((!name && !linkedFolder) || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      try {
        window.localStorage.setItem('otto-license-holder', holder);
        window.localStorage.setItem('otto-gitignore', gitignore);
        window.localStorage.setItem('otto-license', license);
        window.localStorage.setItem('otto-git-init', gitInit ? '1' : '0');
      } catch { /* ignore */ }
      await onCreateProject(name || linkedFolder!.split('/').pop()!, linkedFolder ?? undefined, {
        gitignore,
        license,
        license_holder: holder.trim(),
        git_init: gitInit,
        account_id: owner,
      });
      setOwnerId(null);
      setNewProjectName('');
      setLinkedFolder(null);
      setIsCreating(false);
      setIsBrowsing(false);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : t('sb.createFailed'));
    } finally {
      setCreating(false);
    }
  };

  // the everyday views (chat, files, data, ssh) live in the top bar; these stay in the sidebar
  const NAV: Array<{ id: ViewType; label: string; icon: typeof Home }> = [
    { id: 'models', label: t('nav.models'), icon: Cpu },
    { id: 'plugins', label: t('nav.plugins'), icon: Puzzle },
    { id: 'connectors', label: t('nav.connectors'), icon: Cable },
  ];

  return (
    <aside className={`${rail ? 'w-[56px]' : 'w-[236px]'} shrink-0 transition-[width] duration-200 border-r border-[var(--border-color)] bg-[var(--bg-secondary)] flex flex-col overflow-hidden relative`}>
      {rail ? (
        <>
      {/* Compact rail: icons only */}
      <div className="flex flex-1 flex-col items-center gap-1.5 overflow-y-auto px-1.5 py-2.5">
        <button
          onClick={openCreate}
          title={t('sidebar.newProject')}
          aria-label={t('sidebar.newProject')}
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-hover)] transition-colors glow"
        >
          <Plus size={17} strokeWidth={2.5} />
        </button>
        <button
          onClick={() => onViewChange('home')}
          title={t('sidebar.home')}
          aria-label={t('sidebar.home')}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
        >
          <Home size={16} />
        </button>
        <span className="my-1 h-px w-6 bg-[var(--border-color)]" />
        {NAV.map((item) => (
          <button key={item.id} onClick={() => onViewChange(item.id)} title={item.label} aria-label={item.label}
            className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${currentView === item.id ? 'bg-[var(--accent-glow)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
            {busy && item.id === 'chat' ? <Loader2 size={15} className="animate-spin" /> : <item.icon size={16} />}
          </button>
        ))}
        <span className="my-1 h-px w-6 bg-[var(--border-color)]" />
        {projects.map((project) => {
          const isSelected = selectedProject?.id === project.id;
          return (
            <button
              key={project.id}
              onClick={() => { onSelectProject(project); onViewChange('chat'); }}
              title={project.name}
              aria-label={project.name}
              className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[13px] font-bold text-white transition-transform hover:scale-105 ${isSelected ? 'ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--bg-secondary)]' : 'opacity-80 hover:opacity-100'}`}
              style={{ background: avatarColor(project.name) }}
            >
              {project.name.trim().charAt(0).toUpperCase() || '?'}
              {isSelected && busy && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--accent)] ring-2 ring-[var(--bg-secondary)]" />}
            </button>
          );
        })}
      </div>
      <div className="flex flex-col items-center gap-1 border-t border-[var(--border-color)] p-1.5">
        <button
          onClick={() => onViewChange('docs')}
          title={t('sidebar.docs')}
          aria-label={t('sidebar.docs')}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
        >
          <BookOpen size={16} />
        </button>
        <button
          onClick={() => onViewChange('settings')}
          title={t('sidebar.settings')}
          aria-label={t('sidebar.settings')}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
        >
          <SettingsIcon size={16} />
        </button>
        <button
          onClick={toggleRail}
          title={t('sb.expand')}
          aria-label={t('sb.expand')}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
        >
          <PanelLeftOpen size={16} />
        </button>
      </div>
        </>
      ) : (
        <>
      {/* Header: create + views */}
      <div className="p-2.5 pb-2 space-y-2">
        {/* Models, plugins, connectors (chat, files, data, SSH, agents and services are in the top bar) */}
        <nav className="grid grid-cols-3 gap-0.5">
          {NAV.map((item) => (
            <button key={item.id} onClick={() => onViewChange(item.id)} title={item.label}
              className={`flex flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[10px] transition-colors ${currentView === item.id ? 'bg-[var(--accent-glow)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
              <item.icon size={15} />
              <span className="max-w-full truncate">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-1.5">
          <button
            onClick={openCreate}
            className="flex-1 h-8 rounded-lg bg-[var(--accent)] text-[var(--on-accent)] text-[13px] font-semibold hover:bg-[var(--accent-hover)] transition-all flex items-center justify-center gap-1.5 glow"
          >
            <Plus size={15} strokeWidth={2.5} /> {t('sidebar.newProject')}
          </button>
          <button
            onClick={() => onViewChange('home')}
            title={t('sidebar.home')}
            aria-label={t('sidebar.home')}
            className="h-8 w-8 shrink-0 rounded-lg border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors flex items-center justify-center"
          >
            <Home size={14} />
          </button>
        </div>

        {/* All / Starred */}
        <div className="grid grid-cols-2 gap-0.5 rounded-lg bg-[var(--bg-tertiary)] p-0.5 text-xs">
          {(['recent', 'starred'] as const).map((id) => (
            <button
              key={id}
              onClick={() => setSection(id)}
              className={`flex items-center justify-center gap-1.5 rounded-md py-1 transition-colors ${
                section === id
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {id === 'recent' ? <Clock size={12} /> : <Star size={12} />}
              {id === 'recent' ? t('sidebar.recent') : t('sidebar.starred')}
              <span className="tabular-nums opacity-60">{id === 'recent' ? projects.length : starred.filter((sid) => projects.some((p) => p.id === sid)).length}</span>
            </button>
          ))}
        </div>

        {projects.length > 4 && (
          <label className="relative block">
            <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('sb.filter')}
              className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)]/50 py-1.5 pl-7 pr-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/60"
            />
          </label>
        )}
      </div>

      {/* Project list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 border-t border-[var(--border-color)]">
        <div className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest px-2 pt-3 pb-1.5">
          {section === 'starred' ? t('sidebar.starred') : t('sidebar.projects')}
        </div>

        {visibleProjects.length === 0 && (
          <div className="text-xs text-[var(--text-muted)] text-center py-6 px-2 whitespace-pre-line">
            {filter.trim() ? t('sb.noMatch') : section === 'starred' ? t('sidebar.noStarred') : t('sidebar.noProjects')}
          </div>
        )}

        {visibleProjects.map((project) => {
          const isSelected = selectedProject?.id === project.id;
          const isStarred = starred.includes(project.id);
          const menuOpen = menuFor === project.id;
          const folder = project.path.split(/[\\/]/).filter(Boolean).pop() ?? '';
          return (
            <div key={project.id} className="mb-0.5">
              <div
                className={`group relative flex items-center gap-2 rounded-lg pl-2 pr-1.5 py-1.5 cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-[var(--accent-glow)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                }`}
                onClick={() => {
                  if (menuFor !== null) setMenuFor(null);
                  if (isSelected) setCollapsed((c) => (c.includes(project.id) ? c.filter((id) => id !== project.id) : [...c, project.id]));
                  else { setCollapsed((c) => c.filter((id) => id !== project.id)); onSelectProject(project); }
                }}
              >
                {isSelected && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-[var(--accent)]" aria-hidden="true" />}
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-white"
                  style={{ background: avatarColor(project.name) }}
                  aria-hidden="true"
                >
                  {project.name.trim().charAt(0).toUpperCase() || '?'}
                </span>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="flex items-center gap-1">
                    <span className={`truncate text-[13px] ${isSelected ? 'font-semibold' : ''}`}>{project.name}</span>
                    {isStarred && <Star size={10} className="shrink-0 text-[var(--accent)]" fill="currentColor" />}
                  </span>
                  {folder && folder !== project.name && (
                    <span className="block truncate text-[10px] text-[var(--text-muted)]" title={project.path}>{folder}</span>
                  )}
                </span>

                {/* Row actions */}
                <span className="flex shrink-0 items-center">
                  {isSelected && (
                    <ChevronRight
                      size={13}
                      className={`text-[var(--text-muted)] transition-transform ${collapsed.includes(project.id) ? '' : 'rotate-90'} group-hover:hidden`}
                    />
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleStar(project.id); }}
                    className={`p-1 rounded ${isStarred ? 'hidden group-hover:block text-[var(--accent)]' : 'hidden group-hover:block text-[var(--text-muted)] hover:text-[var(--accent)]'}`}
                    title={isStarred ? t('sb.unstar') : t('sb.star')}
                  >
                    <Star size={13} fill={isStarred ? 'currentColor' : 'none'} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setMenuFor(menuOpen ? null : project.id); }}
                    className={`p-1 rounded ${menuOpen ? 'block text-[var(--text-primary)]' : 'hidden group-hover:block text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
                    title={t('sb.projectMenu')}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </span>

                {/* Row dropdown */}
                {menuOpen && (
                  <div
                    ref={menuRef}
                    className="absolute right-1 top-full mt-0.5 z-30 w-44 glass rounded-lg border border-[var(--border-color)] py-1 shadow-lg"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => { setMenuFor(null); onSelectProject(project); onViewChange('chat'); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                    >
                      <MessageSquare size={13} /> {t('sb.openChat')}
                    </button>
                    <button
                      onClick={() => { setMenuFor(null); onSelectProject(project); onViewChange('project'); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                    >
                      <FolderOpen size={13} /> {t('sb.openFiles')}
                    </button>
                    <button
                      onClick={() => { setMenuFor(null); toggleStar(project.id); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                    >
                      <Star size={13} /> {isStarred ? t('sb.unstar2') : t('sb.star2')}
                    </button>
                    <button
                      onClick={() => { setMenuFor(null); onEditProject?.(project); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                    >
                      <Pencil size={13} /> {t('sb.editProject')}
                    </button>
                    <div className="my-1 border-t border-[var(--border-color)]" />
                    <button
                      onClick={async () => { setMenuFor(null); if (await confirm({ title: t('sb.deleteProject'), message: t('sb.delProjectMsg', { name: project.name }), danger: true, confirmText: t('common.delete') })) onDeleteProject(project.id); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--error)] hover:bg-[var(--error)]/10 transition-colors"
                    >
                      <Trash2 size={13} /> {t('sb.deleteProject')}
                    </button>
                  </div>
                )}
              </div>

              {/* Chats under the selected project */}
              {isSelected && !collapsed.includes(project.id) && (
                <div className="mt-0.5 mb-1.5 space-y-px">
                  {chats.map((chat) => {
                    const activeChat = chat.id === selectedChatId;
                    const running = busy && activeChat;
                    return (
                      <div
                        key={chat.id}
                        className={`group/chat flex items-center justify-between gap-1 rounded-md pl-9 pr-2 py-1 cursor-pointer text-xs transition-colors ${
                          activeChat
                            ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                            : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]'
                        }`}
                        onClick={() => { if (renamingChat !== chat.id) { onSelectChat?.(chat.id); onViewChange('chat'); } }}
                        title={chat.title}
                      >
                        {renamingChat === chat.id ? (
                          <input
                            autoFocus
                            value={renameValue}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { if (renameValue.trim()) onRenameChat?.(chat.id, renameValue.trim()); setRenamingChat(null); }
                              if (e.key === 'Escape') setRenamingChat(null);
                            }}
                            onBlur={() => { if (renameValue.trim() && renameValue.trim() !== chat.title) onRenameChat?.(chat.id, renameValue.trim()); setRenamingChat(null); }}
                            className="flex-1 min-w-0 rounded border border-[var(--accent)]/50 bg-[var(--bg-primary)] px-1 py-0.5 text-xs outline-none"
                          />
                        ) : (
                          <span className="flex min-w-0 items-center gap-1.5">
                            {running ? (
                              <Loader2 size={12} className="shrink-0 animate-spin text-[var(--accent)]" />
                            ) : (
                              <MessageSquare size={12} className={`shrink-0 ${activeChat ? 'text-[var(--accent)]' : ''}`} />
                            )}
                            <span className={`truncate ${activeChat ? 'font-medium' : ''}`}>{chat.title}</span>
                          </span>
                        )}
                        <span className="flex shrink-0 items-center gap-1">
                          <span className="text-[10px] tabular-nums text-[var(--text-muted)] group-hover/chat:hidden">
                            {running ? '' : ago(chat.updated_at || chat.created_at, locale)}
                          </span>
                          <span className="hidden items-center gap-0.5 group-hover/chat:flex">
                            <button
                              onClick={(e) => { e.stopPropagation(); setRenameValue(chat.title); setRenamingChat(chat.id); }}
                              className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                              title={t('common.rename')}
                            ><Pencil size={11} /></button>
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                if (await confirm({ title: t('sb.delChatTitle'), message: t('sb.delChatMsg', { name: chat.title }), danger: true, confirmText: t('common.delete') })) onDeleteChat?.(chat.id);
                              }}
                              className="text-[var(--text-muted)] hover:text-[var(--error)]"
                              title={t('sb.delChatTitle')}
                            ><Trash2 size={11} /></button>
                          </span>
                        </span>
                      </div>
                    );
                  })}
                  <button
                    onClick={() => onAddChat?.()}
                    className="mt-0.5 flex w-full items-center gap-1.5 rounded-md border border-dashed border-[var(--border-color)] pl-9 pr-2 py-1 text-xs text-[var(--text-muted)] hover:border-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors"
                  >
                    <Plus size={12} /> {t('sidebar.newChat')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer: collapse toggle (bottom-left) + documentation / settings as icons */}
      <div className="border-t border-[var(--border-color)] p-2">
        <div className="flex items-center gap-1">
          <button
            onClick={toggleRail}
            title={t('sb.collapse')}
            aria-label={t('sb.collapse')}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          >
            <PanelLeftClose size={16} />
          </button>
          <span className="flex-1 text-center text-[10px] text-[var(--text-muted)]">{t('sidebar.search')}</span>
          <button
            onClick={() => onViewChange('docs')}
            title={t('sidebar.docs')}
            aria-label={t('sidebar.docs')}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          >
            <BookOpen size={16} />
          </button>
          <button
            onClick={() => onViewChange('settings')}
            title={t('sidebar.settings')}
            aria-label={t('sidebar.settings')}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          >
            <SettingsIcon size={16} />
          </button>
        </div>
      </div>

        </>
      )}

      {/* Create modal */}
      {isCreating && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in">
          <div className="glass rounded-xl p-5 w-80 animate-fade-in glow">
            <h3 className="text-sm font-semibold mb-3 text-[var(--text-primary)]">{t('sb.createTitle')}</h3>

            {!isBrowsing ? (
              <>
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  placeholder={t('sb.projectName')}
                  className="w-full px-3 py-2.5 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
                  autoFocus
                />

                {/* Folder binding */}
                <div className="mt-3">
                  {linkedFolder ? (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--accent-glow)] border border-[var(--accent)]/30 text-xs">
                      <Link2 size={13} className="text-[var(--accent)] shrink-0" />
                      <span className="truncate text-[var(--text-primary)]" title={linkedFolder}>
                        {linkedFolder}
                      </span>
                      <button
                        onClick={() => setLinkedFolder(null)}
                        className="ml-auto text-[var(--text-muted)] hover:text-[var(--error)] shrink-0"
                        title={t('sb.unlink')}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setIsBrowsing(true)}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-[var(--border-color)] text-xs text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
                    >
                      <Folder size={13} />
                      {t('sb.bind')}
                      <ChevronRight size={13} className="ml-auto" />
                    </button>
                  )}
                  <div className="mt-1.5 text-[10px] text-[var(--text-muted)]">
                    {linkedFolder
                      ? t('sb.usesFolder')
                      : t('sb.newFolder')}
                  </div>
                </div>

                <datalist id="otto-holders">
                  {holders.map((h) => <option key={h} value={h} />)}
                </datalist>
                {/* Organization */}
                <label className="mt-3 block text-xs text-[var(--text-secondary)]">
                  {t('sb.org')}
                  <select
                    value={owner}
                    onChange={(e) => setOwnerId(Number(e.target.value))}
                    className="mt-1 w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                  >
                    <option value={0}>{t('sb.orgLocal')}</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.display_name || a.username}</option>)}
                  </select>
                </label>

                {/* Starter files */}
                <div className="mt-3 space-y-2 border-t border-[var(--border-color)] pt-3">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{t('sb.starter')}</div>
                  <label className="block text-xs text-[var(--text-secondary)]">
                    {t('sb.gitignore')}
                    <select
                      value={gitignore}
                      onChange={(e) => setGitignore(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                    >
                      <option value="none">{t('sb.none')}</option>
                      {templates?.gitignore.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
                    </select>
                  </label>
                  <label className="block text-xs text-[var(--text-secondary)]">
                    {t('sb.license')}
                    <select
                      value={license}
                      onChange={(e) => setLicense(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                    >
                      <option value="none">{t('sb.none')}</option>
                      {templates?.licenses.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                    </select>
                  </label>
                  {templates?.licenses.find((l) => l.id === license)?.holder && (
                    <input
                      list="otto-holders"
                      value={holder}
                      onChange={(e) => setHolder(e.target.value)}
                      placeholder={t('sb.holder')}
                      aria-label={t('sb.holder')}
                      className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
                    />
                  )}
                  <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                    <input type="checkbox" checked={gitInit} onChange={(e) => setGitInit(e.target.checked)} />
                    {t('sb.gitInit')}
                  </label>
                </div>

                {createError && (
                  <div className="mt-2 text-xs text-[var(--error)]">{createError}</div>
                )}

                <div className="flex gap-2 mt-4">
                  <button
                    onClick={handleCreate}
                    disabled={creating || (!newProjectName.trim() && !linkedFolder)}
                    className="flex-1 px-3 py-2 rounded-lg bg-[var(--accent)] text-[var(--on-accent)] text-sm font-semibold hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
                  >
                    {creating ? (
                      <span className="w-3.5 h-3.5 border-2 border-[var(--on-accent)] border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <FilePlus2 size={14} />
                    )}
                    {t('common.create')}
                  </button>
                  <button
                    onClick={closeCreate}
                    className="flex-1 px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-secondary)] text-sm hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </>
            ) : (
              /* Folder browser: any folder on disk */
              <FolderBrowser
                onSelect={(path) => {
                  setLinkedFolder(path);
                  setIsBrowsing(false);
                }}
                onCancel={() => setIsBrowsing(false)}
              />
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
