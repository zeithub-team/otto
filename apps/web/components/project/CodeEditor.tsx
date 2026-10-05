'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { gotoLine as gotoLineCommand, highlightSelectionMatches, openSearchPanel, searchKeymap } from '@codemirror/search';
import { linter, lintGutter, lintKeymap, type Diagnostic } from '@codemirror/lint';
import { fetchDefinition } from '../../lib/api';
import { editorTheme, highlightTheme } from '../../lib/cm/theme';
import { languageId, loadLanguage } from '../../lib/cm/languages';
import { projectCompletion } from '../../lib/cm/completion';
import { useT } from '../../lib/i18n';

interface CodeEditorProps {
  path: string;
  value: string;
  onChange: (value: string) => void;
  /** 1-based line to scroll to and place the caret on (e.g. a route's method). */
  gotoLine?: number;
  /** Project context enabling completion and Ctrl+Click go-to-definition. */
  definitionContext?: { projectId: number };
  /** Jump to a file:line (wired to the explorer's openFile). */
  onJumpToFile?: (path: string, line: number) => void;
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The document as text with the file's own line endings (CRLF files stay CRLF). */
const docText = (state: EditorState): string => state.doc.sliceString(0, state.doc.length, state.lineBreak);

/** Errors of config files as editor diagnostics (JSON syntax, INI structure, tabs in YAML). */
function lintDoc(path: string, text: string, t: T): Diagnostic[] {
  const ext = path.split('.').pop()?.toLowerCase();
  const out: Diagnostic[] = [];
  const lineRange = (n: number): { from: number; to: number } => {
    const lines = text.split(/\r?\n/);
    let from = 0;
    for (let i = 0; i < n - 1 && i < lines.length; i++) from += lines[i].length + (text[from + lines[i].length] === '\r' ? 2 : 1);
    return { from, to: Math.min(text.length, from + (lines[n - 1]?.length ?? 0)) };
  };
  if (ext === 'json') {
    if (!text.trim()) return out;
    try { JSON.parse(text); } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid JSON';
      const lc = /line (\d+) column (\d+)/.exec(message);
      const pos = /position (\d+)/.exec(message);
      let at = 0;
      if (lc) at = lineRange(Number(lc[1])).from + Number(lc[2]) - 1;
      else if (pos) at = Number(pos[1]);
      at = Math.max(0, Math.min(text.length, at));
      out.push({ from: at, to: Math.min(text.length, at + 1), severity: 'error', message: `JSON: ${message}` });
    }
  } else if (ext === 'ini') {
    const keys = new Set<string>();
    let section = 'global';
    text.split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) return;
      if (/^\[[^\]]+\]$/.test(trimmed)) { section = trimmed.toLowerCase(); return; }
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
      if (!match) { out.push({ ...lineRange(index + 1), severity: 'warning', message: t('ce.iniFormat', { n: index + 1 }) }); return; }
      const identity = `${section}:${match[1].toLowerCase()}`;
      if (keys.has(identity)) out.push({ ...lineRange(index + 1), severity: 'warning', message: t('ce.iniDup', { n: index + 1, key: match[1] }) });
      keys.add(identity);
    });
  } else if (ext === 'yaml' || ext === 'yml') {
    text.split(/\r?\n/).forEach((line, index) => {
      if (/\t/.test(line)) out.push({ ...lineRange(index + 1), severity: 'warning', message: t('ce.yamlTabs', { n: index + 1 }) });
    });
  }
  return out;
}

/** Identifier (or a quoted `/route`) under `pos`, with the object before `.` / `->` / `::` as a likely class. */
function symbolAt(state: EditorState, pos: number): { symbol: string; container?: string; line: number } | null {
  const line = state.doc.lineAt(pos);
  const text = line.text;
  const col = pos - line.from;
  const strRe = /(['"`])((?:(?!\1).)*)\1/g;
  let sm: RegExpExecArray | null;
  while ((sm = strRe.exec(text))) {
    if (col > sm.index && col < sm.index + sm[0].length && sm[2].includes('/')) return { symbol: sm[2], line: line.number };
  }
  const isWord = (ch: string | undefined): boolean => /[\p{L}\p{N}_$]/u.test(ch ?? '');
  let p = col;
  if (!isWord(text[p]) && p > 0 && isWord(text[p - 1])) p -= 1;
  if (!isWord(text[p])) return null;
  let s = p;
  let e = p;
  while (s > 0 && isWord(text[s - 1])) s--;
  while (e < text.length && isWord(text[e])) e++;
  const symbol = text.slice(s, e);
  if (!symbol || /^\d+$/.test(symbol)) return null;
  let container: string | undefined;
  const before = text.slice(0, s);
  const m = /([\p{L}\p{N}_$]+)\s*(?:\?\.|\.|->|::)\s*$/u.exec(before);
  if (m && !/^\d+$/.test(m[1])) container = m[1];
  return { symbol, container, line: line.number };
}

const RU_PHRASES: Record<string, string> = {
  Find: 'Найти', Replace: 'Заменить', next: 'дальше', previous: 'назад', all: 'все', 'match case': 'учитывать регистр',
  regexp: 'регулярка', 'by word': 'слово целиком', replace: 'заменить', 'replace all': 'заменить все', close: 'закрыть',
  'Go to line': 'Перейти к строке', go: 'перейти', 'current match': 'текущее совпадение', 'on line': 'на строке',
  'replaced match on line $': 'заменено совпадение на строке $', 'replaced $ matches': 'заменено совпадений: $',
  Diagnostics: 'Диагностика', 'No diagnostics': 'Ошибок нет', 'Folded lines': 'Свёрнутые строки', 'Unfolded lines': 'Развёрнутые строки',
  to: 'до', 'folded code': 'свёрнутый код', unfold: 'развернуть', 'Fold line': 'Свернуть', 'Unfold line': 'Развернуть',
  'Completions': 'Варианты', 'Selection deleted': 'Выделение удалено',
};

export function CodeEditor({ path, value, onChange, gotoLine, definitionContext, onJumpToFile }: CodeEditorProps) {
  const { t, locale } = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const langComp = useRef(new Compartment());
  const wrapComp = useRef(new Compartment());
  const pathRef = useRef(path);
  const lastEmitted = useRef(value);
  const external = useRef(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [gotoHint, setGotoHint] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const [pos, setPos] = useState({ line: 1, col: 1, selected: 0 });
  const [crlf, setCrlf] = useState(false);

  // props that handlers need at the moment they fire (the editor is created once per file)
  const latest = useRef({ path, onChange, definitionContext, onJumpToFile, t });
  latest.current = { path, onChange, definitionContext, onJumpToFile, t };

  const flashHint = useCallback((text: string) => {
    setGotoHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setGotoHint(null), 2500);
  }, []);
  useEffect(() => () => { if (hintTimer.current) clearTimeout(hintTimer.current); }, []);

  /** Ctrl+Click / F12 */
  const gotoDefinition = useCallback(async (view: EditorView, at: number) => {
    const { definitionContext: ctx, onJumpToFile: jump, path: current, t: tr } = latest.current;
    if (!ctx || !jump) return;
    const hit = symbolAt(view.state, at);
    if (!hit) return;
    try {
      const target = await fetchDefinition(ctx.projectId, { path: current, line: hit.line, symbol: hit.symbol, container: hit.container });
      jump(target.path, target.line);
    } catch {
      flashHint(tr('ce.noDef', { name: hit.symbol }));
    }
  }, [flashHint]);

  const buildState = useCallback((doc: string, forPath: string): EditorState => {
    const useCrlf = /\r\n/.test(doc) && !/(^|[^\r])\n/.test(doc);
    const source = projectCompletion(() => {
      const ctx = latest.current.definitionContext;
      return ctx ? { projectId: ctx.projectId, path: latest.current.path } : null;
    });
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      indentUnit.of('  '),
      EditorState.tabSize.of(2),
      ...(useCrlf ? [EditorState.lineSeparator.of('\r\n')] : []),
      autocompletion({ activateOnTyping: true, maxRenderedOptions: 80, icons: true }),
      // the same function object every time: a new one per query makes CodeMirror restart the query in a loop
      EditorState.languageData.of(() => [{ autocomplete: source }]),
      lintGutter(),
      linter((view) => lintDoc(latest.current.path, view.state.sliceDoc(0, view.state.doc.length), latest.current.t), { delay: 500 }),
      editorTheme,
      highlightTheme,
      langComp.current.of([]),
      wrapComp.current.of(wrap ? EditorView.lineWrapping : []),
      ...(locale === 'ru' ? [EditorState.phrases.of(RU_PHRASES)] : []),
      keymap.of([
        { key: 'F12', run: (view) => { void gotoDefinition(view, view.state.selection.main.head); return true; } },
        { key: 'Mod-g', run: gotoLineCommand, preventDefault: true },
        { key: 'Mod-h', run: openSearchPanel, preventDefault: true },
        { key: 'Mod-r', run: openSearchPanel, preventDefault: true },
        { key: 'Alt-z', run: () => { setWrap((w) => !w); return true; }, preventDefault: true },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap,
        indentWithTab,
      ]),
      EditorView.domEventHandlers({
        mousedown: (event, view) => {
          if (!(event.ctrlKey || event.metaKey) || event.altKey || event.button !== 0) return false;
          const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (at === null || !latest.current.definitionContext) return false;
          if (!view.state.selection.main.empty) return false; // a real selection is for copying
          event.preventDefault();
          void gotoDefinition(view, at);
          return true;
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !external.current) {
          const text = docText(update.state);
          lastEmitted.current = text;
          latest.current.onChange(text);
        }
        if (update.selectionSet || update.docChanged) {
          const sel = update.state.selection.main;
          const line = update.state.doc.lineAt(sel.head);
          setPos({ line: line.number, col: sel.head - line.from + 1, selected: Math.abs(sel.to - sel.from) });
        }
      }),
    ];
    void forPath;
    return EditorState.create({ doc, extensions });
    // `wrap` and `locale` are applied through the compartment / at creation only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gotoDefinition]);

  // Create the view once
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({ state: buildState(value, path), parent: host });
    viewRef.current = view;
    const map = states.current;
    void applyLanguage(path);
    return () => {
      view.destroy();
      viewRef.current = null;
      map.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyLanguage = useCallback(async (forPath: string) => {
    const ext = await loadLanguage(forPath).catch(() => null);
    const view = viewRef.current;
    if (view && pathRef.current === forPath) view.dispatch({ effects: langComp.current.reconfigure(ext ?? []) });
  }, []);

  // Switching files: keep every file's undo history and caret, restore them on return
  useEffect(() => {
    const view = viewRef.current;
    if (!view || pathRef.current === path) return;
    states.current.set(pathRef.current, view.state);
    pathRef.current = path;
    const saved = states.current.get(path);
    external.current = true;
    try {
      const restored = saved && docText(saved) === value ? saved : buildState(value, path);
      view.setState(restored);
    } finally {
      external.current = false;
    }
    lastEmitted.current = value;
    setCrlf(view.state.lineBreak === '\r\n');
    void applyLanguage(path);
    view.scrollDOM.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // The content changed outside the editor (replace in files, reload from disk, another tab)
  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === lastEmitted.current) return;
    const current = docText(view.state);
    if (current === value) { lastEmitted.current = value; return; }
    external.current = true;
    try {
      const head = Math.min(view.state.selection.main.head, value.length);
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, selection: EditorSelection.cursor(head) });
    } finally {
      external.current = false;
    }
    lastEmitted.current = value;
  }, [value]);

  // Jump to a requested line (route → method navigation, definitions, search results)
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !gotoLine || gotoLine < 1) return;
    const line = view.state.doc.line(Math.min(gotoLine, view.state.doc.lines));
    view.dispatch({ selection: EditorSelection.cursor(line.from), effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    view.focus();
  }, [gotoLine, path, value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: wrapComp.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  return (
    <div className="code-editor relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-primary)]">
      <div ref={hostRef} className="code-editor-host relative min-h-0 flex-1 overflow-hidden" />
      <div className="flex shrink-0 items-center gap-3 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-1 text-[11px] text-[var(--text-muted)]">
        <span className="tabular-nums">{pos.line}:{pos.col}</span>
        {pos.selected > 0 && <span>{t('ce.sel', { n: pos.selected })}</span>}
        <span className="ml-auto flex items-center gap-3">
          <button onClick={() => setWrap((w) => !w)} title={t('ce.wrap')} className={`hover:text-[var(--text-primary)] ${wrap ? 'text-[var(--accent)]' : ''}`}>Wrap</button>
          <span>{crlf ? 'CRLF' : 'LF'}</span>
          <span>UTF-8</span>
          <span>{languageId(path)}</span>
        </span>
      </div>
      {gotoHint && (
        <div className="absolute bottom-10 left-1/2 z-20 -translate-x-1/2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs text-[var(--text-secondary)] shadow-xl">
          {gotoHint}
        </div>
      )}
    </div>
  );
}
