'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, Bug, Wrench, FlaskConical, Copy, Check, ThumbsUp, ThumbsDown, RefreshCw, Loader2, ChevronRight, MonitorSmartphone, FileText } from 'lucide-react';
import { humanSize, splitAttachments } from '../../lib/attachments';
import type { RunSummary } from '../../hooks/useChat';
import { Logo, LogoMark } from '../brand/Logo';
import type { ChatMessage } from '../../types';
import { SubscriptionAuth } from './ClaudeCliAuth';
import { ApprovalCard } from './ApprovalCard';
import { useT } from '../../lib/i18n';
import { ChangesCard, RunStatus, ThinkingBlock, parseChanges } from './RunBlocks';

interface ChatViewProps {
  messages: ChatMessage[];
  isProcessing: boolean;
  onSelectSuggestion?: (prompt: string) => void;
  onRegenerate?: (assistantMsgId: string) => void;
  /** Clock and generated tokens of the current run (live status). */
  runStats?: { startedAt: number; tokens: number } | null;
  /** How the last run ended (shown under the messages when nothing is running). */
  lastRun?: RunSummary | null;
}

const ACTIVITY_VERBS: Record<string, string> = {
  read_file: 'act.reading',
  read_files: 'act.reading',
  write_file: 'act.writing', append_file: 'act.writing', delete_file: 'act.deleting', web_search: 'act.web', fetch_url: 'act.page', plan_task: 'act.planning', create_task: 'act.planning',
  list_files: 'act.listing',
  run_command: 'act.running',
  search_files: 'act.searching',
};

/** Human-readable activity line, e.g. "Reading src/app.tsx". */
function activityLabel(msg: ChatMessage, t: (key: string) => string): string {
  const verb = t(ACTIVITY_VERBS[msg.tool ?? ''] ?? (msg.event === 'tool_end' ? 'act.done' : 'act.working'));
  const paths = (msg.paths ?? []).filter((p) => typeof p === 'string' && p.length > 0);
  if (paths.length > 0) return `${verb} ${paths.join(', ')}`;
  if (msg.tool === 'search_files') return `${verb} ${t('act.files')}`;
  if (msg.tool) return `${verb} ${t('act.project')}`;
  return verb;
}

/** Local like/dislike state, persisted per message id. */
const FEEDBACK_KEY = 'otto-feedback';

const SUGGESTIONS = [
  { title: 'chat.sug.arch.title', prompt: 'chat.sug.arch.prompt', icon: Search },
  { title: 'chat.sug.bugs.title', prompt: 'chat.sug.bugs.prompt', icon: Bug },
  { title: 'chat.sug.refactor.title', prompt: 'chat.sug.refactor.prompt', icon: Wrench },
  { title: 'chat.sug.tests.title', prompt: 'chat.sug.tests.prompt', icon: FlaskConical },
];

function renderMarkdown(text: string): JSX.Element[] {
  const lines = text.split('\n');
  const elements: JSX.Element[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  let codeLang = '';
  let inList = false;
  let listItems: string[] = [];

  const flushList = (key: string) => {
    if (listItems.length > 0) {
      elements.push(
        <ul key={`${key}-list`} className="my-2 pl-5 space-y-1">
          {listItems.map((item, i) => (
            <li key={i} className="text-[var(--text-secondary)] leading-relaxed">{renderInline(item)}</li>
          ))}
        </ul>
      );
      listItems = [];
      inList = false;
    }
  };

  const flushCode = (key: string) => {
    if (codeLines.length > 0) {
      elements.push(
        <div key={`${key}-code`} className="my-2 rounded-lg overflow-hidden border border-[var(--border-color)]">
          {codeLang && (
            <div className="px-3 py-1 bg-[var(--bg-tertiary)] border-b border-[var(--border-color)] text-[10px] text-[var(--text-muted)] font-mono">
              {codeLang}
            </div>
          )}
          <pre className="p-3 bg-[var(--bg-primary)] overflow-x-auto">
            <code className="text-xs font-mono text-[var(--text-secondary)] leading-relaxed">
              {codeLines.join('\n')}
            </code>
          </pre>
        </div>
      );
      codeLines = [];
      inCode = false;
      codeLang = '';
    }
  };

  lines.forEach((line, i) => {
    // Code block start/end
    if (line.startsWith('```')) {
      if (inCode) {
        flushCode(`code-${i}`);
      } else {
        inCode = true;
        codeLang = line.slice(3).trim();
      }
      return;
    }
    if (inCode) {
      codeLines.push(line);
      return;
    }

    // List items
    const listMatch = line.match(/^[-*]\s+(.+)/) || line.match(/^\d+\.\s+(.+)/);
    if (listMatch) {
      if (!inList) inList = true;
      listItems.push(listMatch[1]);
      return;
    } else {
      flushList(`list-${i}`);
    }

    // Headers
    const headerMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const size = level === 1 ? 'text-lg' : level === 2 ? 'text-base' : 'text-sm';
      elements.push(
        <div key={`h-${i}`} className={`${size} font-semibold text-[var(--text-primary)] mt-3 mb-1`}>
          {renderInline(headerMatch[2])}
        </div>
      );
      return;
    }

    // Empty line
    if (line.trim() === '') {
      if (i < lines.length - 1) {
        elements.push(<div key={`sp-${i}`} className="h-2" />);
      }
      return;
    }

    // Regular paragraph
    elements.push(
      <div key={`p-${i}`} className="text-[var(--text-secondary)] leading-relaxed my-0.5">
        {renderInline(line)}
      </div>
    );
  });

  flushCode('final-code');
  flushList('final-list');
  return elements;
}

function renderInline(text: string): JSX.Element[] {
  // Handle `inline code`
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--accent)] text-xs font-mono">
          {part.slice(1, -1)}
        </code>
      );
    }
    // Handle **bold**
    const boldParts = part.split(/(\*\*[^*]+\*\*)/g);
    return (
      <span key={i}>
        {boldParts.map((bp, j) => {
          if (bp.startsWith('**') && bp.endsWith('**')) {
            return <strong key={j} className="font-semibold text-[var(--text-primary)]">{bp.slice(2, -2)}</strong>;
          }
          return <span key={j}>{bp}</span>;
        })}
      </span>
    );
  });
}

/** A user message: its text, and every attached file as a collapsed card (JSON / HTML are not dumped into the chat). */
function UserText({ content }: { content: string }) {
  const { t } = useT();
  const [open, setOpen] = useState<number | null>(null);
  const { text, files } = splitAttachments(content);
  return (
    <>
      {text.trim() && <div className="text-sm whitespace-pre-wrap leading-relaxed">{text}</div>}
      {files.length > 0 && (
        <div className={`space-y-1.5 ${text.trim() ? 'mt-2' : ''}`}>
          {files.map((f, i) => (
            <div key={`${f.name}-${i}`} className="overflow-hidden rounded-lg text-xs" style={{ background: 'color-mix(in srgb, black 20%, transparent)' }}>
              <button
                type="button"
                onClick={() => setOpen(open === i ? null : i)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
                aria-expanded={open === i}
              >
                <FileText size={13} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                <span className="shrink-0 opacity-80">{t('chat.fileInfo', { lines: f.lines, size: humanSize(f.chars) })}</span>
                <ChevronRight size={13} className={`shrink-0 transition-transform ${open === i ? 'rotate-90' : ''}`} />
              </button>
              {open === i && (
                <pre className="max-h-64 overflow-auto whitespace-pre border-t px-2.5 py-2 font-mono text-[11px] leading-snug" style={{ borderColor: 'color-mix(in srgb, currentColor 20%, transparent)' }}>
                  {f.body.length > 20000 ? `${f.body.slice(0, 20000)}\n…` : f.body}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function ChatView({ messages, isProcessing, onSelectSuggestion, onRegenerate, runStats, lastRun }: ChatViewProps) {
  const { t } = useT();
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [openRuns, setOpenRuns] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<Record<string, 'up' | 'down'>>({});

  // Restore like/dislike state
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(FEEDBACK_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') setFeedback(parsed);
      }
    } catch { /* ignore */ }
  }, []);

  const copyMessage = (msg: ChatMessage) => {
    if (!msg.content) return;
    navigator.clipboard?.writeText(parseChanges(msg.content).text)
      .then(() => {
        setCopiedId(msg.id);
        setTimeout(() => setCopiedId((cur) => (cur === msg.id ? null : cur)), 1500);
      })
      .catch(() => { /* clipboard denied */ });
  };

  const toggleFeedback = (msgId: string, dir: 'up' | 'down') => {
    setFeedback((prev) => {
      const next = { ...prev };
      if (next[msgId] === dir) delete next[msgId];
      else next[msgId] = dir;
      try {
        window.localStorage.setItem(FEEDBACK_KEY, JSON.stringify(next));
      } catch { /* ignore */ }
      return next;
    });
  };

  const actionBtn =
    'p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--text-muted)]';

  const renderActions = (msg: ChatMessage) => {
    const isUser = msg.role === 'user';
    const isAssistant = msg.role === 'assistant' && !msg.isError;
    // "the model pasted code instead of writing the file" is a failure too: nothing was applied
    const notApplied = msg.role === 'assistant' && !msg.isStreaming && /файлы НЕ изменены/.test(msg.content || '');
    if (msg.action === 'claude_cli_login' || msg.action === 'codex_cli_login') {
      return (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <SubscriptionAuth kind={msg.action === 'codex_cli_login' ? 'codex' : 'claude'} compact />
          {onRegenerate && (
            <button onClick={() => onRegenerate(msg.id)} disabled={isProcessing} className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-[var(--border-color)] px-2.5 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40">
              <RefreshCw size={12} /> {t('chat.retry')}
            </button>
          )}
        </div>
      );
    }
    if ((msg.isError || notApplied) && onRegenerate) {
      return (
        <div className="mt-1.5">
          <button
            onClick={() => onRegenerate(msg.id)}
            disabled={isProcessing}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-color)] px-2.5 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-40"
          >
            <RefreshCw size={12} /> {t('chat.retry')}
          </button>
        </div>
      );
    }
    if (!isUser && !isAssistant) return null;
    if (msg.isStreaming) return null;
    if (!msg.content) return null;

    return (
      <div
        className={`flex items-center gap-0.5 mt-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity ${
          isUser ? 'justify-end' : ''
        }`}
      >
        <button
          onClick={() => copyMessage(msg)}
          className={actionBtn}
          title={copiedId === msg.id ? 'Copied' : 'Copy'}
          aria-label={t('chat.copy')}
        >
          {copiedId === msg.id ? <Check size={13} className="text-[var(--accent)]" /> : <Copy size={13} />}
        </button>

        {isUser && onRegenerate && (
          <button
            onClick={() => onRegenerate(msg.id)}
            className={actionBtn}
            title={t('chat.retry')}
            aria-label={t('chat.retry')}
            disabled={isProcessing}
          >
            <RefreshCw size={13} />
          </button>
        )}

        {isAssistant && (
          <>
            <button
              onClick={() => toggleFeedback(msg.id, 'up')}
              className={`${actionBtn} ${feedback[msg.id] === 'up' ? 'text-[var(--accent)]' : ''}`}
              title={t('chat.good')}
              aria-label={t('chat.good')}
            >
              <ThumbsUp size={13} />
            </button>
            <button
              onClick={() => toggleFeedback(msg.id, 'down')}
              className={`${actionBtn} ${feedback[msg.id] === 'down' ? 'text-[var(--error)]' : ''}`}
              title={t('chat.bad')}
              aria-label={t('chat.bad')}
            >
              <ThumbsDown size={13} />
            </button>
            {onRegenerate && (
              <button
                onClick={() => onRegenerate(msg.id)}
                className={actionBtn}
                title={t('chat.regen')}
                aria-label={t('chat.regen')}
                disabled={isProcessing}
              >
                <RefreshCw size={13} />
              </button>
            )}
          </>
        )}
      </div>
    );
  };

  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, autoScroll]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setAutoScroll(atBottom);
  };

  return (
    <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
      {messages.length === 0 ? (
        <div className="flex flex-col items-center justify-center min-h-full p-8">
          <div className="mb-6"><Logo variant="hero" /></div>
          <h2 className="text-2xl font-semibold mb-2 text-[var(--text-primary)] text-glow">
            {t('chat.heroTitle')}
          </h2>
          <p className="text-[var(--text-muted)] mb-8 text-sm max-w-md text-center">
            {t('chat.heroText')}
          </p>
          <div className="grid grid-cols-2 gap-3 max-w-lg w-full">
            {SUGGESTIONS.map((s) => (
              <button
                key={s.title}
                onClick={() => onSelectSuggestion?.(t(s.prompt))}
                className="p-4 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] hover:border-[var(--accent)] hover:bg-[var(--accent-glow)] transition-all text-left group"
              >
                <div className="text-sm font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
                  {t(s.title)}
                </div>
                <div className="text-xs text-[var(--text-muted)] mt-1 line-clamp-2">
                  {t(s.prompt)}
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="p-4 space-y-4">
          {messages
            .filter((msg) =>
              msg.role === 'activity'
              || msg.role === 'user'
              || Boolean(msg.content?.replace(/[\s\u200B-\u200D\uFEFF\u2060]/g, ''))
              || Boolean(msg.images?.length)
            )
            // consecutive tool-activity rows collapse into ONE live line (the
            // latest step) with a step counter, instead of a growing checklist
            .reduce<Array<{ msg: ChatMessage; steps: number; run: ChatMessage[] }>>((acc, msg) => {
              const prev = acc[acc.length - 1];
              if (msg.role === 'activity' && prev && prev.msg.role === 'activity') {
                acc[acc.length - 1] = { msg, steps: prev.steps + 1, run: [...prev.run, msg] };
              } else {
                acc.push({ msg, steps: 1, run: [msg] });
              }
              return acc;
            }, [])
            .map(({ msg, steps, run }) => {
              if (msg.role === 'thinking') {
                return <ThinkingBlock key={msg.id} content={msg.content} streaming={Boolean(msg.isStreaming)} />;
              }
              if (msg.role === 'approval') {
                return <ApprovalCard key={msg.id} msg={msg} />;
              }
              if (msg.role === 'activity') {
                const runKey = run[0].id;
                const open = Boolean(openRuns[runKey]);
                // tool activity marker: "Reading src/app.tsx" with a spinner,
                // replaced in place by a check when the tool finishes
                return (
                  <div key={msg.id} className="pl-9 animate-fade-in">
                    <button
                      type="button"
                      onClick={() => steps > 1 && setOpenRuns((prev) => ({ ...prev, [runKey]: !open }))}
                      className={`flex w-full items-center gap-2 text-left text-xs text-[var(--text-muted)] ${steps > 1 ? 'hover:text-[var(--text-secondary)] cursor-pointer' : 'cursor-default'}`}
                      title={steps > 1 ? t('act.details') : msg.tool}
                      aria-expanded={steps > 1 ? open : undefined}
                    >
                      {msg.event === 'tool_end' ? (
                        <Check size={13} className="shrink-0 text-[var(--accent)]" />
                      ) : (
                        <Loader2 size={13} className="shrink-0 animate-spin" />
                      )}
                      <span className="truncate">{activityLabel(msg, t)}</span>
                      {steps > 1 && (
                        <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--bg-tertiary)] px-1.5 text-[10px] tabular-nums">
                          {steps}
                          <ChevronRight size={10} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
                        </span>
                      )}
                    </button>
                    {(() => {
                      const file = [...run].reverse().flatMap((step) => step.paths ?? []).find((p) => /\.(html?|svg)$/i.test(p));
                      return file ? (
                        <button
                          type="button"
                          onClick={() => window.dispatchEvent(new CustomEvent('otto:preview-file', { detail: { path: file } }))}
                          className="mt-1 ml-5 inline-flex items-center gap-1 rounded-md border border-[var(--border-color)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--accent)] transition-colors"
                          title={t('prev.previewFile')}
                        >
                          <MonitorSmartphone size={11} /> {t('nav.preview')} · {file.split('/').pop()}
                        </button>
                      ) : null;
                    })()}
                    {open && (
                      <ol className="mt-1 ml-1.5 max-h-56 space-y-0.5 overflow-y-auto border-l border-[var(--border-color)] pl-3 text-[11px] text-[var(--text-muted)]">
                        {run.map((step, i) => (
                          <li key={`${step.id}-${i}`} className="flex items-baseline gap-2">
                            <span className="w-5 shrink-0 text-right tabular-nums opacity-60">{i + 1}</span>
                            <span className="truncate">{activityLabel(step, t)}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                );
              }
              return (
            <div
              key={msg.id}
              className={`group flex animate-fade-in ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {/* Avatar */}
              {msg.role !== 'user' && (
                <div className="shrink-0 w-7 h-7 rounded-lg bg-[var(--accent-glow)] border border-[var(--accent)]/30 flex items-center justify-center mr-2 mt-0.5">
                  <LogoMark size={15} />
                </div>
              )}

              <div className="max-w-[85%] min-w-0 flex flex-col">
                <div
                  className={`rounded-xl px-4 py-3 ${
                    msg.role === 'user'
                      ? 'bg-[var(--accent)] text-[var(--on-accent)] rounded-br-md'
                      : msg.isError
                      ? 'bg-[var(--error)]/10 border border-[var(--error)]/30 text-[var(--error)] rounded-bl-md'
                      : 'bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-primary)] rounded-bl-md'
                  }`}
                >
                  {msg.role === 'user' ? (
                    <UserText content={msg.content} />
                  ) : (
                    <div className="text-sm space-y-0.5">
                      {renderMarkdown(parseChanges(msg.content || '').text)}
                    </div>
                  )}
                  {msg.role === 'assistant' && (() => {
                    const { files } = parseChanges(msg.content || '');
                    return files.length > 0 ? (
                      <ChangesCard files={files} onPreview={(file) => window.dispatchEvent(new CustomEvent('otto:preview-file', { detail: { path: file } }))} />
                    ) : null;
                  })()}
                  {/* Attached images */}
                  {msg.images && msg.images.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {msg.images.map((b64, i) => {
                        // detect real format from base64 signature
                        let mime = 'image/png';
                        if (b64.startsWith('/9j/')) mime = 'image/jpeg';
                        else if (b64.startsWith('UklGR')) mime = 'image/webp';
                        else if (b64.startsWith('R0lGOD')) mime = 'image/gif';
                        return (
                        <img
                          key={i}
                          src={`data:${mime};base64,${b64}`}
                          alt=""
                          className="max-w-[240px] max-h-[180px] rounded-lg border border-[var(--border-color)] object-contain cursor-pointer hover:opacity-80 transition-opacity"
                          onClick={() => window.open(`data:${mime};base64,${b64}`, '_blank')}
                        />
                        );
                      })}
                    </div>
                  )}
                  <div className="text-[10px] opacity-50 mt-2">
                    {new Date(msg.timestamp).toLocaleTimeString()}
                  </div>
                </div>
                {renderActions(msg)}
              </div>
            </div>
              );
            })}

          {isProcessing && runStats && (() => {
            const last = messages[messages.length - 1];
            const lastActivity = [...messages].reverse().find((m) => m.role === 'activity');
            const working = last?.role === 'activity' && last.event === 'tool_start';
            const phase = last?.role === 'thinking' && last.isStreaming
              ? t('run.thinking')
              : last?.role === 'assistant' && last.isStreaming
              ? t('run.writing')
              : working
              ? t('run.tools')
              : t('run.working');
            const title = lastActivity && (working || last?.role === 'activity') ? activityLabel(lastActivity, t) : phase;
            return <RunStatus startedAt={runStats.startedAt} tokens={runStats.tokens} title={title} phase={phase} />;
          })()}
          {!isProcessing && lastRun && messages.some((m) => m.role === 'assistant' || m.role === 'system') && (() => {
            const seconds = Math.max(1, Math.round(lastRun.ms / 1000));
            const time = seconds >= 60 ? `${Math.floor(seconds / 60)} ${t('run.min')} ${seconds % 60} ${t('run.sec')}` : `${seconds} ${t('run.sec')}`;
            const tone = lastRun.outcome === 'done' ? 'text-[var(--success)] border-[var(--success)]/30' : lastRun.outcome === 'error' ? 'text-[var(--error)] border-[var(--error)]/30' : 'text-[var(--warning)] border-[var(--warning)]/30';
            const icon = lastRun.outcome === 'done' ? '✓' : lastRun.outcome === 'stopped' ? '■' : '⚠';
            return (
              <div className={`mx-auto mt-3 flex w-fit max-w-full items-center gap-2 rounded-full border px-3 py-1 text-[11px] ${tone}`} role="status">
                <span>{icon}</span>
                <span>{t(`run.end.${lastRun.outcome}`)}</span>
                <span className="text-[var(--text-muted)]">· {time}{lastRun.tokens > 0 ? ` · ${lastRun.tokens.toLocaleString()} ${t('run.tokens')}` : ''}</span>
              </div>
            );
          })()}
          <div ref={bottomRef} className="h-1" />
        </div>
      )}
    </div>
  );
}
