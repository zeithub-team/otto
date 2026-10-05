'use client';

import { useState } from 'react';
import type { ContextItem } from '../../types';
import { Folder, FileText } from 'lucide-react';
import { useT } from '../../lib/i18n';

interface ContextViewProps {
  contextItems: ContextItem[];
  onRemoveContextItem: (path: string) => void;
  onAddContextItem: (path: string, type: 'file' | 'folder') => void;
}

export function ContextView({
  contextItems,
  onRemoveContextItem,
  onAddContextItem,
}: ContextViewProps) {
  const { t } = useT();
  const [isAdding, setIsAdding] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [newType, setNewType] = useState<'file' | 'folder'>('file');

  const handleAdd = () => {
    if (newPath.trim()) {
      onAddContextItem(newPath.trim(), newType);
      setNewPath('');
      setIsAdding(false);
    }
  };

  const totalTokens = contextItems.reduce((sum, item) => sum + (item.tokens || 0), 0);
  const maxTokens = 128000;
  const usagePercent = Math.round((totalTokens / maxTokens) * 100);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto">
        <h2 className="text-2xl font-semibold mb-2 text-[var(--text-primary)]">
          {t('ctx.title')}
        </h2>
        <p className="text-sm text-[var(--text-muted)] mb-6">
          {t('ctx.subtitle')}
        </p>

        {/* Context Usage */}
        <div className="mb-6 p-4 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-[var(--text-secondary)]">{t('ctx.usage')}</span>
            <span className="text-sm font-medium text-[var(--accent)]">{usagePercent}%</span>
          </div>
          <div className="w-full h-2 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-all"
              style={{ width: `${Math.min(usagePercent, 100)}%` }}
            />
          </div>
          <div className="text-xs text-[var(--text-muted)] mt-1">
            ~{totalTokens.toLocaleString()} / {maxTokens.toLocaleString()} tokens
          </div>
        </div>

        {/* Context Items */}
        <div className="space-y-2 mb-4">
          {contextItems.map((item) => (
            <div
              key={item.path}
              className="flex items-center justify-between p-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] group"
            >
              <div className="flex items-center gap-3">
                <span className="text-lg">
                  {item.type === 'folder' ? <Folder size={14} /> : <FileText size={14} />}
                </span>
                <div>
                  <div className="text-sm text-[var(--text-primary)]">{item.path}</div>
                  {item.tokens && (
                    <div className="text-xs text-[var(--text-muted)]">
                      ~{item.tokens.toLocaleString()} tokens
                    </div>
                  )}
                </div>
              </div>
              <button
                onClick={() => onRemoveContextItem(item.path)}
                className="opacity-0 group-hover:opacity-100 px-2 py-1 rounded text-xs text-[var(--error)] hover:bg-[var(--error)]/10 transition-opacity"
              >
                Remove
              </button>
            </div>
          ))}
        </div>

        {/* Add Button */}
        {isAdding ? (
          <div className="p-4 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] space-y-3">
            <input
              type="text"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              placeholder={t('ctx.path')}
              className="w-full px-3 py-2 rounded bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
              autoFocus
            />
            <div className="flex gap-2">
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value as 'file' | 'folder')}
                className="px-3 py-1.5 rounded bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-sm text-[var(--text-secondary)]"
              >
                <option value="file">{t('ctx.file')}</option>
                <option value="folder">{t('common.folder')}</option>
              </select>
              <button
                onClick={handleAdd}
                className="flex-1 px-3 py-1.5 rounded bg-[var(--accent)] text-[var(--on-accent)] text-sm font-medium hover:bg-[var(--accent-hover)]"
              >
                Add
              </button>
              <button
                onClick={() => setIsAdding(false)}
                className="flex-1 px-3 py-1.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] text-sm hover:bg-[var(--bg-hover)]"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setIsAdding(true)}
            className="w-full px-4 py-3 rounded-lg border border-dashed border-[var(--border-color)] text-sm text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
          >
            {t('ctx.add')}
          </button>
        )}
      </div>
    </div>
  );
}
