'use client';

import { useState } from 'react';
import {
  Check, Clipboard, FolderOpen, FolderPlus, HardDrive, X,
} from 'lucide-react';
import type { Project } from '../../types';
import { updateProject } from '../../lib/api';
import { FolderBrowser } from './FolderBrowser';
import { useT } from '../../lib/i18n';

interface EditProjectModalProps {
  project: Project;
  onClose: () => void;
  /** Called with the updated project after a successful save. */
  onSaved: (project: Project) => void;
}

export function EditProjectModal({ project, onClose, onSaved }: EditProjectModalProps) {
  const { t } = useT();
  const [name, setName] = useState(project.name);
  const [folder, setFolder] = useState(project.path);
  const [browsing, setBrowsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const canReveal = typeof window !== 'undefined' && !!window.ottoDesktop?.revealPath;
  const folderChanged = folder !== project.path;
  const nameChanged = name.trim() !== project.name;

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(folder);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(t('ep.copyFail'));
    }
  };

  const revealFolder = async () => {
    try {
      await window.ottoDesktop?.revealPath?.(folder);
    } catch {
      setError(t('ep.openFail'));
    }
  };

  const save = async () => {
    if (saving || !name.trim()) return;
    if (!folderChanged && !nameChanged) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await updateProject(project.id, {
        name: name.trim(),
        ...(folderChanged ? { folder } : {}),
      });
      onSaved(updated);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('ep.saveFail'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in">
      <div className="glass rounded-xl p-5 w-96 animate-fade-in glow">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('ep.title')}</h3>
          <button
            onClick={onClose}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            title={t('common.close')}
          >
            <X size={15} />
          </button>
        </div>

        {!browsing ? (
          <>
            <label className="block text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-1.5">
              {t('common.name')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              placeholder={t('sb.projectName')}
              className="w-full px-3 py-2.5 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
              autoFocus
            />

            <label className="block text-[10px] uppercase tracking-widest text-[var(--text-muted)] mt-4 mb-1.5">
              {t('common.folder')}
            </label>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-color)]">
              <HardDrive size={13} className="text-[var(--accent)] shrink-0" />
              <span className="truncate text-xs text-[var(--text-primary)] font-mono" title={folder}>
                {folder}
              </span>
            </div>

            <div className="flex gap-2 mt-2">
              <button
                onClick={() => setBrowsing(true)}
                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-dashed border-[var(--border-color)] text-xs text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
              >
                <FolderPlus size={13} />
                {t('ep.change')}
              </button>
              <button
                onClick={copyPath}
                className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-[var(--border-color)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent)]/40 transition-colors"
                title={t('ep.copy')}
              >
                {copied ? <Check size={13} className="text-[var(--accent)]" /> : <Clipboard size={13} />}
                {copied ? t('ep.copied') : t('ep.copy')}
              </button>
              {canReveal && (
                <button
                  onClick={revealFolder}
                  className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-[var(--border-color)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent)]/40 transition-colors"
                  title={t('ep.reveal')}
                >
                  <FolderOpen size={13} />
                  {t('common.open')}
                </button>
              )}
            </div>

            <div className="mt-1.5 text-[10px] text-[var(--text-muted)]">
              {t('ep.rebind')}
            </div>

            {error && <div className="mt-2 text-xs text-[var(--error)]">{error}</div>}

            <div className="flex gap-2 mt-4">
              <button
                onClick={save}
                disabled={saving || !name.trim()}
                className="flex-1 px-3 py-2 rounded-lg bg-[var(--accent)] text-[var(--on-accent)] text-sm font-semibold hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
              >
                {saving ? (
                  <span className="w-3.5 h-3.5 border-2 border-[var(--on-accent)] border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Check size={14} />
                )}
                {t('common.save')}
              </button>
              <button
                onClick={onClose}
                className="flex-1 px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-secondary)] text-sm hover:bg-[var(--bg-hover)] transition-colors"
              >
                {t('common.cancel')}
              </button>
            </div>
          </>
        ) : (
          <FolderBrowser
            onSelect={(path) => {
              setFolder(path);
              setBrowsing(false);
            }}
            onCancel={() => setBrowsing(false)}
          />
        )}
      </div>
    </div>
  );
}
