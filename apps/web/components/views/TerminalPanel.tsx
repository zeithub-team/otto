'use client';

import { ChevronUp, SquareTerminal } from 'lucide-react';
import type { UseTerminal } from '../../hooks/useTerminal';
import { useT } from '../../lib/i18n';

interface TerminalBarProps {
  term: UseTerminal;
  projectName: string | null;
  onExpand: () => void;
}

/**
 * Collapsed terminal strip docked above the chat form: one slim bar with the
 * session status and the expand button. The live hook keeps running while
 * collapsed, so output keeps buffering.
 */
export function TerminalBar({ term, projectName, onExpand }: TerminalBarProps) {
  const { t: tr } = useT();
  const total = term.sessions.length;
  const running = term.sessions.filter((s) => s.running);
  const status = total === 0
    ? tr('terminal.noSession')
    : `${(running[0] ?? term.sessions[0]).shell} • ● ${running.length}/${total}`;

  return (
    <button
      onClick={onExpand}
      title={tr('terminal.expand')}
      className="flex items-center gap-2 px-3 h-[30px] shrink-0 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] text-xs text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors"
    >
      <SquareTerminal size={13} className="text-[var(--accent)] shrink-0" />
      <span className="font-medium">{tr('nav.terminal')}</span>
      {projectName && (
        <span className="text-[var(--text-muted)] truncate max-w-[200px]">{projectName}</span>
      )}
      <span className="font-mono text-[11px] text-[var(--text-muted)] truncate">{status}</span>
      <span className="flex-1" />
      <span className="flex items-center gap-1 text-[var(--text-muted)]">
        {tr('terminal.expand')} <ChevronUp size={13} />
      </span>
    </button>
  );
}
