'use client';

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, FolderOpen, HardDrive } from 'lucide-react';
import type { WorkspaceFolder } from '../../types';
import { fetchWorkspaceFolders } from '../../lib/api';
import { useT } from '../../lib/i18n';

interface FolderBrowserProps {
  /** Chosen folder path (absolute on disk, or legacy workspace-relative). */
  onSelect: (path: string) => void;
  /** User backed out without choosing. */
  onCancel: () => void;
}

/**
 * Parent of an opaque folder path; '' means "root level" (drives + workspace).
 * Handles both separators, since the backend returns OS-native paths now.
 */
function parentPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return ''; // e.g. "C:" — nothing above it but the drive list
  const parent = trimmed.slice(0, idx);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`; // C:\Users → C:\
  return parent;
}

/**
 * Folder picker used by the create-project and edit-project dialogs.
 * Root level shows the default workspace plus every existing drive (Windows);
 * any folder on disk can be bound to a project.
 */
export function FolderBrowser({ onSelect, onCancel }: FolderBrowserProps) {
  const { t } = useT();
  const [path, setPath] = useState('');
  const [folders, setFolders] = useState<WorkspaceFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchWorkspaceFolders(path)
      .then((items) => { if (!cancelled) setFolders(items); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t('fb.failed')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path, t]);

  return (
    <>
      <div className="flex items-center gap-1.5 mb-2">
        <button
          onClick={() => (path ? setPath(parentPath(path)) : onCancel())}
          className="p-1.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]"
          title={path ? t('fb.up') : t('fb.closeBrowser')}
        >
          <ChevronLeft size={14} />
        </button>
        <span className="text-[11px] font-mono text-[var(--text-muted)] truncate flex-1" title={path}>
          {path || 'Drives'}
        </span>
      </div>

      <div className="max-h-52 overflow-y-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-1">
        {loading ? (
          <div className="p-3 text-xs text-[var(--text-muted)]">{t('common.loading')}</div>
        ) : error ? (
          <div className="p-3 text-xs text-[var(--error)]">{error}</div>
        ) : folders.length === 0 ? (
          <div className="p-3 text-xs text-[var(--text-muted)]">{t('fb.empty')}</div>
        ) : (
          folders.map((folder) => (
            <button
              key={folder.path}
              onClick={() => setPath(folder.path)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
              title={folder.path}
            >
              {path === '' && /^[A-Za-z]:\\?$/.test(folder.path) ? (
                <HardDrive size={13} className="shrink-0 text-[var(--text-muted)]" />
              ) : (
                <FolderOpen size={13} className="shrink-0 text-[var(--accent)]" />
              )}
              <span className="truncate">{folder.name}</span>
              <ChevronRight size={12} className="ml-auto shrink-0 opacity-50" />
            </button>
          ))
        )}
      </div>

      <div className="flex gap-2 mt-3">
        <button
          onClick={() => onSelect(path)}
          disabled={!path}
          className="flex-1 px-3 py-2 rounded-lg bg-[var(--accent)] text-[var(--on-accent)] text-sm font-semibold hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {t('fb.select')}
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-secondary)] text-sm hover:bg-[var(--bg-hover)] transition-colors"
        >
          {t('common.back')}
        </button>
      </div>
    </>
  );
}
