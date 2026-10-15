/**
 * Syntax check of a file's text BEFORE it is written, so an agent cannot leave a working file broken.
 *
 * JS / TS / JSX / TSX, inline <script> in HTML: the TypeScript parser (only syntax, no type checking).
 * JSON: JSON.parse. CSS / SCSS / LESS: brackets outside strings and comments. Python and PHP: the
 * installed interpreter (`ast.parse`, `php -l`) when there is one. Other files are not checked.
 *
 * A write is judged against the file as it was: only problems the write ADDS count, so a file that
 * was already broken (or a dialect the parser does not know) never blocks the agent.
 */
import { spawnSync } from 'child_process';

export interface SyntaxProblem {
  line: number;
  message: string;
}

type Ts = typeof import('typescript');
let tsModule: Ts | null | undefined;

/** The TypeScript parser, if it ships with this build (null → JS/TS files are not checked). */
function typescript(): Ts | null {
  if (tsModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      tsModule = require('typescript') as Ts;
    } catch {
      tsModule = null;
    }
  }
  return tsModule;
}

const SCRIPT_EXT = /\.(m?[jt]sx?|c[jt]s)$/i;

function scriptProblems(text: string, rel: string, lineOffset = 0): SyntaxProblem[] | null {
  const ts = typescript();
  if (!ts) return null;
  const ext = (/\.([a-z]+)$/i.exec(rel)?.[1] ?? 'js').toLowerCase();
  const kind = ext === 'tsx' ? ts.ScriptKind.TSX
    : ext === 'jsx' ? ts.ScriptKind.JSX
    : /^(ts|mts|cts)$/.test(ext) ? ts.ScriptKind.TS
    : ts.ScriptKind.JS;
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, false, kind);
  const diagnostics = (source as unknown as { parseDiagnostics?: import('typescript').Diagnostic[] }).parseDiagnostics ?? [];
  return diagnostics.map((d) => ({
    line: (d.start !== undefined ? source.getLineAndCharacterOfPosition(d.start).line + 1 : 1) + lineOffset,
    message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
  }));
}

function jsonProblems(text: string): SyntaxProblem[] {
  if (!text.trim()) return [];
  try {
    JSON.parse(text);
    return [];
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    const at = Number(/position (\d+)/.exec(message)?.[1]);
    const line = Number.isFinite(at) ? text.slice(0, at).split('\n').length : Number(/line (\d+)/.exec(message)?.[1]) || 1;
    return [{ line, message }];
  }
}

/** Brackets of a stylesheet, ignoring strings and comments (`//` too for SCSS / LESS). */
function cssProblems(text: string, lineComments: boolean, lineOffset = 0): SyntaxProblem[] {
  const open: Array<{ ch: string; line: number }> = [];
  const problems: SyntaxProblem[] = [];
  const pairs: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') { line++; continue; }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      line += (text.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop - 1;
      continue;
    }
    if (lineComments && ch === '/' && text[i + 1] === '/' && text[i - 1] !== ':') {
      const end = text.indexOf('\n', i);
      i = (end < 0 ? text.length : end) - 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') open.push({ ch, line });
    else if (ch in pairs) {
      const top = open.pop();
      if (!top || top.ch !== pairs[ch]) {
        problems.push({ line: line + lineOffset, message: `unexpected '${ch}'` });
        if (top) open.push(top);
      }
    }
  }
  for (const left of open) problems.push({ line: left.line + lineOffset, message: `'${left.ch}' is never closed` });
  return problems;
}

/** Inline scripts and styles of a page, with their line numbers in the page. */
function htmlProblems(text: string, rel: string): SyntaxProblem[] | null {
  const problems: SyntaxProblem[] = [];
  let checked = false;
  const lineAt = (index: number) => text.slice(0, index).split('\n').length - 1;
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && !/^(module|text\/javascript|application\/javascript)$/.test(type)) continue;
    // a template placeholder ({{ }}, <?php, {% %}) is not JavaScript
    if (/\{\{|\{%|<\?/.test(m[2])) continue;
    const found = scriptProblems(m[2], rel.replace(/\.html?$/i, '.js'), lineAt(m.index! + m[0].indexOf('>') + 1));
    if (found === null) continue;
    checked = true;
    problems.push(...found);
  }
  for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    checked = true;
    problems.push(...cssProblems(m[1], false, lineAt(m.index! + m[0].indexOf('>') + 1)));
  }
  return checked ? problems : [];
}

/** An interpreter on PATH, remembered per process (null = not installed). */
const interpreters = new Map<string, string | null>();
function interpreter(candidates: string[], probeArgs: string[]): string | null {
  const key = candidates.join('|');
  if (!interpreters.has(key)) {
    let found: string | null = null;
    for (const name of candidates) {
      const probe = spawnSync(name, probeArgs, { encoding: 'utf8', timeout: 5000, windowsHide: true });
      // the Windows Store "python" stub exits with 9009 and prints an install hint
      if (!probe.error && probe.status === 0) { found = name; break; }
    }
    interpreters.set(key, found);
  }
  return interpreters.get(key) ?? null;
}

const PY_CHECK = [
  'import sys, ast',
  'src = sys.stdin.buffer.read().decode("utf-8", "replace")',
  'try:',
  '    ast.parse(src)',
  'except SyntaxError as e:',
  '    print("%s\\t%s" % (e.lineno or 1, e.msg))',
  '    sys.exit(3)',
].join('\n');

function pythonProblems(text: string): SyntaxProblem[] | null {
  const py = interpreter(['python', 'python3', 'py'], ['-c', 'import ast']);
  if (!py) return null;
  const run = spawnSync(py, ['-c', PY_CHECK], { input: text, encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (run.error || (run.status !== 0 && run.status !== 3)) return null;
  if (run.status === 0) return [];
  const [line, message] = String(run.stdout).trim().split('\t');
  return [{ line: Number(line) || 1, message: message || 'syntax error' }];
}

function phpProblems(text: string): SyntaxProblem[] | null {
  const php = interpreter(['php'], ['-v']);
  if (!php) return null;
  const run = spawnSync(php, ['-l'], { input: text, encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (run.error) return null;
  if (run.status === 0) return [];
  const out = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  const m = /(?:Parse|Fatal) error:\s*(.+?) in .*? on line (\d+)/i.exec(out);
  return m ? [{ line: Number(m[2]), message: m[1].trim() }] : null;
}

/** Syntax problems of `text` as the content of `rel`; null when this kind of file is not checked. */
export function syntaxProblems(rel: string, text: string): SyntaxProblem[] | null {
  const name = rel.toLowerCase();
  if (SCRIPT_EXT.test(name)) return scriptProblems(text, rel);
  if (/\.json$/.test(name)) return jsonProblems(text);
  if (/\.css$/.test(name)) return cssProblems(text, false);
  if (/\.(scss|less)$/.test(name)) return cssProblems(text, true);
  if (/\.html?$/.test(name)) return htmlProblems(text, rel);
  if (/\.pyw?$/.test(name)) return pythonProblems(text);
  if (/\.php$/.test(name)) return phpProblems(text);
  return null;
}

/** "line 12: ';' expected → `  const a = `" — the problem with the text of its line. */
export function describeProblems(text: string, problems: SyntaxProblem[], max = 5): string {
  const lines = text.split(/\r?\n/);
  return problems.slice(0, max).map((p) => {
    const src = (lines[p.line - 1] ?? '').trim().slice(0, 160);
    return `- line ${p.line}: ${p.message}${src ? `  →  ${src}` : ''}`;
  }).join('\n') + (problems.length > max ? `\n- … ${problems.length - max} more` : '');
}

export interface WriteVerdict {
  /** The write must not happen; the text tells the model why. */
  reject?: string;
  /** The write happens; the text is added to the tool result. */
  warn?: string;
}

/**
 * Judge a write before it lands. Changing a file (overwrite, replace) that would add syntax errors is
 * refused and the file stays as it is. A new file or an append only gets a warning: big files are
 * written in parts, and the first part of a file is often incomplete on purpose.
 */
export function vetWrite(rel: string, before: string | null, after: string, mode: 'create' | 'overwrite' | 'append' | 'replace'): WriteVerdict {
  const now = syntaxProblems(rel, after);
  if (!now || now.length === 0) return {};
  const was = before === null ? [] : syntaxProblems(rel, before) ?? [];
  if (now.length <= was.length) return {};
  const list = describeProblems(after, now);
  if (before !== null && (mode === 'overwrite' || mode === 'replace') && was.length === 0) {
    return {
      reject:
        `REJECTED: this change would break ${rel} (syntax errors), so the file is NOT changed:\n${list}\n` +
        (mode === 'replace'
          ? 'Fix `replace` so the code stays valid (brackets, quotes, tags closed) and call replace_in_file again.'
          : 'Send the corrected full content, or change only the needed part with replace_in_file.'),
    };
  }
  return {
    warn: `WARNING: ${rel} does not parse now:\n${list}\n` +
      (mode === 'append' || mode === 'create'
        ? 'If you are writing it in parts, go on with append_file; otherwise fix these lines now.'
        : 'Fix these lines now.'),
  };
}
