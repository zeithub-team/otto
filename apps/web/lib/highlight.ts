/**
 * Lightweight syntax highlighter for the file editor.
 *
 * Zero dependencies: a sticky-regex scanner walks the source once and wraps
 * tokens in <span class="tok-*">. Only the languages we actually open in the
 * editor are covered; anything else falls back to a generic C-like rule set.
 */

type Lang =
  | 'js' | 'jsx' | 'json' | 'css' | 'html' | 'py'
  | 'yaml' | 'ini' | 'md' | 'sh' | 'sql' | 'php' | 'nsis' | 'other';

interface Rule {
  re: RegExp;
  cls: string;
}

/** Files bigger than this are shown as plain text (perf guard). */
const MAX_HIGHLIGHT_BYTES = 150_000;

const JS_KEYWORDS = [
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'class', 'extends', 'new', 'import', 'export', 'from', 'default', 'async', 'await',
  'try', 'catch', 'finally', 'throw', 'switch', 'case', 'break', 'continue', 'typeof',
  'instanceof', 'in', 'of', 'this', 'null', 'undefined', 'true', 'false', 'void',
  'delete', 'static', 'get', 'set', 'interface', 'type', 'enum', 'public', 'private',
  'protected', 'readonly', 'abstract', 'yield', 'as', 'satisfies', 'keyof', 'infer',
];

const PY_KEYWORDS = [
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'not', 'and',
  'or', 'is', 'None', 'True', 'False', 'import', 'from', 'as', 'with', 'try',
  'except', 'finally', 'raise', 'lambda', 'yield', 'global', 'nonlocal', 'pass',
  'break', 'continue', 'assert', 'del', 'async', 'await', 'self', 'cls', 'print',
];

const SH_KEYWORDS = [
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac',
  'function', 'return', 'local', 'export', 'echo', 'cd', 'exit', 'set', 'source',
  'read', 'trap', 'shift', 'select', 'until', 'true', 'false',
];

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'TABLE', 'DROP', 'ALTER', 'ADD', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES',
  'NOT', 'NULL', 'DEFAULT', 'UNIQUE', 'INDEX', 'JOIN', 'LEFT', 'RIGHT', 'INNER',
  'OUTER', 'ON', 'GROUP', 'ORDER', 'BY', 'HAVING', 'LIMIT', 'OFFSET', 'AND', 'OR',
  'IN', 'LIKE', 'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'BEGIN',
  'COMMIT', 'ROLLBACK', ' TRANSACTION', 'INT', 'VARCHAR', 'TEXT', 'BOOLEAN',
];

const PHP_KEYWORDS = [
  'function', 'class', 'extends', 'implements', 'interface', 'public', 'private',
  'protected', 'static', 'return', 'if', 'else', 'elseif', 'foreach', 'for', 'while',
  'do', 'switch', 'case', 'break', 'continue', 'new', 'echo', 'print', 'try',
  'catch', 'finally', 'throw', 'use', 'namespace', 'const', 'var', 'global', 'array',
  'true', 'false', 'null', 'require', 'require_once', 'include', 'include_once',
];

const NSIS_KEYWORDS = [
  'Function', 'FunctionEnd', 'Section', 'SectionEnd', 'SectionGroup', 'SectionGroupEnd', 'Page', 'UninstPage',
  'PageEx', 'PageExEnd', 'Var', 'Name', 'OutFile', 'InstallDir', 'InstallDirRegKey', 'RequestExecutionLevel',
  'ShowInstDetails', 'ShowUninstDetails', 'SetCompressor', 'Unicode', 'BrandingText', 'Icon', 'UninstallIcon',
  'Call', 'Goto', 'Return', 'Abort', 'Quit', 'StrCmp', 'StrCpy', 'IntOp', 'IntCmp', 'IfFileExists',
  'FileOpen', 'FileClose', 'FileRead', 'FileWrite', 'File', 'Delete', 'RMDir', 'CreateDirectory', 'SetOutPath',
  'WriteRegStr', 'WriteRegDWORD', 'ReadRegStr', 'DeleteRegKey', 'CreateShortCut', 'nsExec', 'ExecWait', 'Exec',
  'MessageBox', 'DetailPrint', 'SetDetailsPrint', 'SendMessage', 'System', 'Push', 'Pop', 'Exch',
  'LangString', 'LoadLanguageFile', 'Nop', 'Sleep', 'SetShellVarContext', 'SetRegView', 'SetOverwrite',
  'ReserveFile', 'BringToFront', 'GetDlgItem', 'ShowWindow', 'EnableWindow',
];

function kw(words: string[]): string {
  return `\\b(?:${words.join('|')})\\b`;
}

const DOUBLE_STR = '"(?:[^"\\\\\\n]|\\\\.)*"';
const SINGLE_STR = "'(?:[^'\\\\\\n]|\\\\.)*'";
const TEMPLATE_STR = '`(?:[^`\\\\]|\\\\[\\s\\S])*`';
const NUMBER = '\\b0x[\\da-fA-F]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][-+]?\\d+)?\\b';
const FN_CALL = '[A-Za-z_$][\\w$]*(?=\\s*\\()';

function rulesFor(lang: Lang): Rule[] {
  switch (lang) {
    case 'jsx':
      return [
        { re: /\/\*[\s\S]*?\*\//y, cls: 'tok-com' },
        { re: /\/\/[^\n]*/y, cls: 'tok-com' },
        { re: new RegExp(TEMPLATE_STR, 'y'), cls: 'tok-str' },
        { re: new RegExp(DOUBLE_STR, 'y'), cls: 'tok-str' },
        { re: new RegExp(SINGLE_STR, 'y'), cls: 'tok-str' },
        { re: /<\/?[A-Za-z][\w.-]*/y, cls: 'tok-typ' },
        { re: new RegExp(NUMBER, 'y'), cls: 'tok-num' },
        { re: new RegExp(kw(JS_KEYWORDS), 'y'), cls: 'tok-kw' },
        { re: new RegExp(FN_CALL, 'y'), cls: 'tok-fn' },
      ];
    case 'js':
    case 'other':
      return [
        { re: /\/\*[\s\S]*?\*\//y, cls: 'tok-com' },
        { re: /\/\/[^\n]*/y, cls: 'tok-com' },
        { re: new RegExp(TEMPLATE_STR, 'y'), cls: 'tok-str' },
        { re: new RegExp(DOUBLE_STR, 'y'), cls: 'tok-str' },
        { re: new RegExp(SINGLE_STR, 'y'), cls: 'tok-str' },
        { re: new RegExp(NUMBER, 'y'), cls: 'tok-num' },
        { re: new RegExp(kw(JS_KEYWORDS), 'y'), cls: 'tok-kw' },
        { re: new RegExp(FN_CALL, 'y'), cls: 'tok-fn' },
      ];
    case 'json':
      return [
        { re: new RegExp(DOUBLE_STR + '(?=\\s*:)', 'y'), cls: 'tok-key' },
        { re: new RegExp(DOUBLE_STR, 'y'), cls: 'tok-str' },
        { re: new RegExp(NUMBER, 'y'), cls: 'tok-num' },
        { re: /\b(?:true|false|null)\b/y, cls: 'tok-kw' },
      ];
    case 'css':
      return [
        { re: /\/\*[\s\S]*?\*\//y, cls: 'tok-com' },
        { re: new RegExp(DOUBLE_STR + '|' + SINGLE_STR, 'y'), cls: 'tok-str' },
        { re: /@[\w-]+/y, cls: 'tok-kw' },
        { re: /--[\w-]+|[-a-zA-Z]+(?=\s*:)/y, cls: 'tok-key' },
        { re: /#[\da-fA-F]{3,8}\b/y, cls: 'tok-num' },
        { re: new RegExp(NUMBER, 'y'), cls: 'tok-num' },
        { re: /\b(?:important|inherit|initial|unset|none|auto|solid|flex|grid|block|inline|absolute|relative|fixed|sticky)\b/y, cls: 'tok-kw' },
      ];
    case 'html':
      return [
        { re: /<!--[\s\S]*?-->/y, cls: 'tok-com' },
        { re: /<\/?[A-Za-z][\w-]*/y, cls: 'tok-typ' },
        { re: /\/?>/y, cls: 'tok-typ' },
        { re: new RegExp(DOUBLE_STR + '|' + SINGLE_STR, 'y'), cls: 'tok-str' },
        { re: /[\w-]+(?=\s*=)/y, cls: 'tok-key' },
        { re: /&[\w#]+;/y, cls: 'tok-num' },
      ];
    case 'py':
      return [
        { re: /#[^\n]*/y, cls: 'tok-com' },
        { re: /"""[\s\S]*?"""|'''[\s\S]*?'''/y, cls: 'tok-str' },
        { re: new RegExp(DOUBLE_STR + '|' + SINGLE_STR, 'y'), cls: 'tok-str' },
        { re: /@[\w.]+/y, cls: 'tok-typ' },
        { re: new RegExp(NUMBER, 'y'), cls: 'tok-num' },
        { re: new RegExp(kw(PY_KEYWORDS), 'y'), cls: 'tok-kw' },
        { re: new RegExp(FN_CALL, 'y'), cls: 'tok-fn' },
      ];
    case 'yaml':
      return [
        { re: /#[^\n]*/y, cls: 'tok-com' },
        { re: /^[ \t]*-?[\w./-]+(?=\s*:)/my, cls: 'tok-key' },
        { re: new RegExp(DOUBLE_STR + '|' + SINGLE_STR, 'y'), cls: 'tok-str' },
        { re: new RegExp(NUMBER, 'y'), cls: 'tok-num' },
        { re: /\b(?:true|false|null|yes|no|on|off)\b/y, cls: 'tok-kw' },
      ];
    case 'ini':
      return [
        { re: /^[ \t]*[;#][^\n]*/my, cls: 'tok-com' },
        { re: /^\s*\[[^\]\n]+\]/my, cls: 'tok-typ' },
        { re: /^[ \t]*[\w.-]+(?=\s*=)/my, cls: 'tok-key' },
        { re: new RegExp(DOUBLE_STR + '|' + SINGLE_STR, 'y'), cls: 'tok-str' },
        { re: /\b(?:On|Off|True|False|Yes|No|E_ALL|E_ERROR|E_WARNING)\b/iy, cls: 'tok-kw' },
        { re: new RegExp(NUMBER, 'y'), cls: 'tok-num' },
      ];
    case 'md':
      return [
        { re: /^#{1,6} [^\n]*/my, cls: 'tok-typ' },
        { re: /```[\s\S]*?```|`[^`\n]+`/y, cls: 'tok-str' },
        { re: /\*\*[^*\n]+\*\*/y, cls: 'tok-kw' },
        { re: /\[[^\]\n]*\]\([^)\n]*\)/y, cls: 'tok-fn' },
        { re: /^[ \t]*[-*+] /my, cls: 'tok-punc' },
      ];
    case 'sh':
      return [
        { re: /#[^\n]*/y, cls: 'tok-com' },
        { re: new RegExp(DOUBLE_STR + '|' + SINGLE_STR, 'y'), cls: 'tok-str' },
        { re: new RegExp(NUMBER, 'y'), cls: 'tok-num' },
        { re: new RegExp(kw(SH_KEYWORDS), 'y'), cls: 'tok-kw' },
        { re: new RegExp(FN_CALL, 'y'), cls: 'tok-fn' },
      ];
    case 'sql':
      return [
        { re: /--[^\n]*/y, cls: 'tok-com' },
        { re: /\/\*[\s\S]*?\*\//y, cls: 'tok-com' },
        { re: new RegExp(SINGLE_STR + '|' + DOUBLE_STR, 'y'), cls: 'tok-str' },
        { re: new RegExp(kw(SQL_KEYWORDS), 'iy'), cls: 'tok-kw' },
        { re: new RegExp(NUMBER, 'y'), cls: 'tok-num' },
      ];
    case 'nsis':
      return [
        { re: /(?:;|#)[^\n]*/y, cls: 'tok-com' },
        { re: /\/\*[\s\S]*?\*\//y, cls: 'tok-com' },
        { re: new RegExp(DOUBLE_STR + '|' + SINGLE_STR + '|`[^`\n]*`', 'y'), cls: 'tok-str' },
        { re: /\$\{[^}\n]+\}|\$\([^)\n]+\)|\$[A-Za-z_]\w*/y, cls: 'tok-key' },
        { re: /![A-Za-z]\w*/y, cls: 'tok-typ' },
        { re: new RegExp(kw(NSIS_KEYWORDS), 'iy'), cls: 'tok-kw' },
        { re: new RegExp(NUMBER, 'y'), cls: 'tok-num' },
        { re: /\/[A-Za-z][\w]*/y, cls: 'tok-fn' },
      ];
    case 'php':
      return [
        { re: /\/\*[\s\S]*?\*\//y, cls: 'tok-com' },
        { re: /(?:\/\/|#)[^\n]*/y, cls: 'tok-com' },
        { re: /<\?php|<\?=/y, cls: 'tok-typ' },
        { re: new RegExp(DOUBLE_STR + '|' + SINGLE_STR, 'y'), cls: 'tok-str' },
        { re: /\$[\w]+/y, cls: 'tok-key' },
        { re: new RegExp(NUMBER, 'y'), cls: 'tok-num' },
        { re: new RegExp(kw(PHP_KEYWORDS), 'y'), cls: 'tok-kw' },
        { re: new RegExp(FN_CALL, 'y'), cls: 'tok-fn' },
      ];
  }
}

const EXT_LANG: Record<string, Lang> = {
  js: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'jsx', jsx: 'jsx', vue: 'jsx',
  svelte: 'jsx', json: 'json', jsonc: 'json',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue2: 'html',
  py: 'py', pyw: 'py',
  yml: 'yaml', yaml: 'yaml', toml: 'yaml', cfg: 'yaml', env: 'yaml',
  ini: 'ini',
  md: 'md', markdown: 'md',
  sh: 'sh', bash: 'sh', zsh: 'sh', bat: 'sh', cmd: 'sh', ps1: 'sh', dockerfile: 'sh',
  sql: 'sql',
  php: 'php', phtml: 'php',
  nsi: 'nsis', nsh: 'nsis',
};

function langOf(path: string): Lang {
  const name = path.split('/').pop() ?? path;
  if (/^dockerfile/i.test(name)) return 'sh';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return EXT_LANG[ext] ?? 'other';
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const rulesCache = new Map<Lang, Rule[]>();

/**
 * Return highlighted HTML for `code`. The output is fully escaped — only the
 * <span class="tok-*"> wrappers we add ourselves are markup.
 */
export function highlight(code: string, path: string): string {
  if (code.length > MAX_HIGHLIGHT_BYTES) return escapeHtml(code);

  const lang = langOf(path);
  let rules = rulesCache.get(lang);
  if (!rules) {
    rules = rulesFor(lang);
    rulesCache.set(lang, rules);
  }

  const out: string[] = [];
  let i = 0;
  let plainStart = 0;

  const flushPlain = (end: number) => {
    if (end > plainStart) out.push(escapeHtml(code.slice(plainStart, end)));
  };

  while (i < code.length) {
    let matched = false;
    for (const rule of rules) {
      rule.re.lastIndex = i;
      const m = rule.re.exec(code);
      if (m && m[0].length > 0) {
        flushPlain(i);
        out.push(`<span class="${rule.cls}">${escapeHtml(m[0])}</span>`);
        i += m[0].length;
        plainStart = i;
        matched = true;
        break;
      }
    }
    if (!matched) i += 1;
  }
  flushPlain(i);
  return out.join('');
}
