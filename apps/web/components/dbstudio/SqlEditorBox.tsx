'use client';

import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultHighlightStyle, syntaxHighlighting, bracketMatching } from '@codemirror/language';
import { MySQL, PostgreSQL, sql } from '@codemirror/lang-sql';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import type { DbConn } from '../../lib/api';
import { splitStatements, type SqlProblem } from '../../lib/dbxapi';

export interface SqlEditorHandle { getValue(): string; getRange(): { from: number; to: number } }

/** SQL editor: highlighting, bracket matching and completion of tables/columns taken from the connected database. */
export function SqlEditorBox({ value, kind, schema, onChange, onRun, handle, check }: {
  value: string;
  kind: DbConn['kind'];
  /** table name → column names (and `schema.table` keys). */
  schema: Record<string, string[]>;
  onChange: (v: string) => void;
  onRun: () => void;
  handle: { current: SqlEditorHandle | null };
  /** Asks the database whether a statement is valid; null = fine. Its answer becomes the red underlines. */
  check?: (sql: string) => Promise<SqlProblem | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onRun, check });
  cb.current = { onChange, onRun, check };

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(), lintGutter(),
        linter(async (v): Promise<Diagnostic[]> => {
          const run = cb.current.check;
          if (!run) return [];
          const found: Diagnostic[] = [];
          for (const st of splitStatements(v.state.doc.toString()).slice(0, 8)) {
            const problem = await run(st.text).catch(() => null);
            if (problem) found.push({ from: st.from + problem.from, to: Math.max(st.from + problem.from + 1, st.from + problem.to), severity: 'error', message: problem.message });
          }
          return found;
        }, { delay: 700 }),
        history(), drawSelection(), highlightActiveLine(), bracketMatching(), closeBrackets(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        sql({ dialect: kind === 'postgres' ? PostgreSQL : MySQL, schema, upperCaseKeywords: true }),
        autocompletion({ activateOnTyping: true }),
        keymap.of([
          { key: 'Mod-Enter', run: () => { cb.current.onRun(); return true; } },
          ...closeBracketsKeymap, ...completionKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab,
        ]),
        EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange(u.state.doc.toString()); }),
        EditorView.theme({
          '&': { height: '100%', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '13px' },
          '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
          '.cm-gutters': { backgroundColor: 'var(--bg-secondary)', color: 'var(--text-muted)', border: 'none' },
          '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 7%, transparent)' },
          '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-primary)' },
          '.cm-cursor': { borderLeftColor: 'var(--accent)' },
          '&.cm-focused': { outline: 'none' },
          '.cm-diagnostic-error': { borderLeft: '3px solid var(--error)', color: 'var(--text-primary)' },
          '.cm-tooltip': { backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' },
          '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-glow)', color: 'var(--text-primary)' },
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    handle.current = {
      getValue: () => v.state.doc.toString(),
      getRange: () => ({ from: v.state.selection.main.from, to: v.state.selection.main.to }),
    };
    return () => { v.destroy(); view.current = null; handle.current = null; };
    // the editor is rebuilt only when the dialect or the completion schema changes; text is kept through `value`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, schema]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
