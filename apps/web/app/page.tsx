'use client';

import { setTheme, type ThemeId } from '../lib/theme';
import { useState, useCallback, useEffect, useRef } from 'react';
import type { ViewType, ContextItem, Project } from '../types';
import { useProjects } from '../hooks/useProjects';
import { useChat } from '../hooks/useChat';
import { useChats } from '../hooks/useChats';
import { Header } from '../components/layout/Header';
import { Sidebar } from '../components/layout/Sidebar';
import { DataView } from '../components/views/DataView';
import { Composer } from '../components/layout/Composer';
import { CommandPalette } from '../components/layout/CommandPalette';
import { FirstRunSetup } from '../components/layout/FirstRunSetup';
import { EditProjectModal } from '../components/layout/EditProjectModal';
import { ChatView } from '../components/views/ChatView';
import { TerminalView } from '../components/views/TerminalView';
import { TerminalBar } from '../components/views/TerminalPanel';
import { useTerminal } from '../hooks/useTerminal';
import { matchHotkey } from '../lib/keys';
import { ProjectView } from '../components/views/ProjectView';
import { ContextView } from '../components/views/ContextView';
import { ServicesView } from '../components/views/ServicesView';
import { ModelsView } from '../components/views/ModelsView';
import { TaskPanel } from '../components/layout/TaskPanel';
import { useTasks } from '../hooks/useTasks';
import { SshView } from '../components/views/SshView';
import { TabbyView } from '../components/views/TabbyView';
import { PluginsView } from '../components/views/PluginsView';
import { ConnectorsView } from '../components/views/ConnectorsView';
import { fetchAppSettings, saveAppSettings } from '../lib/api';
import { PluginRuntime } from '../components/plugins/PluginBar';

import { TaskRunBanner } from '../components/layout/TaskRunBanner';
import { SettingsView } from '../components/views/SettingsView';
import { HomeView } from '../components/views/HomeView';
import { HelpView } from '../components/views/HelpView';
import { DocsWindow } from '../components/views/DocsWindow';
import { PreviewView } from '../components/views/PreviewView';
import { DOCS_CHANNEL } from '../lib/docsWindow';
import { AgentsView } from '../components/views/AgentsView';
import { ConfirmProvider } from '../components/ui/Confirm';
import { I18nProvider, useT, type Locale } from '../lib/i18n';
import { applyTheme, getTheme } from '../lib/theme';
import { useAccounts } from '../hooks/useAccounts';
import { AddAccountModal } from '../components/layout/AddAccountModal';
import { CloneRepoModal } from '../components/layout/CloneRepoModal';
import { PermissionPrompts } from '../components/views/PermissionPrompts';

function AppShell() {
  const { t } = useT();
  const [currentView, setCurrentView] = useState<ViewType>('chat');
  // a file to show in the Preview tab (sent by the editor or the chat)
  const [previewFile, setPreviewFile] = useState<{ path: string; n: number } | null>(null);
  // an address the agent asked to show (a dev server it started)
  const [previewUrl, setPreviewUrl] = useState<{ url: string; n: number } | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const file = (e as CustomEvent<{ path?: string }>).detail?.path;
      if (!file) return;
      setPreviewFile((prev) => ({ path: file, n: (prev?.n ?? 0) + 1 }));
      setCurrentView('preview');
    };
    window.addEventListener('otto:preview-file', handler);
    return () => window.removeEventListener('otto:preview-file', handler);
  }, []);

  // actions from the agent (otto_open / otto_preview / otto_appearance tools)
  const { setLocale } = useT();
  useEffect(() => {
    const handler = (e: Event) => {
      const a = (e as CustomEvent<Record<string, unknown>>).detail ?? {};
      const view = typeof a.view === 'string' ? a.view : '';
      switch (a.action) {
        case 'navigate':
          if (view === 'settings' && typeof a.page === 'string') { try { window.sessionStorage.setItem('otto-settings-page', a.page); } catch { /* ignore */ } }
          if (view) setCurrentView(view as ViewType);
          break;
        case 'preview-file':
          if (typeof a.path === 'string') window.dispatchEvent(new CustomEvent('otto:preview-file', { detail: { path: a.path } }));
          break;
        case 'preview-url':
          if (typeof a.url === 'string') {
            setPreviewUrl((prev) => ({ url: a.url as string, n: (prev?.n ?? 0) + 1 }));
            setCurrentView('preview');
          }
          break;
        case 'preview-refresh':
          window.dispatchEvent(new Event('otto:preview-refresh'));
          break;
        case 'theme':
          if (typeof a.id === 'string') setTheme(a.id as ThemeId);
          break;
        case 'locale':
          if (typeof a.id === 'string') setLocale(a.id as Locale);
          break;
        case 'tasks-changed':
          window.dispatchEvent(new Event('otto:tasks-changed'));
          break;
        case 'settings-changed':
          window.dispatchEvent(new Event('otto:settings-changed'));
          break;
      }
    };
    window.addEventListener('otto:ui', handler);
    return () => window.removeEventListener('otto:ui', handler);
  }, [setLocale]);

  // the model picker sends the user to a Settings page (e.g. to add a provider key)
  useEffect(() => {
    const handler = (e: Event) => {
      const page = (e as CustomEvent<{ page?: string }>).detail?.page;
      try { if (page) window.sessionStorage.setItem('otto-settings-page', page); } catch { /* ignore */ }
      setCurrentView('settings');
    };
    window.addEventListener('otto:open-settings', handler);
    return () => window.removeEventListener('otto:open-settings', handler);
  }, []);

  // the separate documentation window asks this window to open a section
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(DOCS_CHANNEL);
    channel.onmessage = (e: MessageEvent<{ view?: ViewType }>) => {
      if (e.data?.view) {
        setCurrentView(e.data.view);
        window.focus();
      }
    };
    return () => channel.close();
  }, []);
  const [contextItems, setContextItems] = useState<ContextItem[]>([]);
  const [tasksCollapsed, setTasksCollapsed] = useState(true);
  const [focusMode, setFocusMode] = useState(false);

  // Apply the saved color scheme on load.
  useEffect(() => { applyTheme(getTheme()); }, []);

  // Focus / code mode: hide side panels, jump to the editor. Esc exits.
  const toggleFocusMode = useCallback(() => {
    setFocusMode((prev) => {
      const next = !prev;
      if (next) setCurrentView('project');
      return next;
    });
  }, []);

  useEffect(() => {
    if (!focusMode) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFocusMode(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusMode]);

  // Layout- and driver-independent global hotkeys (see lib/keys):
  // Ctrl+Shift+O = go to symbol, Ctrl+Alt+F/R = global find/replace.
  // Forwarded to the Files view, which auto-switches open.
  const [navRequest, setNavRequest] = useState<{ action: 'search' | 'symbol' | 'file'; mode?: 'find' | 'replace'; n: number } | null>(null);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;

      // Select all / undo / redo in plain fields and text: the app has no menu that would run them
      // (copy, cut and paste are done by the main process). The code editor has its own keymap.
      const target = e.target as HTMLElement | null;
      if (!e.altKey && !target?.closest?.('.cm-editor')) {
        const field = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
        const editable = Boolean(field) || Boolean(target?.isContentEditable);
        if (!e.shiftKey && matchHotkey(e, 'KeyA', 'a', 'ф')) {
          if (field) { e.preventDefault(); field.select(); return; }
          if (!editable) { e.preventDefault(); document.execCommand('selectAll'); return; }
        } else if (editable && matchHotkey(e, 'KeyZ', 'z', 'я')) {
          e.preventDefault();
          document.execCommand(e.shiftKey ? 'redo' : 'undo');
          return;
        } else if (editable && !e.shiftKey && matchHotkey(e, 'KeyY', 'y', 'н')) {
          e.preventDefault();
          document.execCommand('redo');
          return;
        }
      }
      if (!e.shiftKey && !e.altKey && matchHotkey(e, 'KeyP', 'p', 'з')) {
        // Ctrl+P: quick open a file
        e.preventDefault();
        setCurrentView('project');
        setNavRequest((p) => ({ action: 'file', n: (p?.n ?? 0) + 1 }));
      } else if (e.shiftKey && !e.altKey && matchHotkey(e, 'KeyO', 'o', 'щ')) {
        e.preventDefault();
        setCurrentView('project');
        setNavRequest((p) => ({ action: 'symbol', n: (p?.n ?? 0) + 1 }));
      } else if (
        // Ctrl+Shift+F anywhere, plain Ctrl+F outside the editor (inside it the
        // editor's own in-file find handles it): global search, straight to Files
        !e.altKey && matchHotkey(e, 'KeyF', 'f', 'а') &&
        (e.shiftKey || !(e.target as HTMLElement | null)?.closest?.('.code-editor'))
      ) {
        e.preventDefault();
        setCurrentView('project');
        setNavRequest((p) => ({ action: 'search', mode: 'find', n: (p?.n ?? 0) + 1 }));
      } else if (e.altKey && !e.shiftKey && (matchHotkey(e, 'KeyF', 'f', 'а') || matchHotkey(e, 'KeyR', 'r', 'к'))) {
        e.preventDefault();
        setCurrentView('project');
        setNavRequest((p) => ({ action: 'search', mode: matchHotkey(e, 'KeyR', 'r', 'к') ? 'replace' : 'find', n: (p?.n ?? 0) + 1 }));
      }
    };
    // Capture phase: inner widgets (editor, inputs) must not swallow global hotkeys
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const {
    accounts,
    activeId: activeAccountId,
    setActive: setActiveAccount,
    add: addAccount,
    remove: removeAccount,
  } = useAccounts();

  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showClone, setShowClone] = useState(false);

  const {
    projects,
    selectedProject,
    setSelectedProject,
    isLoading: projectsLoading,
    error: projectsError,
    addProject,
    removeProject,
    applyProjectUpdate,
    loadProjects,
  } = useProjects(activeAccountId);

  const [editProject, setEditProject] = useState<Project | null>(null);

  // Bottom terminal dock: one live hook for the selected project, shared by
  // the collapsed strip and the expanded right-side dock.
  const term = useTerminal(selectedProject?.id);
  // unfinished tasks of the selected project: shown as a number and a glow on the Chat tab
  const taskBoard = useTasks(selectedProject?.id);
  const openTaskCount = taskBoard.tasks.filter((task) => task.status !== 'done').length;
  const [termDock, setTermDock] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('otto-terminal-dock') === 'open';
    } catch {
      return false;
    }
  });
  // Settings → Terminal → shell: "tabby" puts the embedded Tabby window in the dock instead of Otto's terminal
  const [termShell, setTermShell] = useState('auto');
  useEffect(() => {
    void fetchAppSettings().then((s) => setTermShell(String(s.values['terminal.shell'] ?? 'auto'))).catch(() => undefined);
  }, [currentView, termDock]);
  const setTermDockPersist = useCallback((open: boolean) => {
    setTermDock(open);
    try {
      window.localStorage.setItem('otto-terminal-dock', open ? 'open' : 'closed');
    } catch { /* ignore */ }
  }, []);

  const {
    chats,
    selectedChatId,
    setSelectedChatId,
    add: addChat,
    rename: renameChat,
    remove: removeChat,
  } = useChats(selectedProject?.id);

  // Any navigation also closes the terminal dock: an expanded dock covers every view,
  // which made Home and the tabs look dead while it was open.
  const navigate = useCallback((view: ViewType) => {
    setTermDockPersist(false);
    setCurrentView(view);
  }, [setTermDockPersist]);

  const {
    messages,
    isConnected,
    isProcessing,
    queuedMessages,
    usage,
    runStats,
    lastRun,
    sendMessage,
    stopGeneration,
    regenerate,
  } = useChat(selectedProject?.id, selectedChatId);

  // the window title shows that work is in progress even when otto is in the background
  useEffect(() => {
    document.title = isProcessing ? '● zeithub.otto' : 'zeithub.otto';
  }, [isProcessing]);

  // "+" near the project starts a fresh conversation and switches to Chat.
  const handleNewChat = useCallback(() => {
    void addChat();
    setCurrentView('chat');
  }, [addChat]);

  type SendOptions = { model?: string; useTools?: boolean; useContext?: boolean; useWeb?: boolean; queue?: boolean };
  const pendingSend = useRef<{ content: string; images?: string[]; options?: SendOptions } | null>(null);

  const handleSendMessage = useCallback((content: string, images?: string[], options?: SendOptions) => {
    // Auto-name a fresh chat from its first message (instead of "Чат N").
    if (selectedChatId && messages.filter((m) => m.role === 'user' || m.role === 'assistant').length === 0) {
      const chat = chats.find((c) => c.id === selectedChatId);
      const isDefault = chat && (chat.title === 'Новый чат' || /^Чат\s+\d+$/.test(chat.title));
      if (isDefault) {
        const title = content.trim().replace(/\s+/g, ' ').slice(0, 40) + (content.trim().length > 40 ? '…' : '');
        if (title) void renameChat(selectedChatId, title);
      }
    }
    if (!selectedChatId) {
      // No chat yet: create one, then send from the effect below once the hook
      // has re-bound to it.
      pendingSend.current = { content, images, options };
      void addChat();
      return;
    }
    sendMessage(content, images, options, options?.queue);
  }, [sendMessage, selectedChatId, messages, chats, renameChat, addChat]);

  useEffect(() => {
    const pending = pendingSend.current;
    if (!pending || !selectedChatId) return;
    pendingSend.current = null;
    handleSendMessage(pending.content, pending.images, pending.options);
  }, [selectedChatId, handleSendMessage]);

  const handleSelectSuggestion = useCallback((prompt: string) => {
    handleSendMessage(prompt);
  }, [handleSendMessage]);

  // Buttons elsewhere in the app ("create .env with AI") hand a prompt to the agent and show the chat
  const askAiRef = useRef<(prompt: string) => void>(() => undefined);
  askAiRef.current = (prompt: string) => { setCurrentView('chat'); handleSendMessage(prompt); };
  useEffect(() => {
    const onAsk = (e: Event) => {
      const prompt = (e as CustomEvent<{ prompt?: string }>).detail?.prompt;
      if (prompt) askAiRef.current(prompt);
    };
    window.addEventListener('otto:ask-ai', onAsk);
    return () => window.removeEventListener('otto:ask-ai', onAsk);
  }, []);

  const handleAddContextItem = useCallback((path: string, type: 'file' | 'folder') => {
    setContextItems((prev) => {
      if (prev.some((item) => item.path === path)) return prev;
      return [...prev, { path, type, tokens: type === 'file' ? 1500 : 3000 }];
    });
  }, []);

  const handleRemoveContextItem = useCallback((path: string) => {
    setContextItems((prev) => prev.filter((item) => item.path !== path));
  }, []);

  // Per-project context: load when switching project, persist on change.
  useEffect(() => {
    const pid = selectedProject?.id;
    if (!pid) { setContextItems([]); return; }
    try {
      const raw = window.localStorage.getItem(`otto-context-${pid}`);
      setContextItems(raw ? JSON.parse(raw) : []);
    } catch { setContextItems([]); }
  }, [selectedProject?.id]);

  useEffect(() => {
    const pid = selectedProject?.id;
    if (!pid) return;
    try { window.localStorage.setItem(`otto-context-${pid}`, JSON.stringify(contextItems)); } catch { /* ignore */ }
  }, [contextItems, selectedProject?.id]);

  return (
    <div className="h-screen flex flex-col bg-[var(--bg-primary)]">
      <PermissionPrompts />
      <PluginRuntime />
      <Header
        taskCount={openTaskCount}
        tasksRunning={taskBoard.busy}
        busy={isProcessing}
        currentView={currentView}
        onViewChange={navigate}
        isConnected={isConnected}
        selectedProject={selectedProject}
        onNewChat={handleNewChat}
        onDeleteProject={removeProject}
        onEditProject={setEditProject}
        focusMode={focusMode}
        onToggleFocusMode={toggleFocusMode}
        accounts={accounts}
        activeAccountId={activeAccountId}
        onSelectAccount={setActiveAccount}
        onAddAccount={() => setShowAddAccount(true)}
        onCloneRepo={() => setShowClone(true)}
        onDeleteAccount={(id) => void removeAccount(id)}
      />

      <div className="flex-1 flex overflow-hidden">
        {!focusMode && (
          <Sidebar
            projects={projects}
            selectedProject={selectedProject}
            onSelectProject={setSelectedProject}
            onCreateProject={addProject}
            accounts={accounts}
            activeAccountId={activeAccountId}
            onDeleteProject={removeProject}
            onViewChange={navigate}
            onEditProject={setEditProject}
            chats={chats}
            selectedChatId={selectedChatId}
            busy={isProcessing}
            onSelectChat={setSelectedChatId}
            onAddChat={handleNewChat}
            onRenameChat={(id, title) => void renameChat(id, title)}
            onDeleteChat={(id) => void removeChat(id)}
            currentView={currentView}
          />
        )}

        <main className="flex-1 flex flex-col overflow-hidden min-w-0">
          {projectsLoading ? (
            <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">
              <div className="flex items-center gap-3">
                <div className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                {t('page.loadingProjects')}
              </div>
            </div>
          ) : projectsError ? (
            <div className="flex-1 flex items-center justify-center text-[var(--error)]">
              {projectsError}
            </div>
          ) : (
            <>
              <div className="flex-1 flex overflow-hidden min-h-0">
                {termDock ? (
                <div className="flex-1 flex flex-col overflow-hidden min-w-0">
                  {termShell === 'tabby' ? (
                    <TabbyView project={selectedProject} onCollapse={() => setTermDockPersist(false)} />
                  ) : (
                  <TerminalView
                    project={selectedProject}
                    term={term}
                    onCollapse={() => setTermDockPersist(false)}
                  />
                  )}
                </div>
                ) : (
                <div className="flex-1 flex flex-col overflow-hidden min-w-0">
              {currentView === 'home' && (
                <HomeView
                  projects={projects}
                  selectedProject={selectedProject}
                  onSelectProject={setSelectedProject}
                  onViewChange={navigate}
                />
              )}
              {currentView === 'chat' && (
                <ChatView
                  messages={messages}
                  isProcessing={isProcessing}
                  onSelectSuggestion={handleSelectSuggestion}
                  onRegenerate={regenerate}
                  runStats={runStats}
                  lastRun={lastRun}
                />
              )}
              {currentView === 'project' && selectedProject && (
                <ProjectView projectId={selectedProject.id} navRequest={navRequest} />
              )}
              {currentView === 'project' && !selectedProject && (
                <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">
                  {t('page.selectProjectFiles')}
                </div>
              )}
              {currentView === 'context' && (
                <ContextView
                  contextItems={contextItems}
                  onRemoveContextItem={handleRemoveContextItem}
                  onAddContextItem={handleAddContextItem}
                />
              )}
              {currentView === 'services' && (
                <ServicesView project={selectedProject} />
              )}
              {currentView === 'models' && <ModelsView />}
              {currentView === 'settings' && <SettingsView />}
              {currentView === 'docs' && <HelpView onNavigate={setCurrentView} />}
              {currentView === 'agents' && <AgentsView project={selectedProject} />}
              {currentView === 'preview' && <PreviewView project={selectedProject} openFile={previewFile} openUrl={previewUrl} />}
              {currentView === 'ssh' && <SshView />}
              {currentView === 'plugins' && <PluginsView />}
              {currentView === 'connectors' && <ConnectorsView project={selectedProject} onOpenTabby={() => { void saveAppSettings({ 'terminal.shell': 'tabby' }).then(() => { setTermShell('tabby'); setTermDockPersist(true); }); }} />}
              {currentView === 'data' && <DataView project={selectedProject} onOpenServices={() => setCurrentView('services')} />}
                </div>
              )}
              </div>
              {!termDock && (
                <TerminalBar
                  term={term}
                  projectName={selectedProject?.name ?? null}
                  onExpand={() => setTermDockPersist(true)}
                />
              )}
              {currentView === 'chat' && <TaskRunBanner projectId={selectedProject?.id} onOpenAgents={() => setCurrentView('agents')} />}
              {currentView !== 'services' && currentView !== 'models' && currentView !== 'settings' && currentView !== 'home' && currentView !== 'docs' && currentView !== 'agents' && currentView !== 'preview' && currentView !== 'data' && currentView !== 'ssh' && currentView !== 'plugins' && currentView !== 'connectors' && <Composer
                key={selectedProject?.id ?? 0}
                onSend={handleSendMessage}
                projectId={selectedProject?.id}
                onStop={stopGeneration}
                disabled={!selectedProject}
                isProcessing={isProcessing}
                queuedCount={queuedMessages.length}
                usage={usage}
                placeholder={
                  selectedProject
                    ? t('page.askAbout', { name: selectedProject.name })
                    : t('page.selectFirst')
                }
              />}
            </>
          )}
        </main>

        {!focusMode && (
          <TaskPanel
            projectId={selectedProject?.id}
            collapsed={tasksCollapsed}
            onToggle={() => setTasksCollapsed((v) => !v)}
          />
        )}
      </div>

      {/* Edit project dialog */}
      {editProject && (
        <EditProjectModal
          project={editProject}
          onClose={() => setEditProject(null)}
          onSaved={(updated) => applyProjectUpdate(updated)}
        />
      )}

      {/* Git account: add / clone */}
      {showAddAccount && (
        <AddAccountModal
          onClose={() => setShowAddAccount(false)}
          onAdd={async (token, provider) => { await addAccount(token, provider); }}
        />
      )}
      {showClone && (
        <CloneRepoModal
          accountId={activeAccountId}
          onClose={() => setShowClone(false)}
          onCloned={(project) => {
            void loadProjects();
            setSelectedProject(project);
            setCurrentView('project');
          }}
        />
      )}

      {/* Ctrl+K quick search */}
      <FirstRunSetup />
      <CommandPalette
        projects={projects}
        selectedProject={selectedProject}
        onSelectProject={setSelectedProject}
        onViewChange={navigate}
        onNewChat={handleNewChat}
      />

    </div>
  );
}

/** `?docs=1` opens only the documentation (a separate window); anything else is the app. */
function Root() {
  const [docs, setDocs] = useState<boolean | null>(null);
  useEffect(() => {
    setDocs(new URLSearchParams(window.location.search).get('docs') === '1');
  }, []);
  if (docs === null) return null;
  return docs ? <DocsWindow /> : <AppShell />;
}

export default function Home() {
  return (
    <I18nProvider>
      <ConfirmProvider>
        <Root />
      </ConfirmProvider>
    </I18nProvider>
  );
}

