'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown, Eraser, Play, Plus, RotateCcw, Square, TerminalSquare, X, Zap,
} from 'lucide-react';
import type { Project } from '../../types';
import type { UseTerminal } from '../../hooks/useTerminal';
import { useT } from '../../lib/i18n';
import { useCommandHistory } from '../../lib/cmdHistory';

interface TerminalViewProps {
  project: Project | null;
  term: UseTerminal;
  onCollapse: () => void;
}

export function TerminalView({ project, term, onCollapse }: TerminalViewProps) {
  const { t: tr } = useT();
  const {
    sessions, activeId, setActiveId, lines, connected, starting, lastError, quick,
    send, start, stop, interrupt, clear, addQuick, removeQuick, refresh,
  } = term;
  const [input, setInput] = useState('');
  const hist = useCommandHistory(`otto-term-history:${project?.id ?? 0}`);
  const [stick, setStick] = useState(true);
  const outRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  const activeLines = activeId ? (lines[activeId] ?? []) : [];

  // First mount: re-sync with the server (it may have restarted), then boot
  // one session so the terminal is ready.
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!project || sessions.length > 0 || starting) return;
    void start();
  }, [project, sessions.length, starting, start]);

  // Stick to bottom while the user doesn't scroll up.
  useEffect(() => {
    const el = outRef.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [activeLines.length, activeId, stick]);

  const onScroll = () => {
    const el = outRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };

  const submit = (raw: string) => {
    const cmd = raw.replace(/\s+$/, '');
    if (!cmd) return;
    // Built-in screen clear: a piped shell can't clear the screen itself
    // (PowerShell's Clear-Host is a no-op without a console), so handle it
    // client-side instead of sending it to the session.
    if (/^(clear|cls)$/i.test(cmd.trim())) {
      if (activeId) clear(activeId);
      hist.reset();
      setInput('');
      return;
    }
    if (!active || !active.running) {
      void start();
      return;
    }
    if (send(cmd)) {
      hist.add(cmd);
      setInput('');
      setStick(true);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      submit(input);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const text = hist.older(input);
      if (text !== null) setInput(text);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const text = hist.newer();
      if (text !== null) setInput(text);
    }
  };

  const restart = async (id: string) => {
    await stop(id);
    await start();
  };

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-muted)] text-sm">
        {tr('terminal.noProject')}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      {/* session tabs + actions */}
      <div className="flex items-center gap-1 px-3 pt-2 pb-1 border-b border-[var(--border-color)]">
        <TerminalSquare size={15} className="text-[var(--accent)] shrink-0" />
        <div className="flex items-center gap-1 overflow-x-auto flex-1 min-w-0">
          {sessions.map((s, i) => (
            <div
              key={s.id}
              className={`flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-md text-xs whitespace-nowrap border cursor-pointer transition-colors ${
                s.id === activeId
                  ? 'border-[var(--accent)]/40 bg-[var(--accent-glow)] text-[var(--accent)]'
                  : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              }`}
              onClick={() => setActiveId(s.id)}
              title={s.id}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.running ? 'bg-[var(--accent)]' : 'bg-[var(--text-muted)]'}`} />
              {s.shell} {i + 1}
              <button
                className="p-0.5 rounded hover:bg-[var(--bg-hover)] opacity-60 hover:opacity-100"
                title={tr('terminal.stop')}
                onClick={(e) => { e.stopPropagation(); void stop(s.id); }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button
            onClick={() => void start()}
            disabled={starting}
            className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-40"
            title={tr('terminal.new')}
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {active && (
            <>
              <button
                onClick={interrupt}
                disabled={!active.running}
                className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--error)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-30"
                title={tr('terminal.interrupt')}
              >
                <Zap size={14} />
              </button>
              <button
                onClick={() => activeId && restart(activeId)}
                className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors"
                title={tr('terminal.restart')}
              >
                <RotateCcw size={14} />
              </button>
              <button
                onClick={() => activeId && clear(activeId)}
                className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors"
                title={tr('terminal.clear')}
              >
                <Eraser size={14} />
              </button>
            </>
          )}
          <button
            onClick={onCollapse}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors"
            title={tr('terminal.collapse')}
          >
            <ChevronDown size={13} /> {tr('terminal.collapse')}
          </button>
        </div>
      </div>

      {/* quick commands */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-[var(--border-color)] overflow-x-auto">
        <span className="text-[11px] text-[var(--text-muted)] whitespace-nowrap">{tr('terminal.quick')}:</span>
        {quick.map((cmd) => (
          <button
            key={cmd}
            onClick={() => submit(cmd)}
            onContextMenu={(e) => { e.preventDefault(); removeQuick(cmd); }}
            title={`${cmd} (${tr('terminal.quickHint')})`}
            className="px-2 py-0.5 rounded-md text-[11px] font-mono whitespace-nowrap bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] border border-[var(--border-color)] transition-colors"
          >
            {cmd}
          </button>
        ))}
        <button
          onClick={() => input.trim() && addQuick(input)}
          disabled={!input.trim()}
          className="px-2 py-0.5 rounded-md text-[11px] whitespace-nowrap text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors disabled:opacity-30"
          title={tr('terminal.quickAdd')}
        >
          + {tr('common.add')}
        </button>
      </div>

      {/* output */}
      <div
        ref={outRef}
        onScroll={onScroll}
        onClick={() => inputRef.current?.focus()}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[13px] leading-[1.45] bg-[var(--bg-primary)] cursor-text"
      >
        {activeLines.length === 0 && (
          <div className="text-[var(--text-muted)]">
            {starting ? tr('terminal.starting') : connected ? `${active?.shell ?? ''} — ${project.name}` : tr('terminal.starting')}
          </div>
        )}
        {lastError && activeLines.length === 0 && (
          <div className="text-[var(--error)]">— {lastError} —</div>
        )}
        {activeLines.map((l) => (
          <div
            key={l.id}
            className={
              l.kind === 'in'
                ? 'text-[var(--accent)] whitespace-pre-wrap break-all'
                : l.kind === 'sys'
                  ? 'text-[var(--text-muted)] italic whitespace-pre-wrap break-all'
                  : 'text-[var(--text-primary)] whitespace-pre-wrap break-all'
            }
          >
            {l.text}
          </div>
        ))}
      </div>

      {/* input */}
      <div className="px-3 py-2 border-t border-[var(--border-color)] bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-2">
          <span className="text-[var(--accent)] font-mono text-sm select-none">❯</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={active?.running === false ? tr('terminal.exited') : tr('terminal.inputPh')}
            disabled={!active || !active.running}
            spellCheck={false}
            autoComplete="off"
            className="flex-1 bg-transparent font-mono text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none disabled:opacity-50"
          />
          <button
            onClick={() => submit(input)}
            disabled={!input.trim() || !active?.running}
            className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-30"
            title={tr('terminal.run')}
          >
            <Play size={14} />
          </button>
          {(!active || active.running === false) && (
            <button
              onClick={() => (active && active.running === false ? restart(active.id) : start())}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs bg-[var(--accent-glow)] text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors"
            >
              <Square size={11} className="rotate-90" /> {tr('terminal.start')}
            </button>
          )}
        </div>
        <div className="mt-1 text-[11px] text-[var(--text-muted)] font-mono">
          {active ? `${active.shell} • ${active.running ? (connected ? '● live' : '…') : tr('terminal.exitedShort')} • ${project.name}` : tr('terminal.noSession')}
        </div>
      </div>
    </div>
  );
}
