'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileInfo, FileKind, NavInfo } from '../../types';
import { useFiles } from '../../hooks/useFiles';
import { createProjectFile, createProjectFolder, fetchFiles, fetchNav, fetchSymbols, fileRawUrl, moveProjectEntry, saveFileContent, uploadProjectFile, deleteProjectEntry, copyProjectEntry, type CodeSymbol } from '../../lib/api';
import { useConfirm } from '../ui/Confirm';
import { useT } from '../../lib/i18n';
import { matchHotkey } from '../../lib/keys';
import { CodeEditor } from '../project/CodeEditor';
import { EnvButton } from '../project/EnvButton';
import { QuickOpenModal } from '../project/QuickOpenModal';
import { ExplorerMenu } from '../project/ExplorerMenu';
import { hasOsFiles, readDroppedFiles } from '../../lib/dropfiles';
import { GlobalSearchModal, type SearchHighlight } from '../project/GlobalSearchModal';
import {
  Folder, FolderOpen, FileText, FileCode, FileJson, FileImage,
  FileSpreadsheet, FileArchive, ChevronRight, ChevronDown, X, Info, Save, Check, MonitorSmartphone,
  FilePlus2, FolderPlus, Loader2, RefreshCw, Route as RouteIcon, Braces, FileSearch, Search, Pencil, Trash2, Copy, CopyPlus,
} from 'lucide-react';

interface ProjectViewProps {
  projectId?: number;
  /** Global hotkey requests from the app shell (auto-switches to Files). */
  navRequest?: { action: 'search' | 'symbol' | 'file'; mode?: 'find' | 'replace'; n: number } | null;
}

const KIND_ICON: Record<FileKind, typeof FileText> = {
  folder: Folder,
  code: FileCode,
  data: FileJson,
  doc: FileText,
  image: FileImage,
  media: FileImage,
  binary: FileArchive,
  file: FileText,
};

const METHOD_COLOR: Record<string, string> = {
  GET: 'bg-[var(--success)]/15 text-[var(--success)]',
  POST: 'bg-[var(--accent-glow)] text-[var(--accent)]',
  PUT: 'bg-[var(--warning)]/15 text-[var(--warning)]',
  PATCH: 'bg-[var(--warning)]/15 text-[var(--warning)]',
  DELETE: 'bg-[var(--error)]/15 text-[var(--error)]',
};

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toUpperCase() : '';
}

export function ProjectView({ projectId, navRequest }: ProjectViewProps) {
  const {
    files,
    selectedFile,
    fileContent,
    setFileContent,
    isLoading,
    isFileLoading,
    error,
    loadFiles,
    loadFileContent,
    setSelectedFile,
  } = useFiles(projectId);

  // Lazy file tree: expanded folder paths + their loaded children.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Record<string, FileInfo[]>>({});
  const [loadingFolder, setLoadingFolder] = useState<Set<string>>(new Set());
  // Inline create input (no window.prompt — unsupported in Electron).
  const [creatingIn, setCreatingIn] = useState<{ kind: 'file' | 'folder'; parent: string } | null>(null);
  const [newName, setNewName] = useState('');
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragTabIndex = useRef<number | null>(null);
  // Framework navigation (routes) + editor jump-to-line.
  const [explorerMode, setExplorerMode] = useState<'files' | 'routes'>('files');
  const [nav, setNav] = useState<NavInfo | null>(null);
  const [navLoading, setNavLoading] = useState(false);
  const [gotoLine, setGotoLine] = useState<number | undefined>(undefined);
  // Go to symbol popup (Ctrl+Shift+O): classes, methods, functions.
  const [symOpen, setSymOpen] = useState(false);
  const [symQuery, setSymQuery] = useState('');
  const [symResults, setSymResults] = useState<CodeSymbol[]>([]);
  const [symLoading, setSymLoading] = useState(false);
  const [symActive, setSymActive] = useState(0);
  const symInputRef = useRef<HTMLInputElement>(null);
  const symSeq = useRef(0);
  const [dropMsg, setDropMsg] = useState<string | null>(null);
  // Quick open (Ctrl+P): any file by a few letters of its name
  const [quickOpen, setQuickOpen] = useState(false);
  // Global find/replace modal (Ctrl+Alt+F / Ctrl+Alt+R) + Explorer highlight.
  const [gsearch, setGsearch] = useState<{ mode: 'find' | 'replace' } | null>(null);
  const [matchPaths, setMatchPaths] = useState<Set<string> | null>(null);
  const [matchInfo, setMatchInfo] = useState<{ n: number; f: number } | null>(null);
  const { t } = useT();
  const confirm = useConfirm();

  // --- editor state -------------------------------------------------------
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [savedContents, setSavedContents] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [tabEntries, setTabEntries] = useState<Record<string, FileInfo>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const hasDraft = selectedFile !== null && Object.prototype.hasOwnProperty.call(drafts, selectedFile);
  const draft = selectedFile && hasDraft ? drafts[selectedFile] : null;
  const originalContent = selectedFile ? savedContents[selectedFile] ?? fileContent : fileContent;
  const editorContent = draft ?? originalContent;
  const isDirty = hasDraft && draft !== originalContent;

  useEffect(() => {
    setExpanded(new Set());
    setChildren({});
    setCreatingIn(null);
    setNav(null);
    setExplorerMode('files');
    setSelectedFile(null);
    setOpenTabs([]);
    setSavedContents({});
    setDrafts({});
    setTabEntries({});
    setGsearch(null);
    setMatchPaths(null);
    setMatchInfo(null);
  }, [projectId, setSelectedFile]);

  // Clear transient save feedback when switching tabs.
  useEffect(() => {
    setSaveError(null);
  }, [selectedFile]);

  // Symbol popup + global search hotkeys are owned by the app shell
  // (page.tsx forwards them via navRequest, auto-switching to Files).

  useEffect(() => {
    if (symOpen) requestAnimationFrame(() => symInputRef.current?.focus());
  }, [symOpen]);

  // Debounced workspace symbol search.
  useEffect(() => {
    if (!symOpen || !projectId) return;
    if (!symQuery.trim()) {
      setSymResults([]);
      setSymLoading(false);
      return;
    }
    setSymLoading(true);
    const seq = ++symSeq.current;
    const timer = setTimeout(() => {
      fetchSymbols(projectId, symQuery.trim())
        .then((r) => {
          if (symSeq.current !== seq) return;
          setSymResults(r);
          setSymActive(0);
        })
        .catch(() => {
          if (symSeq.current === seq) setSymResults([]);
        })
        .finally(() => {
          if (symSeq.current === seq) setSymLoading(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [symOpen, symQuery, projectId]);

  useEffect(() => {
    void loadFiles('');
  }, [loadFiles]);

  // Load framework navigation (routes) for the project.
  useEffect(() => {
    if (!projectId) { setNav(null); return; }
    let cancelled = false;
    setNavLoading(true);
    fetchNav(projectId)
      .then((info) => { if (!cancelled) setNav(info); })
      .catch(() => { if (!cancelled) setNav(null); })
      .finally(() => { if (!cancelled) setNavLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  /** Persist the draft to the backend (Ctrl+S / Save button). */
  const save = useCallback(async () => {
    if (!projectId || !selectedFile || !hasDraft || draft === null || saving) return;
    if (draft === originalContent) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveFileContent(projectId, selectedFile, draft);
      setFileContent(draft);
      setSavedContents((prev) => ({ ...prev, [selectedFile]: draft }));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[selectedFile];
        return next;
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : t('pv.saveFail'));
    } finally {
      setSaving(false);
    }
  }, [projectId, selectedFile, draft, hasDraft, saving, originalContent, setFileContent, t]);

  /** Ask before navigating away from unsaved edits. */
  const confirmDiscard = useCallback(async () => {
    if (!isDirty) return true;
    const confirmed = await confirm({ title: t('pv.unsavedTitle'), message: t('pv.unsavedMsg'), danger: true, confirmText: t('pv.continue') });
    if (confirmed && selectedFile) {
      setDrafts((prev) => { const next = { ...prev }; delete next[selectedFile]; return next; });
    }
    return confirmed;
  }, [isDirty, selectedFile, confirm, t]);

  // Ctrl+S / Cmd+S anywhere in the view saves the open file
  // (physical key + EN/RU letter — see lib/keys).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && matchHotkey(e, 'KeyS', 's', 'ы') && isDirty) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isDirty, save]);

  // Global requests from the app shell (hotkeys work from any view).
  useEffect(() => {
    if (!navRequest) return;
    if (navRequest.action === 'search') {
      setGsearch({ mode: navRequest.mode ?? 'find' });
    } else if (navRequest.action === 'file') {
      setQuickOpen(true);
    } else {
      setSymQuery('');
      setSymResults([]);
      setSymActive(0);
      setSymOpen(true);
    }
  }, [navRequest]);

  const selectedEntry = useMemo(() => {
    if (selectedFile && tabEntries[selectedFile]) return tabEntries[selectedFile];
    const walk = (items: FileInfo[]): FileInfo | null => {
      for (const item of items) {
        if (item.path === selectedFile) return item;
        const found = item.children ? walk(item.children) : null;
        if (found) return found;
      }
      return null;
    };
    return walk(files);
  }, [files, selectedFile, tabEntries]);

  const refreshFolder = useCallback(async (parent: string) => {
    if (!projectId) return;
    if (parent === '') { await loadFiles(''); return; }
    try {
      const rows = await fetchFiles(projectId, parent);
      setChildren((prev) => ({ ...prev, [parent]: rows }));
    } catch { /* ignore */ }
  }, [projectId, loadFiles]);

  /** Reload the root and every currently-expanded folder from disk. */
  const syncTree = useCallback(async () => {
    if (!projectId) return;
    await loadFiles('');
    for (const p of Array.from(expanded)) {
      try {
        const rows = await fetchFiles(projectId, p);
        setChildren((prev) => ({ ...prev, [p]: rows }));
      } catch { /* folder may be gone */ }
    }
  }, [projectId, loadFiles, expanded]);

  // Auto-refresh when the AI/agent writes files (event from useChat).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { projectId?: number } | undefined;
      if (!projectId || (detail?.projectId && detail.projectId !== projectId)) return;
      void syncTree();
      // Reload the open file if it has no unsaved draft.
      if (selectedFile && !Object.prototype.hasOwnProperty.call(drafts, selectedFile)) {
        void loadFileContent(selectedFile).then((c) => {
          if (c !== null) setSavedContents((prev) => ({ ...prev, [selectedFile]: c }));
        });
      }
    };
    window.addEventListener('otto:files-changed', handler);
    return () => window.removeEventListener('otto:files-changed', handler);
  }, [projectId, syncTree, selectedFile, drafts, loadFileContent]);

  /** Reflect a moved/renamed path in the open editor tabs & buffers. */
  const renamePathInState = (from: string, to: string) => {
    // a renamed / moved folder carries the tabs of the files inside it
    const swap = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
    setOpenTabs((prev) => prev.map(swap));
    const remap = <T,>(obj: Record<string, T>) => {
      if (!Object.keys(obj).some((k) => swap(k) !== k)) return obj;
      const next: Record<string, T> = {};
      for (const [k, v] of Object.entries(obj)) next[swap(k)] = v;
      return next;
    };
    setDrafts((prev) => remap(prev));
    setSavedContents((prev) => remap(prev));
    setTabEntries((prev) => {
      if (!Object.keys(prev).some((k) => swap(k) !== k)) return prev;
      const next: Record<string, FileInfo> = {};
      for (const [k, v] of Object.entries(prev)) {
        const nk = swap(k);
        next[nk] = nk === k ? v : { ...v, path: nk, name: nk.split('/').pop() ?? v.name };
      }
      return next;
    });
    setExpanded((prev) => new Set(Array.from(prev).map(swap)));
    setChildren((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => swap(k) === k))); // reloaded when opened again
    if (selectedFile) setSelectedFile(swap(selectedFile));
  };

  // ---- rename / delete / duplicate (context menu, F2, Delete) ----
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [serverNameError, setServerNameError] = useState<string | null>(null);
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; item: FileInfo | null; parent: string } | null>(null);
  const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const siblingsOf = (parent: string): FileInfo[] => (parent ? children[parent] ?? [] : files);

  /** What is wrong with a new name (invalid characters, or it already exists in that folder), or null. */
  const nameProblem = (name: string, parent: string, ignorePath?: string): string | null => {
    const n = name.trim();
    if (!n) return null;
    if (n === '.' || n === '..' || /[\\/:*?"<>|]/.test(n) || /[. ]$/.test(n)) return t('pv.nameInvalid');
    const clash = siblingsOf(parent).some((s) => s.path !== ignorePath && s.name.toLowerCase() === n.toLowerCase());
    return clash ? t('pv.nameExists', { name: n }) : null;
  };
  const errorText = (e: unknown, name: string): string => {
    const m = e instanceof Error ? e.message : '';
    return /already exists/i.test(m) ? t('pv.nameExists', { name }) : m || t('pv.renameFail');
  };

  const startRename = (item: FileInfo) => {
    setCtxMenu(null);
    setCreatingIn(null);
    setServerNameError(null);
    setRenameValue(item.name);
    setRenaming(item.path);
  };

  const submitRename = async () => {
    if (!projectId || !renaming) return;
    const from = renaming;
    const name = renameValue.trim();
    const parent = parentOf(from);
    if (!name || name === from.split('/').pop()) { setRenaming(null); return; }
    const problem = nameProblem(name, parent, from);
    if (problem) { setServerNameError(problem); return; }
    const to = parent ? `${parent}/${name}` : name;
    try {
      await moveProjectEntry(projectId, from, to);
      renamePathInState(from, to);
      setRenaming(null);
      setServerNameError(null);
      setFocusPath(to);
      await refreshFolder(parent);
    } catch (e) {
      setServerNameError(errorText(e, name));
    }
  };

  const deleteEntry = async (item: FileInfo) => {
    setCtxMenu(null);
    if (!projectId) return;
    const ok = await confirm({
      title: t('pv.deleteTitle'),
      message: t(item.is_dir ? 'pv.deleteDirMsg' : 'pv.deleteMsg', { name: item.name }),
      danger: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    try {
      const { trashed } = await deleteProjectEntry(projectId, item.path);
      // close the tabs of the deleted file / folder
      const gone = (p: string) => p === item.path || p.startsWith(`${item.path}/`);
      const remaining = openTabs.filter((p) => !gone(p));
      setOpenTabs(remaining);
      setDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !gone(k))));
      setSavedContents((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !gone(k))));
      setTabEntries((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !gone(k))));
      if (selectedFile && gone(selectedFile)) {
        const next = remaining[remaining.length - 1] ?? null;
        setSelectedFile(next);
        setFileContent(next ? savedContents[next] ?? '' : '');
      }
      setExpanded((prev) => new Set(Array.from(prev).filter((p) => !gone(p))));
      setFocusPath(null);
      await refreshFolder(parentOf(item.path));
      setDropMsg(t(trashed ? 'pv.deletedTrash' : 'pv.deleted', { name: item.name }));
      window.setTimeout(() => setDropMsg(null), 4000);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : t('pv.deleteFail'));
    }
  };

  const duplicateEntry = async (item: FileInfo) => {
    setCtxMenu(null);
    if (!projectId) return;
    try {
      const to = await copyProjectEntry(projectId, item.path);
      await refreshFolder(parentOf(item.path));
      setFocusPath(to);
      startRename({ ...item, path: to, name: to.split('/').pop() ?? item.name });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : t('pv.duplicateFail'));
    }
  };

  const copyPathOf = (item: FileInfo) => {
    setCtxMenu(null);
    void navigator.clipboard?.writeText(item.path).catch(() => undefined);
  };

  /** Files or folders dragged in from the operating system: copied into `targetFolder`. */
  const dropOsFiles = async (dt: DataTransfer, targetFolder: string) => {
    if (!projectId) return;
    let dropped: Awaited<ReturnType<typeof readDroppedFiles>>;
    try { dropped = await readDroppedFiles(dt); } catch { return; }
    if (dropped.length === 0) return;
    let saved = 0;
    let skipped = 0;
    let failed: string | null = null;
    for (const d of dropped) {
      const rel = targetFolder ? `${targetFolder}/${d.path}` : d.path;
      try {
        await uploadProjectFile(projectId, rel, d.file);
        saved++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/already exists/i.test(msg)) skipped++; else failed = msg;
      }
    }
    if (targetFolder) setExpanded((p) => new Set(p).add(targetFolder));
    await refreshFolder(targetFolder);
    for (const d of dropped) {
      const top = d.path.includes('/') ? d.path.split('/')[0] : '';
      if (top) await refreshFolder(targetFolder ? `${targetFolder}/${top}` : top);
    }
    setDropMsg(failed ?? t('pv.dropDone', { saved, skipped }));
    window.setTimeout(() => setDropMsg(null), 4000);
  };

  const moveEntry = async (from: string, targetFolder: string) => {
    if (!projectId || !from) return;
    const base = from.split('/').pop() ?? from;
    const to = targetFolder ? `${targetFolder}/${base}` : base;
    if (from === to) return;
    if (targetFolder === from || targetFolder.startsWith(`${from}/`)) return; // into itself
    const fromParent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
    try {
      await moveProjectEntry(projectId, from, to);
      renamePathInState(from, to);
      if (targetFolder) setExpanded((p) => new Set(p).add(targetFolder));
      await refreshFolder(fromParent);
      await refreshFolder(targetFolder);
    } catch (e) {
      setSaveError(errorText(e, base));
    }
  };

  const toggleFolder = async (item: FileInfo) => {
    const willOpen = !expanded.has(item.path);
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(item.path)) n.delete(item.path); else n.add(item.path);
      return n;
    });
    if (willOpen && !children[item.path] && projectId) {
      setLoadingFolder((p) => new Set(p).add(item.path));
      try {
        const rows = await fetchFiles(projectId, item.path);
        setChildren((prev) => ({ ...prev, [item.path]: rows }));
      } catch { /* ignore */ }
      finally { setLoadingFolder((p) => { const n = new Set(p); n.delete(item.path); return n; }); }
    }
  };

  const openFile = async (item: FileInfo, line?: number) => {
    if (saving || !(await confirmDiscard())) return;
    setSaveError(null);
    setGotoLine(line);
    setTabEntries((prev) => ({ ...prev, [item.path]: item }));
    setOpenTabs((prev) => prev.includes(item.path) ? prev : [...prev, item.path]);
    if (Object.prototype.hasOwnProperty.call(savedContents, item.path)) {
      setSelectedFile(item.path);
      setFileContent(savedContents[item.path]);
      return;
    }
    if (item.type === 'image' || item.type === 'binary' || item.type === 'media') {
      setSelectedFile(item.path);
      setFileContent('');
      setSavedContents((prev) => ({ ...prev, [item.path]: '' }));
      return;
    }
    const content = await loadFileContent(item.path);
    if (content !== null) setSavedContents((prev) => ({ ...prev, [item.path]: content }));
  };

  const openSymbol = useCallback((s: CodeSymbol) => {
    setSymOpen(false);
    void openFile(
      { path: s.path, name: s.path.split('/').pop() ?? s.path, is_dir: false, type: 'code', size: 0 },
      s.line,
    );
  }, [openFile]);

  const resetSearch = useCallback(() => {
    setMatchPaths(null);
    setMatchInfo(null);
  }, []);

  /** Reveal matched files in the tree: expand ancestors, loading as needed. */
  const expandAncestors = useCallback(async (paths: string[]) => {
    const dirs = new Set<string>();
    for (const p of paths) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    for (const d of dirs) {
      setExpanded((prev) => new Set(prev).add(d));
      if (!children[d] && projectId) {
        try {
          const rows = await fetchFiles(projectId, d);
          setChildren((prev) => ({ ...prev, [d]: rows }));
        } catch { /* keep collapsed on error */ }
      }
    }
  }, [children, projectId]);

  const onSearchResults = useCallback((info: SearchHighlight | null) => {
    if (!info) {
      resetSearch();
      return;
    }
    setMatchPaths(new Set(info.paths));
    setMatchInfo({ n: info.totalMatches, f: info.totalFiles });
    void expandAncestors(info.paths);
  }, [resetSearch, expandAncestors]);

  const reorderTabs = (to: number) => {
    const from = dragTabIndex.current;
    dragTabIndex.current = null;
    if (from === null || from === to) return;
    setOpenTabs((prev) => {
      const arr = [...prev];
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return arr;
    });
  };

  const selectTab = async (path: string) => {
    if (saving || path === selectedFile || !(await confirmDiscard())) return;
    setSaveError(null);
    setSelectedFile(path);
    setFileContent(savedContents[path] ?? '');
  };

  const closeTab = async (path: string) => {
    if (saving) return;
    const tabDirty = Object.prototype.hasOwnProperty.call(drafts, path)
      && drafts[path] !== savedContents[path];
    if (tabDirty && !(await confirm({ title: t('pv.unsavedTitle'), message: t('pv.unsavedClose'), danger: true, confirmText: t('common.close') }))) return;
    const remaining = openTabs.filter((tab) => tab !== path);
    setOpenTabs(remaining);
    setDrafts((prev) => { const next = { ...prev }; delete next[path]; return next; });
    setSavedContents((prev) => { const next = { ...prev }; delete next[path]; return next; });
    setTabEntries((prev) => { const next = { ...prev }; delete next[path]; return next; });
    if (path === selectedFile) {
      const next = remaining[remaining.length - 1] ?? null;
      setSelectedFile(next);
      setFileContent(next ? savedContents[next] ?? '' : '');
    }
  };

  const startCreate = (kind: 'file' | 'folder', parent: string) => {
    if (parent) setExpanded((p) => new Set(p).add(parent));
    setRenaming(null);
    setServerNameError(null);
    setNewName('');
    setCreatingIn({ kind, parent });
  };

  const submitCreate = async () => {
    if (!projectId || !creatingIn) return;
    const name = newName.trim();
    if (!name) { setCreatingIn(null); return; }
    const parent = creatingIn.parent;
    const path = parent ? `${parent}/${name}` : name;
    const kind = creatingIn.kind;
    const problem = nameProblem(name, parent);
    if (problem) { setServerNameError(problem); return; }
    try {
      if (kind === 'file') await createProjectFile(projectId, path);
      else await createProjectFolder(projectId, path);
      setCreatingIn(null); setNewName('');
      await refreshFolder(parent);
      if (kind === 'file') await openFile({ path, name, is_dir: false, type: 'code', size: 0 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (/already exists/i.test(msg)) setServerNameError(t('pv.nameExists', { name }));
      else setSaveError(msg || (kind === 'file' ? t('pv.createFileFail') : t('pv.createFolderFail')));
    }
  };

  const isImage = selectedEntry?.type === 'image';

  const createInputRow = (depth: number) => {
    if (!creatingIn) return null;
    const Icon = creatingIn.kind === 'folder' ? Folder : FileText;
    const problem = serverNameError ?? nameProblem(newName, creatingIn.parent);
    return (
      <div>
        <div className="flex items-center gap-1.5 px-2 py-1" style={{ paddingLeft: `${depth * 12 + 8}px` }}>
          <Icon size={14} className="shrink-0 text-[var(--accent)]" />
          <span className="shrink-0 text-[10px] font-mono text-[var(--text-muted)]" title={creatingIn.parent || t('pv.projectRoot')}>{creatingIn.parent ? `${creatingIn.parent.split('/').pop()}/` : 'root/'}</span>
          <input
            autoFocus
            value={newName}
            onChange={(e) => { setNewName(e.target.value); setServerNameError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitCreate(); if (e.key === 'Escape') { setCreatingIn(null); setNewName(''); setServerNameError(null); } }}
            onBlur={() => { if (!newName.trim()) { setCreatingIn(null); setNewName(''); setServerNameError(null); } }}
            placeholder={creatingIn.kind === 'file' ? t('pv.fileName') : t('pv.folderName')}
            className={`flex-1 min-w-0 rounded border bg-[var(--bg-primary)] px-1.5 py-0.5 text-sm outline-none ${problem ? 'border-[var(--error)]' : 'border-[var(--accent)]/50'}`}
          />
        </div>
        {problem && <div className="pb-1 text-[11px] text-[var(--error)]" style={{ paddingLeft: `${depth * 12 + 34}px` }}>{problem}</div>}
      </div>
    );
  };

  const renderTree = (items: FileInfo[], parent: string, depth: number) => (
    <>
      {creatingIn && creatingIn.parent === parent && createInputRow(depth)}
      {items.map((item) => {
        const isDir = item.is_dir;
        const kind: FileKind = isDir ? 'folder' : (item.type ?? 'file');
        const Icon = KIND_ICON[kind] ?? FileText;
        const ext = isDir ? '' : extensionOf(item.name);
        const open = expanded.has(item.path);
        return (
          <div key={item.path}>
            <div
              draggable
              onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('text/otto-path', item.path); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={isDir ? (e) => { e.preventDefault(); e.stopPropagation(); setDropTarget(item.path); } : undefined}
              onDragLeave={isDir ? () => setDropTarget((t) => (t === item.path ? null : t)) : undefined}
              onDrop={isDir ? (e) => {
                e.preventDefault(); e.stopPropagation(); setDropTarget(null);
                if (hasOsFiles(e.dataTransfer)) { void dropOsFiles(e.dataTransfer, item.path); return; }
                const from = e.dataTransfer.getData('text/otto-path'); if (from) void moveEntry(from, item.path);
              } : undefined}
              className={`group flex items-center gap-1.5 px-2 py-1 cursor-pointer rounded text-sm transition-colors ${
                dropTarget === item.path
                  ? 'bg-[var(--accent-glow)] ring-1 ring-[var(--accent)]/50'
                  : selectedFile === item.path
                    ? 'bg-[var(--accent-glow)] text-[var(--accent)]'
                    : matchPaths !== null && !isDir && matchPaths.has(item.path)
                      ? 'bg-[var(--accent-glow)]/60 text-[var(--accent)]'
                      : `text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]${matchPaths !== null && !isDir ? ' opacity-40' : ''}`
              }`}
              style={{ paddingLeft: `${depth * 12 + 4}px` }}
              onClick={() => { setFocusPath(item.path); if (renaming !== item.path) { if (isDir) void toggleFolder(item); else void openFile(item); } }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setFocusPath(item.path); setCtxMenu({ x: e.clientX, y: e.clientY, item, parent: isDir ? item.path : parentOf(item.path) }); }}
              title={item.path}
            >
              {isDir ? (
                open ? <ChevronDown size={13} className="shrink-0 text-[var(--text-muted)]" /> : <ChevronRight size={13} className="shrink-0 text-[var(--text-muted)]" />
              ) : <span className="w-[13px] shrink-0" />}
              <Icon size={14} className={`shrink-0 ${isDir ? 'text-[var(--accent)]' : ''}`} />
              {renaming === item.path ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => { setRenameValue(e.target.value); setServerNameError(null); }}
                  onFocus={(e) => { const dot = item.is_dir ? -1 : e.currentTarget.value.lastIndexOf('.'); e.currentTarget.setSelectionRange(0, dot > 0 ? dot : e.currentTarget.value.length); }}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void submitRename(); if (e.key === 'Escape') { setRenaming(null); setServerNameError(null); } }}
                  onBlur={() => { setRenaming(null); setServerNameError(null); }}
                  aria-label={t('pv.rename')}
                  className={`flex-1 min-w-0 rounded border bg-[var(--bg-primary)] px-1.5 py-0 text-sm text-[var(--text-primary)] outline-none ${(serverNameError ?? nameProblem(renameValue, parentOf(item.path), item.path)) ? 'border-[var(--error)]' : 'border-[var(--accent)]/50'}`}
                />
              ) : (
                <span className="truncate flex-1">{item.name}</span>
              )}
              {isDir && (
                <span className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={(e) => { e.stopPropagation(); startCreate('file', item.path); }} className="p-0.5 text-[var(--text-muted)] hover:text-[var(--accent)]" title={t('pv.newFile')}><FilePlus2 size={12} /></button>
                  <button onClick={(e) => { e.stopPropagation(); startCreate('folder', item.path); }} className="p-0.5 text-[var(--text-muted)] hover:text-[var(--accent)]" title={t('pv.newFolder')}><FolderPlus size={12} /></button>
                </span>
              )}
              {ext && (
                <span className="text-[9px] font-mono px-1 rounded bg-[var(--bg-active)] text-[var(--text-muted)] group-hover:text-[var(--text-secondary)] shrink-0">{ext}</span>
              )}
            </div>
            {renaming === item.path && (serverNameError ?? nameProblem(renameValue, parentOf(item.path), item.path)) && (
              <div className="pb-1 text-[11px] text-[var(--error)]" style={{ paddingLeft: `${depth * 12 + 34}px` }}>{serverNameError ?? nameProblem(renameValue, parentOf(item.path), item.path)}</div>
            )}
            {isDir && open && (
              children[item.path]
                ? renderTree(children[item.path], item.path, depth + 1)
                : loadingFolder.has(item.path)
                  ? <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] py-1" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}><Loader2 size={12} className="animate-spin" /> …</div>
                  : <div className="text-xs text-[var(--text-muted)] py-1" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>{t('pv.empty')}</div>
            )}
          </div>
        );
      })}
    </>
  );

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* File Explorer */}
      <div
        tabIndex={-1}
        onKeyDown={(e) => {
          if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
          const all = [...files, ...Object.values(children).flat()];
          const item = focusPath ? all.find((f) => f.path === focusPath) : undefined;
          if (!item) return;
          if (e.key === 'F2') { e.preventDefault(); startRename(item); }
          else if (e.key === 'Delete') { e.preventDefault(); void deleteEntry(item); }
        }}
        className="w-[260px] border-r border-[var(--border-color)] bg-[var(--bg-secondary)] flex flex-col overflow-hidden outline-none"
      >
        <div className="flex h-9 items-center justify-between px-3 border-b border-[var(--border-color)]">
          <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">{t('pv.explorer')}</span>
          <div className="flex items-center gap-1">
            {projectId && <EnvButton projectId={projectId} onOpen={(p) => void openFile({ path: p, name: p.split('/').pop() ?? p, is_dir: false, type: 'code', size: 0 })} />}
            <button onClick={() => setQuickOpen(true)} className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]" title={t('qo.title')} aria-label={t('qo.title')}>
              <Search size={13} />
            </button>
            <button onClick={() => { setSymQuery(''); setSymResults([]); setSymActive(0); setSymOpen(true); }} className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]" title={t('sym.hint')}>
              <Braces size={13} />
            </button>
            <button onClick={() => void syncTree()} className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]" title={t('pv.sync')}>
              <RefreshCw size={13} />
            </button>
            <button onClick={() => startCreate('file', '')} className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]" title={t('pv.newFileRoot')}>
              <FilePlus2 size={14} />
            </button>
            <button onClick={() => startCreate('folder', '')} className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]" title={t('pv.newFolderRoot')}>
              <FolderPlus size={14} />
            </button>
          </div>
        </div>

        {/* Search-matches banner (global find pushes files here) */}
        {matchInfo && (
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-[var(--border-color)] bg-[var(--accent-glow)]/40">
            <FileSearch size={12} className="text-[var(--accent)] shrink-0" />
            <span className="flex-1 min-w-0 truncate text-xs text-[var(--text-secondary)]">
              {t('search.results')
                .replace('{n}', String(matchInfo.n))
                .replace('{f}', String(matchInfo.f))}
            </span>
            <button
              onClick={resetSearch}
              title={t('search.reset')}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              <X size={11} /> {t('search.reset')}
            </button>
          </div>
        )}

        {/* Files / Routes switch (routes available for detected frameworks) */}
        {nav && nav.routes.length > 0 && (
          <div className="flex gap-1 px-2 py-1.5 border-b border-[var(--border-color)]">
            <button onClick={() => setExplorerMode('files')} className={`flex-1 flex items-center justify-center gap-1.5 py-1 rounded-md text-xs transition-colors ${explorerMode === 'files' ? 'bg-[var(--accent-glow)] text-[var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}`}><FileText size={12}/>{t('pv.files')}</button>
            <button onClick={() => setExplorerMode('routes')} className={`flex-1 flex items-center justify-center gap-1.5 py-1 rounded-md text-xs transition-colors ${explorerMode === 'routes' ? 'bg-[var(--accent-glow)] text-[var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}`}><RouteIcon size={12}/>{t('pv.routes')} <span className="opacity-60">{nav.routes.length}</span></button>
          </div>
        )}

        {explorerMode === 'routes' && nav ? (
          <div className="flex-1 overflow-y-auto p-1">
            {navLoading ? (
              <div className="flex items-center gap-1.5 p-3 text-sm text-[var(--text-muted)]"><Loader2 size={13} className="animate-spin"/>…</div>
            ) : nav.routes.map((r, i) => (
              <button
                key={`${r.method}-${r.uri}-${i}`}
                onClick={() => void openFile({ path: r.file, name: r.file.split('/').pop() ?? r.file, is_dir: false, type: 'code', size: 0 }, r.line)}
                className="w-full text-left px-2 py-1.5 rounded hover:bg-[var(--bg-hover)] group"
                title={`${r.method} ${r.uri} → ${r.controller}@${r.action}`}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`text-[9px] font-mono font-semibold px-1 py-0.5 rounded shrink-0 ${METHOD_COLOR[r.method] ?? 'bg-[var(--bg-active)] text-[var(--text-muted)]'}`}>{r.method}</span>
                  <span className="text-xs text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] truncate">{r.uri}</span>
                </div>
                <div className="text-[10px] text-[var(--text-muted)] font-mono truncate mt-0.5 pl-0.5">{r.controller}@{r.action}</div>
              </button>
            ))}
          </div>
        ) : (
          <div
            className={`flex-1 overflow-y-auto p-1 ${dropTarget === '' ? 'bg-[var(--accent-glow)]/30' : ''}`}
            onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, item: null, parent: '' }); }}
            onDragOver={(e) => { e.preventDefault(); setDropTarget(''); }}
            onDragLeave={() => setDropTarget((t) => (t === '' ? null : t))}
            onDrop={(e) => {
              e.preventDefault(); setDropTarget(null);
              if (hasOsFiles(e.dataTransfer)) { void dropOsFiles(e.dataTransfer, ''); return; }
              const from = e.dataTransfer.getData('text/otto-path'); if (from) void moveEntry(from, '');
            }}
          >
            {dropMsg && <div className="mx-1 mb-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2 py-1 text-[11px] text-[var(--text-secondary)]">{dropMsg}</div>}
            {isLoading ? (
              <div className="p-3 text-sm text-[var(--text-muted)]">{t('common.loading')}</div>
            ) : error ? (
              <div className="p-3 text-sm text-[var(--error)]">{error}</div>
            ) : files.length === 0 && !creatingIn ? (
              <div className="p-3 text-sm text-[var(--text-muted)]">{t('pv.emptyFolder')}</div>
            ) : (
              renderTree(files, '', 0)
            )}
          </div>
        )}
      </div>

      {/* Viewer */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedFile ? (
          <>
            {/* Tab bar — top row, height matches the Explorer header (h-9) */}
            <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-[var(--border-color)] bg-[var(--bg-primary)]">
              {openTabs.map((path, tabIndex) => {
                const entry = tabEntries[path];
                const kind = entry?.type ?? 'file';
                const Icon = KIND_ICON[kind] ?? FileText;
                const dirty = Object.prototype.hasOwnProperty.call(drafts, path)
                  && drafts[path] !== savedContents[path];
                const active = path === selectedFile;
                return (
                  <div
                    key={path}
                    draggable
                    onDragStart={() => { dragTabIndex.current = tabIndex; }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); reorderTabs(tabIndex); }}
                    className={`flex max-w-56 shrink-0 items-center border-r border-[var(--border-color)] ${active ? 'bg-[var(--bg-secondary)]' : 'hover:bg-[var(--bg-hover)]'}`}
                  >
                    <button onClick={() => selectTab(path)} title={path} className={`flex min-w-0 items-center gap-2 pl-3 pr-2 py-2 text-xs ${active ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>
                      <Icon size={13} className="shrink-0" />
                      <span className="truncate">{path.split('/').pop()}</span>
                      {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" title={t('pv.unsaved')} />}
                    </button>
                    <button onClick={() => closeTab(path)} className="mr-1 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-active)] hover:text-[var(--text-primary)]" title={t('pv.closeTab')}>
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Path + meta + Save — slim row, height matches the breadcrumb (h-8) */}
            <div className="flex h-8 shrink-0 items-center justify-between gap-3 px-3 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]">
              <div className="flex items-center gap-2 min-w-0">
                {selectedEntry && (
                  (() => {
                    const kind: FileKind = selectedEntry.type ?? 'file';
                    const Icon = KIND_ICON[kind] ?? FileText;
                    return <Icon size={13} className="text-[var(--accent)] shrink-0" />;
                  })()
                )}
                <span className="text-xs text-[var(--text-secondary)] truncate">{selectedFile}</span>
                {selectedEntry && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-active)] text-[var(--text-muted)] shrink-0">
                    {selectedEntry.type && t(`kind.${selectedEntry.type}`)}
                    {(selectedEntry.size ?? 0) > 0 && ` · ${formatSize(selectedEntry.size)}`}
                  </span>
                )}
              </div>
              {!isImage && (
                <div className="flex items-center gap-2 shrink-0">
                  {saveError && (
                    <span className="text-[11px] text-[var(--error)] max-w-[220px] truncate" title={saveError}>
                      {saveError}
                    </span>
                  )}
                  {isDirty && !saveError && (
                    <span className="flex items-center gap-1.5 text-[11px] text-[var(--accent)]" title={t('pv.unsaved')}>
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
                      unsaved
                    </span>
                  )}
                  {savedFlash && (
                    <span className="flex items-center gap-1 text-[11px] text-[var(--accent)]">
                      <Check size={12} /> Saved
                    </span>
                  )}
                  {selectedFile && /\.(html?|svg)$/i.test(selectedFile) && (
                    <button
                      onClick={async () => {
                        if (isDirty) await save();
                        window.dispatchEvent(new CustomEvent('otto:preview-file', { detail: { path: selectedFile } }));
                      }}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[var(--border-color)] text-xs text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--accent)] transition-colors"
                      title={t('prev.previewFile')}
                    >
                      <MonitorSmartphone size={12} /> {t('nav.preview')}
                    </button>
                  )}
                  <button
                    onClick={() => void save()}
                    disabled={!isDirty || saving}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--accent-glow)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-[var(--on-accent)] disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-[var(--accent-glow)] disabled:hover:text-[var(--accent)] transition-colors"
                    title={t('pv.save')}
                  >
                    {saving ? (
                      <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <Save size={12} />
                    )}
                    Save
                  </button>
                </div>
              )}
            </div>

            <div className="flex-1 overflow-auto p-4">
              {isImage ? (
                projectId ? (
                  <div className="flex flex-col items-center gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={fileRawUrl(projectId, selectedFile)}
                      alt={selectedFile}
                      className="max-w-full max-h-[70vh] rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)]"
                    />
                    <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                      <Info size={12} />
                      {extensionOf(selectedFile)} {t('pv.imageWord')} · {formatSize(selectedEntry?.size)}
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-[var(--text-muted)]">{t('pv.noProject')}</div>
                )
              ) : isFileLoading && fileContent === '' ? (
                <div className="text-sm text-[var(--text-muted)]">{t('common.loading')}</div>
              ) : error && fileContent === '' ? (
                <div className="text-sm text-[var(--error)]">{error}</div>
              ) : selectedEntry && (selectedEntry.type === 'binary' || selectedEntry.type === 'media') ? (
                <div className="text-sm text-[var(--text-muted)]">
                  {t('pv.binary')}
                  {(selectedEntry.size ?? 0) > 0 && ` · ${formatSize(selectedEntry.size)}`}.
                </div>
              ) : (
                <div className="-m-4 flex h-[calc(100%+2rem)] min-h-[65vh] overflow-hidden">
                  <CodeEditor
                    path={selectedFile}
                    value={editorContent}
                    gotoLine={gotoLine}
                    onChange={(value) => setDrafts((prev) => ({ ...prev, [selectedFile]: value }))}
                    definitionContext={projectId ? { projectId } : undefined}
                    onJumpToFile={(p, line) => void openFile({ path: p, name: p.split('/').pop() ?? p, is_dir: false, type: 'code', size: 0 }, line)}
                  />
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">
            <div className="text-center">
              <div className="flex justify-center mb-3 text-[var(--text-muted)]">
                <FolderOpen size={36} strokeWidth={1.5} />
              </div>
              <div className="text-sm">{t('pv.selectFile')}</div>
              <div className="text-xs mt-1 text-[var(--text-muted)] opacity-70">
                {t('pv.hints')}
              </div>
            </div>
          </div>
        )}
      </div>
      {gsearch && projectId && (
        <GlobalSearchModal
          projectId={projectId}
          mode={gsearch.mode}
          onClose={() => setGsearch(null)}
          onResults={onSearchResults}
          onOpenFile={(p, line) => void openFile({ path: p, name: p.split('/').pop() ?? p, is_dir: false, type: 'code', size: 0 }, line)}
        />
      )}
      {ctxMenu && (
        <ExplorerMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={ctxMenu.item ? (() => {
            const it = ctxMenu.item;
            return [
              ...(it.is_dir
                ? [
                    { label: t('pv.newFile'), icon: FilePlus2, run: () => { setCtxMenu(null); startCreate('file', it.path); } },
                    { label: t('pv.newFolder'), icon: FolderPlus, run: () => { setCtxMenu(null); startCreate('folder', it.path); } },
                  ]
                : [{ label: t('pv.open'), icon: FileText, run: () => { setCtxMenu(null); void openFile(it); } }]),
              { label: t('pv.rename'), hint: 'F2', icon: Pencil, run: () => startRename(it) },
              { label: t('pv.duplicate'), icon: CopyPlus, run: () => void duplicateEntry(it) },
              { label: t('pv.copyPath'), icon: Copy, run: () => copyPathOf(it) },
              { label: t('pv.delete'), hint: 'Del', icon: Trash2, danger: true, run: () => void deleteEntry(it) },
            ];
          })() : [
            { label: t('pv.newFileRoot'), icon: FilePlus2, run: () => { setCtxMenu(null); startCreate('file', ''); } },
            { label: t('pv.newFolderRoot'), icon: FolderPlus, run: () => { setCtxMenu(null); startCreate('folder', ''); } },
          ]}
        />
      )}
      {quickOpen && projectId && (
        <QuickOpenModal
          projectId={projectId}
          recent={openTabs}
          onClose={() => setQuickOpen(false)}
          onPick={(p, line) => {
            setQuickOpen(false);
            void openFile({ path: p, name: p.split('/').pop() ?? p, is_dir: false, type: 'code', size: 0 }, line);
          }}
        />
      )}
      {symOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/40" onMouseDown={() => setSymOpen(false)}>
          <div className="w-[560px] max-w-[90vw] rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-color)]">
              <Braces size={14} className="text-[var(--accent)] shrink-0" />
              <input
                ref={symInputRef}
                value={symQuery}
                onChange={(e) => { setSymQuery(e.target.value); setSymActive(0); }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setSymOpen(false);
                  else if (e.key === 'ArrowDown') { e.preventDefault(); setSymActive((a) => Math.min(a + 1, symResults.length - 1)); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setSymActive((a) => Math.max(a - 1, 0)); }
                  else if (e.key === 'Enter' && symResults[symActive]) openSymbol(symResults[symActive]);
                }}
                placeholder={t('sym.placeholder')}
                spellCheck={false}
                autoComplete="off"
                className="flex-1 min-w-0 bg-transparent text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
              />
              {symLoading && <Loader2 size={14} className="animate-spin text-[var(--text-muted)] shrink-0" />}
            </div>
            <div className="max-h-[320px] overflow-y-auto p-1">
              {!symQuery.trim() ? (
                <div className="px-3 py-4 text-xs text-[var(--text-muted)]">{t('sym.hint')}</div>
              ) : symResults.length === 0 && !symLoading ? (
                <div className="px-3 py-4 text-xs text-[var(--text-muted)]">{t('sym.noResults')}</div>
              ) : symResults.map((s, i) => (
                <button
                  key={`${s.path}:${s.line}:${s.name}`}
                  onClick={() => openSymbol(s)}
                  onMouseEnter={() => setSymActive(i)}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors ${i === symActive ? 'bg-[var(--accent-glow)]' : 'hover:bg-[var(--bg-hover)]'}`}
                >
                  <span className={`font-mono text-[10px] px-1 py-0.5 rounded shrink-0 ${
                    s.kind === 'class' ? 'bg-[var(--accent-glow)] text-[var(--accent)]'
                    : s.kind === 'method' ? 'bg-[var(--warning)]/15 text-[var(--warning)]'
                    : s.kind === 'interface' ? 'bg-violet-500/15 text-violet-400'
                    : 'bg-[var(--bg-active)] text-[var(--text-muted)]'
                  }`}>
                    {s.kind}
                  </span>
                  <span className="text-[13px] text-[var(--text-primary)] truncate">
                    {s.container ? `${s.container}.${s.name}` : s.name}
                  </span>
                  <span className="ml-auto font-mono text-[11px] text-[var(--text-muted)] shrink-0 truncate max-w-[220px]">
                    {s.path}:{s.line}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
