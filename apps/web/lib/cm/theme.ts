import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/** Editor chrome in the app's color scheme (every color is a CSS variable, so the schemes switch live). */
export const editorTheme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '13px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', overflow: 'auto' },
    '.cm-content': { caretColor: 'var(--accent)', padding: '10px 0' },
    '.cm-line': { padding: '0 16px 0 8px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '.cm-gutters': { backgroundColor: 'var(--bg-secondary)', color: 'var(--text-muted)', borderRight: '1px solid var(--border-color)' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 12px', minWidth: '3rem' },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 7%, transparent)' },
    '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent) 10%, transparent)', color: 'var(--text-primary)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)',
    },
    '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 20%, transparent)' },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)', outline: '1px solid color-mix(in srgb, var(--accent) 60%, transparent)' },
    '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'color-mix(in srgb, var(--error) 30%, transparent)' },
    '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-muted)', padding: '0 6px' },
    '.cm-foldGutter .cm-gutterElement': { cursor: 'pointer', padding: '0 4px' },
    '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warning) 30%, transparent)', outline: '1px solid color-mix(in srgb, var(--warning) 60%, transparent)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--accent) 40%, transparent)' },

    // panels (find / replace)
    '.cm-panels': { backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', borderColor: 'var(--border-color)' },
    '.cm-panels-bottom': { borderTop: '1px solid var(--border-color)' },
    '.cm-panels-top': { borderBottom: '1px solid var(--border-color)' },
    '.cm-panel.cm-search': { padding: '6px 32px 6px 8px', fontSize: '12px' },
    '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontSize: '12px' },
    '.cm-panel.cm-search input.cm-textfield': {
      backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', borderRadius: '6px', padding: '3px 8px', outline: 'none',
    },
    '.cm-panel.cm-search input.cm-textfield:focus': { borderColor: 'var(--accent)' },
    '.cm-panel.cm-search button.cm-button': {
      backgroundImage: 'none', backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', borderRadius: '6px', padding: '2px 8px',
    },
    '.cm-panel.cm-search button.cm-button:hover': { borderColor: 'var(--accent)', color: 'var(--accent)' },
    '.cm-panel.cm-search label': { color: 'var(--text-secondary)' },
    '.cm-panel.cm-search [name=close]': { color: 'var(--text-muted)' },

    // tooltips + completion list
    '.cm-tooltip': { backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.45)' },
    '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '12px', maxHeight: '18em' },
    '.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px', display: 'flex', alignItems: 'center' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-glow)', color: 'var(--accent)' },
    '.cm-completionLabel': { flex: '0 1 auto' },
    '.cm-completionMatchedText': { color: 'var(--accent)', textDecoration: 'none', fontWeight: '700' },
    '.cm-completionDetail': { marginLeft: 'auto', paddingLeft: '18px', color: 'var(--text-muted)', fontStyle: 'normal', fontSize: '11px', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis' },
    '.cm-completionIcon': { display: 'inline-block', width: '18px', marginRight: '6px', textAlign: 'center', opacity: '0.95', flexShrink: '0' },
    '.cm-completionIcon-class::after': { content: "'C'", color: 'var(--tok-typ)' },
    '.cm-completionIcon-interface::after': { content: "'I'", color: 'var(--tok-typ)' },
    '.cm-completionIcon-type::after': { content: "'T'", color: 'var(--tok-typ)' },
    '.cm-completionIcon-function::after': { content: "'ƒ'", color: 'var(--tok-fn)' },
    '.cm-completionIcon-method::after': { content: "'m'", color: 'var(--tok-fn)' },
    '.cm-completionIcon-variable::after': { content: "'v'", color: 'var(--tok-key)' },
    '.cm-completionIcon-keyword::after': { content: "'k'", color: 'var(--tok-kw)' },
    '.cm-completionIcon-property::after': { content: "'p'", color: 'var(--tok-key)' },
    '.cm-completionIcon-class, .cm-completionIcon-interface, .cm-completionIcon-type, .cm-completionIcon-function, .cm-completionIcon-method, .cm-completionIcon-variable, .cm-completionIcon-keyword, .cm-completionIcon-property': { fontSize: '0' },
    '.cm-completionIcon::after': { fontSize: '11px', fontWeight: '700' },
    '.cm-tooltip.cm-tooltip-hover': { padding: '6px 10px', fontSize: '12px', maxWidth: '520px' },
    '.cm-lsp-hover': { whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)' },

    // diagnostics
    '.cm-diagnostic': { padding: '3px 8px', fontSize: '12px' },
    '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--error)', textUnderlineOffset: '3px' },
    '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--warning)', textUnderlineOffset: '3px' },
    '.cm-lintPoint:after': { borderBottomColor: 'var(--error)' },
    '.cm-lint-marker-error': { content: 'none' },
  },
  { dark: true },
);

/** Syntax colors: the same `--tok-*` variables the rest of the app uses. */
export const highlightTheme = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: 'var(--tok-kw)' },
    { tag: [t.string, t.special(t.string), t.regexp, t.character, t.attributeValue], color: 'var(--tok-str)' },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--tok-com)', fontStyle: 'italic' },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.macroName], color: 'var(--tok-fn)' },
    { tag: [t.number, t.bool, t.null, t.atom, t.self, t.unit, t.integer, t.float], color: 'var(--tok-num)' },
    { tag: [t.propertyName, t.attributeName, t.labelName, t.definition(t.propertyName)], color: 'var(--tok-key)' },
    { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName), t.standard(t.typeName)], color: 'var(--tok-typ)' },
    { tag: [t.tagName, t.standard(t.tagName)], color: 'var(--tok-kw)' },
    { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.angleBracket, t.squareBracket, t.paren, t.brace], color: 'var(--tok-punc)' },
    { tag: [t.variableName, t.definition(t.variableName)], color: 'var(--text-primary)' },
    { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: 'var(--tok-num)' },
    { tag: t.heading, color: 'var(--tok-fn)', fontWeight: '700' },
    { tag: t.strong, fontWeight: '700' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: [t.link, t.url], color: 'var(--tok-str)', textDecoration: 'underline' },
    { tag: t.meta, color: 'var(--tok-com)' },
    { tag: t.invalid, color: 'var(--error)' },
  ]),
);
