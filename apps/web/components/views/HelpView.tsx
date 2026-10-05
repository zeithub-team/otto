'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  BookOpen, MessageSquare, FolderOpen, Boxes, Cpu, Route, Wrench, ListTodo, GitBranch, Keyboard, Cloud,
  Rocket, Sparkles, Gauge, ShieldCheck, LifeBuoy, Database, Server, KeyRound, Puzzle, Search, ChevronRight, Palette, Bot, MonitorSmartphone, FolderPlus, ArrowLeft, ArrowRight, Home, ExternalLink,
} from 'lucide-react';
import { useT, type Locale } from '../../lib/i18n';
import type { ViewType } from '../../types';
import type { HelpText } from './help/types';
import { openDocsWindow } from '../../lib/docsWindow';
import ru from './help/ru';
import en from './help/en';
import az from './help/az';
import ge from './help/ge';
import it from './help/it';
import sp from './help/sp';

const ICONS: Record<string, typeof BookOpen> = {
  start: Rocket, chat: MessageSquare, tools: Wrench, skills: Sparkles, tasks: ListTodo, context: Gauge,
  cloud: Cloud, files: FolderOpen, preview: MonitorSmartphone, projects: FolderPlus, services: Boxes, models: Cpu, git: GitBranch, look: Palette,
  keys: Keyboard, privacy: ShieldCheck, faq: LifeBuoy, data: Database, ssh: Server, subscriptions: KeyRound, plugins: Puzzle,
};

function SectionIcon({ id, size, className }: { id: string; size: number; className?: string }) {
  const Icon = ICONS[id] ?? BookOpen;
  return <Icon size={size} className={className} />;
}

/** Every UI language has its own documentation text; English is the fallback. */
const TEXT: Record<Locale, HelpText> = { ru, en, az, ge, it, sp };

/** `code`, **bold** and [label](view:xxx) → React nodes. */
function inline(text: string, go: (view: ViewType) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(view:(\w+)\)/g;
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (m[1] !== undefined) {
      out.push(
        <code key={key++} className="rounded bg-[var(--bg-tertiary)] px-1 py-px font-mono text-[11px] text-[var(--accent)]">
          {m[1]}
        </code>,
      );
    } else if (m[2] !== undefined) {
      out.push(<strong key={key++} className="font-semibold text-[var(--text-primary)]">{m[2]}</strong>);
    } else {
      out.push(
        <button key={key++} type="button" onClick={() => go(m[4] as ViewType)} className="text-[var(--accent)] underline-offset-2 hover:underline">
          {m[3]}
        </button>,
      );
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Section = HelpText['sections'][number];

const sectionText = (s: Section): string =>
  [s.title, s.lead, ...(s.items ?? []), ...(s.table ?? []).flat(), ...(s.faq ?? []).flat()].join(' ').toLowerCase();

/** Plain text of a markup string (for search snippets and card previews). */
const plain = (text: string): string => text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\(view:\w+\)/g, '$1');

/** A short piece of the section around the first match of `q`. */
function snippet(s: Section, q: string): string {
  const pool = [s.lead ?? '', ...(s.items ?? []), ...(s.table ?? []).map(([a, b]) => `${a} — ${b}`), ...(s.faq ?? []).map(([a, b]) => `${a} — ${b}`)].map(plain);
  const hit = pool.find((line) => line.toLowerCase().includes(q)) ?? pool[0] ?? '';
  const at = Math.max(0, hit.toLowerCase().indexOf(q) - 40);
  return (at > 0 ? '…' : '') + hit.slice(at, at + 150) + (hit.length > at + 150 ? '…' : '');
}

const PAGE_KEY = 'otto-docs-page';

/**
 * Documentation as pages: an overview with a card per topic, then one page per
 * topic with previous/next navigation. Search lists matching pages.
 */
export function HelpView({ onNavigate, standalone = false }: { onNavigate?: (view: ViewType) => void; standalone?: boolean }) {
  const { locale } = useT();
  const text = TEXT[locale] ?? en;
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<string>('home');
  const scroller = useRef<HTMLDivElement>(null);
  const go = (view: ViewType) => onNavigate?.(view);

  // remember the page across visits
  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem(PAGE_KEY);
      if (saved && (saved === 'home' || text.sections.some((sec) => sec.id === saved))) setPage(saved);
    } catch { /* ignore */ }
  }, [text]);
  const open = (id: string) => {
    setPage(id);
    setQuery('');
    try { window.sessionStorage.setItem(PAGE_KEY, id); } catch { /* ignore */ }
    scroller.current?.scrollTo({ top: 0 });
  };

  const q = query.trim().toLowerCase();
  const found = useMemo(() => (q ? text.sections.filter((sec) => sectionText(sec).includes(q)) : []), [q, text]);
  const index = text.sections.findIndex((sec) => sec.id === page);
  const section = index >= 0 ? text.sections[index] : null;
  const prev = index > 0 ? text.sections[index - 1] : null;
  const next = index >= 0 && index < text.sections.length - 1 ? text.sections[index + 1] : null;

  const navBtn = (active: boolean) =>
    `flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
      active ? 'bg-[var(--accent-glow)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
    }`;

  return (
    <div className="flex flex-1 min-h-0">
      {/* Pages */}
      <nav className="hidden w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--border-color)] p-3 lg:flex" aria-label={text.contents}>
        <button type="button" onClick={() => open('home')} className={navBtn(page === 'home' && !q)}>
          <Home size={13} className="shrink-0" />
          <span className="truncate">{text.overview}</span>
        </button>
        <div className="mb-0.5 mt-2 px-2 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{text.contents}</div>
        {text.sections.map((sec) => (
          <button key={sec.id} type="button" onClick={() => open(sec.id)} className={navBtn(page === sec.id && !q)}>
            <SectionIcon id={sec.id} size={13} className="shrink-0" />
            <span className="truncate">{sec.title}</span>
          </button>
        ))}
      </nav>

      <div ref={scroller} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-6">
          <header className="mb-4 flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="mb-1 flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]">
                <BookOpen size={18} className="text-[var(--accent)]" /> {text.title}
              </h1>
              {section && !q && (
                <nav className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]" aria-label="breadcrumb">
                  <button type="button" onClick={() => open('home')} className="hover:text-[var(--accent)]">{text.overview}</button>
                  <ChevronRight size={11} />
                  <span className="text-[var(--text-secondary)]">{section.title}</span>
                </nav>
              )}
            </div>
            {!standalone && (
              <button
                type="button"
                onClick={() => openDocsWindow()}
                title={text.openWindow}
                aria-label={text.openWindow}
                className="shrink-0 rounded-lg border border-[var(--border-color)] p-1.5 text-[var(--text-muted)] transition-colors hover:border-[var(--accent)]/40 hover:text-[var(--accent)]"
              >
                <ExternalLink size={14} />
              </button>
            )}
          </header>

          {/* small screens: no side navigation, a page picker instead */}
          <select
            value={page}
            onChange={(e) => open(e.target.value)}
            aria-label={text.contents}
            className="mb-4 w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none lg:hidden"
          >
            <option value="home">{text.overview}</option>
            {text.sections.map((sec) => <option key={sec.id} value={sec.id}>{sec.title}</option>)}
          </select>

          <label className="relative mb-5 block">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={text.searchPlaceholder}
              className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] py-2 pl-9 pr-3 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
            />
          </label>

          {/* Search results */}
          {q && (
            <div className="space-y-2">
              {found.length === 0 ? (
                <p className="py-10 text-center text-sm text-[var(--text-muted)]">{text.nothing}</p>
              ) : (
                found.map((sec) => (
                  <button
                    key={sec.id}
                    type="button"
                    onClick={() => open(sec.id)}
                    className="group block w-full rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 text-left transition-colors hover:border-[var(--accent)]/50"
                  >
                    <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                      <SectionIcon id={sec.id} size={14} className="text-[var(--accent)]" /> {sec.title}
                      <ChevronRight size={13} className="ml-auto text-[var(--text-muted)] transition-transform group-hover:translate-x-0.5" />
                    </div>
                    <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{snippet(sec, q)}</p>
                  </button>
                ))
              )}
            </div>
          )}

          {/* Overview */}
          {!q && page === 'home' && (
            <>
              <p className="mb-5 text-xs leading-relaxed text-[var(--text-muted)]">{text.subtitle}</p>
              <div className="mb-6 grid gap-3 sm:grid-cols-3">
                {text.quick.map((step) => (
                  <button
                    key={step.n}
                    type="button"
                    onClick={() => step.view && go(step.view)}
                    className="group rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 text-left transition-colors hover:border-[var(--accent)]/50"
                  >
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--accent)] text-[11px] font-bold text-[var(--on-accent)]">{step.n}</span>
                      <span className="text-sm font-semibold text-[var(--text-primary)]">{step.title}</span>
                      <ChevronRight size={13} className="ml-auto text-[var(--text-muted)] transition-transform group-hover:translate-x-0.5" />
                    </div>
                    <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{step.text}</p>
                  </button>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {text.sections.map((sec) => (
                  <button
                    key={sec.id}
                    type="button"
                    onClick={() => open(sec.id)}
                    className="group rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3.5 text-left transition-colors hover:border-[var(--accent)]/50"
                  >
                    <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                      <SectionIcon id={sec.id} size={15} className="text-[var(--accent)]" /> {sec.title}
                      <ChevronRight size={13} className="ml-auto text-[var(--text-muted)] transition-transform group-hover:translate-x-0.5" />
                    </div>
                    <p className="line-clamp-2 text-xs leading-relaxed text-[var(--text-secondary)]">{plain(sec.lead ?? sec.items?.[0] ?? sec.faq?.[0]?.[0] ?? '')}</p>
                  </button>
                ))}
              </div>
            </>
          )}

          {/* One topic = one page */}
          {!q && section && (
            <article>
              <h2 className="mb-1.5 flex items-center gap-2 text-base font-semibold text-[var(--text-primary)]">
                <SectionIcon id={section.id} size={17} className="text-[var(--accent)]" /> {section.title}
              </h2>
              {section.lead && <p className="mb-4 text-sm leading-relaxed text-[var(--text-secondary)]">{inline(section.lead, go)}</p>}

              {section.table && (
                <dl className="mb-4 overflow-hidden rounded-lg border border-[var(--border-color)] text-xs">
                  {section.table.map(([name, desc], i) => (
                    <div key={name} className={`grid grid-cols-[minmax(0,10rem)_1fr] gap-3 px-3 py-2 ${i % 2 ? 'bg-[var(--bg-tertiary)]/40' : 'bg-[var(--bg-secondary)]'}`}>
                      <dt className="break-words font-mono text-[11px] text-[var(--text-primary)]">{name}</dt>
                      <dd className="leading-relaxed text-[var(--text-secondary)]">{inline(desc, go)}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {section.items && (
                <ul className="mb-4 space-y-2.5">
                  {section.items.map((it, i) => (
                    <li key={i} className="flex gap-2.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
                      <span className="mt-0.5 shrink-0 text-[var(--accent)]">•</span>
                      <span>{inline(it, go)}</span>
                    </li>
                  ))}
                </ul>
              )}

              {section.faq && (
                <div className="mb-4 space-y-2">
                  {section.faq.map(([question, answer]) => (
                    <details key={question} className="group rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] open:bg-[var(--bg-secondary)]">
                      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[13px] font-medium text-[var(--text-primary)]">
                        <ChevronRight size={14} className="shrink-0 text-[var(--text-muted)] transition-transform group-open:rotate-90" />
                        {question}
                      </summary>
                      <p className="px-3 pb-3 pl-9 text-[13px] leading-relaxed text-[var(--text-secondary)]">{inline(answer, go)}</p>
                    </details>
                  ))}
                </div>
              )}

              {section.links && onNavigate && (
                <div className="mb-4 flex flex-wrap gap-1.5">
                  {section.links.map((l) => (
                    <button
                      key={l.label}
                      type="button"
                      onClick={() => go(l.view)}
                      title={standalone ? text.inMain : undefined}
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--border-color)] px-2.5 py-1 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/50 hover:text-[var(--accent)]"
                    >
                      {l.label} <ChevronRight size={11} />
                    </button>
                  ))}
                </div>
              )}

              <div className="mt-6 grid grid-cols-2 gap-3 border-t border-[var(--border-color)] pt-4">
                {prev ? (
                  <button type="button" onClick={() => open(prev.id)} className="group flex items-center gap-2 rounded-xl border border-[var(--border-color)] p-3 text-left text-xs transition-colors hover:border-[var(--accent)]/50">
                    <ArrowLeft size={14} className="shrink-0 text-[var(--text-muted)] transition-transform group-hover:-translate-x-0.5" />
                    <span className="min-w-0">
                      <span className="block text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{text.prev}</span>
                      <span className="block truncate font-medium text-[var(--text-primary)]">{prev.title}</span>
                    </span>
                  </button>
                ) : <span />}
                {next ? (
                  <button type="button" onClick={() => open(next.id)} className="group flex items-center justify-end gap-2 rounded-xl border border-[var(--border-color)] p-3 text-right text-xs transition-colors hover:border-[var(--accent)]/50">
                    <span className="min-w-0">
                      <span className="block text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{text.next}</span>
                      <span className="block truncate font-medium text-[var(--text-primary)]">{next.title}</span>
                    </span>
                    <ArrowRight size={14} className="shrink-0 text-[var(--text-muted)] transition-transform group-hover:translate-x-0.5" />
                  </button>
                ) : <span />}
              </div>
            </article>
          )}
        </div>
      </div>
    </div>
  );
}
