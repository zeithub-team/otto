'use client';

import { MessageSquare, FolderOpen, Boxes, Cpu, Settings as SettingsIcon, Folder, Clock } from 'lucide-react';
import type { Project, ViewType } from '../../types';
import { Logo } from '../brand/Logo';
import { useT } from '../../lib/i18n';

interface HomeViewProps {
  projects: Project[];
  selectedProject: Project | null;
  onSelectProject: (p: Project) => void;
  onViewChange: (v: ViewType) => void;
}

const QUICK: { view: ViewType; labelKey: string; icon: typeof MessageSquare; hintKey: string }[] = [
  { view: 'chat', labelKey: 'home.chat', icon: MessageSquare, hintKey: 'home.chatHint' },
  { view: 'project', labelKey: 'home.files', icon: FolderOpen, hintKey: 'home.filesHint' },
  { view: 'services', labelKey: 'home.services', icon: Boxes, hintKey: 'home.servicesHint' },
  { view: 'models', labelKey: 'home.models', icon: Cpu, hintKey: 'home.modelsHint' },
  { view: 'settings', labelKey: 'home.settings', icon: SettingsIcon, hintKey: 'home.settingsHint' },
];

export function HomeView({ projects, selectedProject, onSelectProject, onViewChange }: HomeViewProps) {
  const { t } = useT();
  const open = (p: Project) => { onSelectProject(p); onViewChange('chat'); };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-10">
        <div className="flex flex-col items-center text-center mb-10">
          <Logo variant="hero" />
          <p className="text-sm text-[var(--text-muted)] mt-3">{t('home.subtitle')}</p>
        </div>

        {/* Quick actions */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-10">
          {QUICK.map((q) => (
            <button
              key={q.view}
              onClick={() => onViewChange(q.view)}
              disabled={!selectedProject && q.view !== 'models' && q.view !== 'settings'}
              className="flex flex-col items-start gap-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 text-left hover:border-[var(--accent)]/40 hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={t(q.hintKey)}
            >
              <q.icon size={20} className="text-[var(--accent)]" />
              <span className="text-sm font-medium text-[var(--text-primary)]">{t(q.labelKey)}</span>
              <span className="text-[11px] text-[var(--text-muted)] leading-tight">{t(q.hintKey)}</span>
            </button>
          ))}
        </div>

        {/* Recent projects */}
        <div className="flex items-center gap-2 mb-3 text-[var(--text-muted)]">
          <Clock size={14} />
          <h2 className="text-xs uppercase tracking-wider">{t('home.recent')}</h2>
        </div>
        {projects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--border-color)] p-6 text-sm text-[var(--text-muted)] text-center">
            {t('home.noProjects')}
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {projects.slice(0, 9).map((p) => (
              <button
                key={p.id}
                onClick={() => open(p)}
                className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                  selectedProject?.id === p.id
                    ? 'border-[var(--accent)]/40 bg-[var(--accent-glow)]'
                    : 'border-[var(--border-color)] bg-[var(--bg-secondary)] hover:border-[var(--accent)]/40 hover:bg-[var(--bg-hover)]'
                }`}
              >
                <Folder size={18} className="text-[var(--accent)] shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm text-[var(--text-primary)] truncate">{p.name}</div>
                  <div className="text-[10px] text-[var(--text-muted)] font-mono truncate">{p.path}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
