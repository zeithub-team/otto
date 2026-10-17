/**
 * The project tools of Otto's own agent loop: their specs for the models, the aliases models invent,
 * and what each one does. Every file change goes through the same checks before it lands: the parser
 * (codecheck.ts) and the run's rules (runguard.ts EditSession).
 *
 * Tools of other kinds — shell, Docker, SSH, connectors, the app itself — live in their own modules
 * (agentbridge.ts, connectors.ts, apptools.ts) and are listed here for the model alongside these.
 */
import * as fs from 'fs';
import * as path from 'path';
import { WEB_TOOLS } from './web';
import { asFunctionTool, sshTools } from './agentbridge';
import { connectorTools } from './connectors';
import { appTools } from './apptools';
import { deltaTag, lineDelta } from './changes';
import { sliceFile } from './context';
import { syntaxProblems, vetWrite } from './codecheck';
import type { EditSession } from './runguard';
import { isDirectory, isFile, isInside, relativePosix, resolvePath } from './paths';

/** Python `len(str)` counts code points, not UTF-16 units. */
export function strLen(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

/** Sort helper: Python's `key=lambda p: (not p.is_dir(), p.name.lower())`. */
export function compareEntries(
  a: { name: string; isDirectory(): boolean },
  b: { name: string; isDirectory(): boolean },
): number {
  const dirFirst = Number(a.isDirectory() === false) - Number(b.isDirectory() === false);
  if (dirFirst !== 0) return dirFirst;
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

export const MAX_FILE_SIZE = 1_000_000;
/** Cap for one read_file result; set per model window right before each tool call. */
let readLimit = 12000;
export const setReadLimit = (chars: number): void => { readLimit = chars; };
// (.otto holds Otto's own files: checkpoints with old copies of the project's files)
const TOOL_SKIP_DIRS = new Set(['.git', '.next', 'node_modules', '.venv', '.otto']);

/**
 * Files that must not be deleted by the agent — doing so breaks the project and is
 * almost always a model mistake. Returns a human-readable reason, or null if the file
 * is not protected. Only the basename is checked: the protection applies at any depth.
 */
export function isProtectedFile(rel: string): string | null {
  const base = rel.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  const CRITICAL: Record<string, string> = {
    // JS / Node
    'package.json': 'npm manifest', 'package-lock.json': 'npm lockfile', 'yarn.lock': 'yarn lockfile',
    'pnpm-lock.yaml': 'pnpm lockfile', 'tsconfig.json': 'TypeScript config',
    // PHP / Laravel
    'composer.json': 'Composer manifest', 'composer.lock': 'Composer lockfile', 'artisan': 'Laravel CLI',
    // Python
    'pyproject.toml': 'Python project config', 'setup.py': 'Python setup', 'setup.cfg': 'Python setup',
    'requirements.txt': 'pip dependencies', 'pipfile': 'Pipfile', 'pipfile.lock': 'Pipfile lock',
    'poetry.lock': 'Poetry lockfile',
    // Ruby
    'gemfile': 'Bundler manifest', 'gemfile.lock': 'Bundler lockfile', 'rakefile': 'Rake tasks',
    // Go / Rust / Java
    'go.mod': 'Go module', 'go.sum': 'Go checksum', 'cargo.toml': 'Rust manifest', 'cargo.lock': 'Rust lockfile',
    'pom.xml': 'Maven POM', 'build.gradle': 'Gradle build', 'build.gradle.kts': 'Gradle build',
    // Environment & config
    '.env': 'environment config', '.env.local': 'local env config',
    '.gitignore': 'Git ignore rules', '.dockerignore': 'Docker ignore rules',
    'dockerfile': 'Docker build', 'docker-compose.yml': 'Docker Compose', 'docker-compose.yaml': 'Docker Compose',
    'makefile': 'make targets',
  };
  return CRITICAL[base] ?? null;
}

/** Read-only tools eligible for repeat short-circuiting in the agent loop. */
export const READ_ONLY_TOOLS = new Set([
  'read_skill_file',
  'list_files',
  'read_file',
  'read_files',
  'search_files',
  'web_search',
  'fetch_url',
]);

/** `_safe_path()` — keep tool paths inside the project root. */
export function safePath(root: string, relativePath: string): string {
  const target = resolvePath(path.resolve(root, relativePath ?? ''));
  if (!isInside(root, target)) {
    throw new Error('Path is outside the selected project');
  }
  return target;
}

/** Tool names models commonly invent → the real tool. */
const TOOL_ALIASES: Record<string, string> = {
  create_file: 'write_file',
  edit_file: 'write_file',
  write: 'write_file',
  save_file: 'write_file',
  overwrite_file: 'write_file',
  str_replace: 'replace_in_file',
  replace: 'replace_in_file',
  replace_text: 'replace_in_file',
  search_replace: 'replace_in_file',
  read: 'read_file',
  open_file: 'read_file',
  cat: 'read_file',
  ls: 'list_files',
  list_dir: 'list_files',
  list_directory: 'list_files',
  grep: 'search_files',
  search: 'search_files',
  remove_file: 'delete_file',
  search_web: 'web_search',
  browse: 'fetch_url',
  open_url: 'fetch_url',
};

/** Argument names models commonly use → the canonical ones. */
const PARAM_ALIASES: Record<string, string> = {
  file_path: 'path',
  filepath: 'path',
  filename: 'path',
  file: 'path',
  file_name: 'path',
  old_str: 'find',
  old_string: 'find',
  old_text: 'find',
  search_text: 'find',
  new_str: 'replace',
  new_string: 'replace',
  new_text: 'replace',
  replacement: 'replace',
  directory: 'path',
  dir: 'path',
  text: 'content',
  code: 'content',
  contents: 'content',
  file_content: 'content',
  body: 'content',
  q: 'query',
  search: 'query',
  pattern: 'query',
  link: 'url',
  href: 'url',
};

/** Canonical tool name + object arguments (JSON strings parsed, aliases mapped). */
export function normalizeToolCall(
  name: string,
  args: unknown,
): { name: string; args: unknown } {
  const canonical = TOOL_ALIASES[name] ?? name;
  let parsed = args;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { name: canonical, args: parsed };
    }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const mapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const target = PARAM_ALIASES[key];
      // never let an alias overwrite an explicitly provided canonical key
      mapped[target && !(target in (parsed as object)) ? target : key] = value;
    }
    parsed = mapped;
  }
  return { name: canonical, args: parsed };
}

/** `_run_read_tool()` — the project tools available to model steps.
 *  Exported for unit tests (search/write semantics must stay honest). */
const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|css|scss|less|json|php|java|c|cc|cpp|h|cs|go|rs|kt|swift|dart|vue|svelte)$/i;

/** How unbalanced the brackets are (0 = every opening one is closed). */
function bracketDebt(text: string): number {
  let debt = 0;
  for (const [o, c] of [['{', '}'], ['(', ')'], ['[', ']']]) debt += Math.abs(text.split(o).length - text.split(c).length);
  return debt;
}

/**
 * Damage a write leaves behind, told to the model in the tool result so it repairs it at once (any model,
 * guided or not): an empty code file, brackets that no longer match, most of a file thrown away.
 */
export function writeWarnings(rel: string, before: string | null, after: string, parsed = false): string {
  const out: string[] = [];
  if (!after.trim() && (CODE_EXT.test(rel) || /\.(html?|py|md|txt)$/i.test(rel))) out.push(`WARNING: ${rel} is EMPTY now — write its full content.`);
  // (a file the parser checks got the exact lines from vetWrite already)
  if (!parsed && after.trim() && CODE_EXT.test(rel) && bracketDebt(after) > (before === null ? 0 : bracketDebt(before))) {
    out.push(`WARNING: the brackets in ${rel} do not match now ({ } ( ) [ ]) — a closing or opening bracket was lost. read_file it and fix that.`);
  }
  if (before !== null) {
    const lines = (t: string) => t.split(/\r?\n/).filter((l) => l.trim()).length;
    const was = lines(before);
    const now = lines(after);
    if (was >= 4 && now < was * 0.5) {
      out.push(`WARNING: ${rel} had ${was} lines, now ${now} — most of the file was removed. If only a part was meant to change, put the rest back (write_file the whole file) or use replace_in_file.`);
    }
    // a page rewritten by a small model silently loses finished blocks (the menu, the form…): name them
    if (/\.html?$/i.test(rel)) {
      const count = (t: string, re: RegExp) => (t.match(re) ?? []).length;
      const lost: string[] = [];
      const checks: Array<[string, RegExp]> = [
        ['form', /<form\b/gi], ['sections', /<section\b/gi], ['headings', /<h[1-3]\b/gi], ['list items', /<li\b/gi],
        ['prices', /\d+[.,]?\d*\s?(₼|AZN|TMT|ман|руб|₽|\$|€)/gi], ['scripts', /<script\b/gi], ['stylesheets', /<link[^>]+stylesheet/gi],
      ];
      for (const [name, re] of checks) {
        const b = count(before, re);
        const a = count(after, re);
        if (b > a) lost.push(`${name} ${b}→${a}`);
      }
      if (lost.length) out.push(`WARNING: this rewrite of ${rel} REMOVED finished parts (${lost.join(', ')}). The user did not ask for that: put them back now (write_file the full page with everything that was there plus the new part). For small changes use replace_in_file instead of rewriting the page.`);
    }
  }
  return out.length ? `\n${out.join('\n')}\n` : '';
}

export function runTool(
  root: string,
  name: string,
  args: unknown,
  onCreateTask?: (title: string, detail: string) => void,
  onPlanTask?: (title: string, steps: string[]) => void,
  session?: EditSession,
): string {
  const normalized = normalizeToolCall(name, args);
  name = normalized.name;
  args = normalized.args;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return `Tool failed: ${name} expects an object with named arguments (JSON), got ${typeof args}`;
  }
  const params = args as Record<string, unknown>;

  if (name === 'list_files') {
    const relativePath = String(params.path ?? '');
    const target = safePath(root, relativePath);
    if (!isDirectory(target)) return 'Folder not found';
    const items = fs
      .readdirSync(target, { withFileTypes: true })
      .map((entry) => ({ entry, fullPath: path.join(target, entry.name) }))
      .sort((a, b) => compareEntries(a.entry, b.entry));
    const rows: string[] = [];
    for (const item of items) {
      if (TOOL_SKIP_DIRS.has(item.entry.name)) continue;
      rows.push(
        (item.entry.isDirectory() ? 'folder' : 'file') +
          '  ' +
          relativePosix(root, item.fullPath),
      );
    }
    return rows.slice(0, 300).join('\n') || 'Folder is empty';
  }

  if (name === 'read_file') {
    const relativePath = String(params.path ?? '');
    const target = safePath(root, relativePath);
    if (!isFile(target)) return 'File not found';
    if (fs.statSync(target).size > MAX_FILE_SIZE) {
      return 'File exceeds 1 MB and was not read';
    }
    // strict UTF-8 decoding — Python's read_text() raises on invalid bytes
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(target));
    session?.noteRead(relativePosix(root, target));
    return sliceFile(text, readLimit, Number(params.start_line) || undefined, Number(params.end_line) || undefined);
  }

  if (name === 'search_files') {
    const query = String(params.query ?? '').trim();
    if (!query) return "Usage: search_files requires 'query'";
    // Case-insensitive multi-word content search with RELEVANCE RANKING:
    // all words must appear in a file (AND), every matching line is scored
    // by how many query words it contains, and only then cut to the output
    // cap. Without ranking, root-level noise (.aider.chat.history.md) used
    // to win alphabetically and bury the real match. Binary files (NUL bytes
    // or mojibake-heavy) and tooling logs are never scanned.
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const searchSkip = new Set([
      ...TOOL_SKIP_DIRS,
      'dist', 'build', 'out', 'coverage',
      '__pycache__', '.cache', '.idea', '.vscode', '.turbo', '.output',
    ]);
    type Cand = { lineScore: number; fileScore: number; rel: string; ln: number; text: string };
    const cand: Cand[] = [];
    const partial: { n: number; rel: string }[] = [];
    let scanned = 0;
    const visit = (folder: string): void => {
      if (scanned > 4000 || cand.length >= 400) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(folder, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
      const dirs: string[] = [];
      for (const entry of entries) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          if (searchSkip.has(entry.name)) continue;
          dirs.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        // Tooling noise: aider session histories read like project prose.
        if (entry.name.startsWith('.aider') || /\.(log|bak)$/.test(entry.name)) continue;
        scanned++;
        let buf: Buffer;
        try {
          if (fs.statSync(full).size > 1_000_000) continue;
          buf = fs.readFileSync(full);
        } catch {
          continue;
        }
        if (buf.includes(0)) continue; // binary (NUL byte)
        const text = buf.toString('utf8');
        // Non-fatal utf8 decoding turns binary into U+FFFD soup — skip it.
        const bad = (text.match(/\uFFFD/g) || []).length;
        if (bad > text.length * 0.01) continue; // mojibake-heavy binary
        // Generated/minified output (bundler chunks, tsbuildinfo) is one giant
        // line per file: its word soup always "matches" and buries real code.
        const probeLines = text.split('\n', 50);
        const avgLen =
          probeLines.reduce((sum, l) => sum + l.length, 0) / probeLines.length;
        if (avgLen > 300) continue;
        const lower = text.toLowerCase();
        const fileScore = terms.filter((t) => lower.includes(t)).length;
        if (fileScore === 0) continue;
        const rel = relativePosix(root, full);
        if (fileScore === terms.length) {
          text.split('\n').forEach((line, idx) => {
            if (cand.length >= 400) return;
            const lineScore = terms.filter((t) => line.toLowerCase().includes(t)).length;
            if (lineScore > 0) {
              cand.push({ lineScore, fileScore, rel, ln: idx + 1, text: line.trim() });
            }
          });
        } else if (terms.length > 1 && partial.length < 30) {
          partial.push({ n: fileScore, rel });
        }
      }
      for (const dir of dirs) {
        if (scanned > 4000 || cand.length >= 400) return;
        visit(dir);
      }
    };
    visit(root);
    if (cand.length) {
      cand.sort(
        (a, b) =>
          b.lineScore - a.lineScore ||
          b.fileScore - a.fileScore ||
          a.rel.localeCompare(b.rel) ||
          a.ln - b.ln,
      );
      const lines = cand
        .slice(0, 60)
        .map((c) => `${c.rel}:${c.ln}: ${c.text.slice(0, 160)}`);
      partial.sort((a, b) => b.n - a.n || a.rel.localeCompare(b.rel));
      const tail = partial.length
        ? `\n\nЧастичные совпадения (не все слова): ${partial
            .slice(0, 15)
            .map((p) => p.rel)
            .join(', ')}`
        : '';
      return lines.join('\n') + tail;
    }
    if (partial.length) {
      partial.sort((a, b) => b.n - a.n || a.rel.localeCompare(b.rel));
      return `Нет файлов со всеми словами. Частичные совпадения:\n${partial
        .slice(0, 15)
        .map((p) => p.rel)
        .join('\n')}`;
    }
    return `No files containing '${query}'`;
  }

  if (name === 'write_file' || name === 'append_file') {
    const relativePath = String(params.path ?? '');
    if (!relativePath) {
      return `Usage: ${name} requires 'path'`;
    }
    // A missing 'content' must NEVER be treated as an empty file: that would
    // silently wipe an existing file. (An explicit empty string is fine.)
    if (typeof params.content !== 'string') {
      return `Ошибка: ${name} вызван без 'content' — файл НЕ изменён. Повтори вызов с полным содержимым в параметре content.`;
    }
    const content = params.content;
    // Compaction leaves "[записано N симв., …]" stubs in old tool calls; a model
    // that imitates one must not overwrite a real file with the placeholder.
    if (/^\s*\[(записано \d+|результат убран)/.test(content) && content.length < 400) {
      return `Ошибка: content — это служебная пометка о сжатии контекста, а не содержимое файла; файл НЕ изменён. Передай настоящий полный текст.`;
    }
    const target = safePath(root, relativePath);
    const rel = relativePosix(root, target);
    const existed = fs.existsSync(target);
    const prevSize = existed ? fs.statSync(target).size : null;
    let before: string | null = null;
    if (existed && (prevSize ?? 0) <= MAX_FILE_SIZE) {
      try {
        before = fs.readFileSync(target, 'utf8');
      } catch {
        before = null;
      }
    }
    // the parser's verdict (vetWrite) and the run's rules (session) come BEFORE the file is touched
    if (name === 'append_file') {
      const after = (before ?? '') + content;
      const vet = vetWrite(rel, before, after, 'append');
      const refused = vet.reject ?? session?.check(name, rel, before, after);
      if (refused) return refused;
      if (!existed) fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, content, 'utf8');
      session?.noteWrite(rel);
      return `Appended to ${rel} (+${strLen(content)} bytes, now ${fs.statSync(target).size} bytes)${vet.warn ? `\n${vet.warn}\n` : ''}${deltaTag(lineDelta('', content).added, 0)}`;
    }
    if (before !== null && before === content) {
      session?.noteWrite(rel);
      return `No change: ${rel} already has exactly this content; nothing was written. Go on with the next step.`;
    }
    const vet = vetWrite(rel, before, content, existed ? 'overwrite' : 'create');
    const refused = vet.reject ?? session?.check(name, rel, before, content);
    if (refused) return refused;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    session?.noteWrite(rel);
    const delta = lineDelta(before ?? '', content);
    const warn = vet.warn ? `\n${vet.warn}\n` : '';
    const parsed = syntaxProblems(rel, '') !== null;
    // Distinguish overwrite from creation: when the model believes it is
    // editing an existing file, "File CREATED" means it got the path wrong
    // (a hallucinated path otherwise silently spawns a bogus file).
    if (existed) {
      return `File overwritten: ${rel} (${strLen(content)} bytes, was ${prevSize} bytes)${warn}${writeWarnings(rel, before, content, parsed)}${deltaTag(delta.added, delta.removed)}`;
    }
    return `File CREATED (новый файл): ${rel} (${strLen(content)} bytes). Если файл должен был существовать — путь неверен: проверь list_files родительской папки и повтори запись по верному пути.${warn}${writeWarnings(rel, null, content, parsed)}${deltaTag(delta.added, 0)}`;
  }

  if (name === 'replace_in_file') {
    const relativePath = String(params.path ?? '');
    const find = typeof params.find === 'string' ? params.find : '';
    const replace = typeof params.replace === 'string' ? params.replace : '';
    if (!relativePath || !find) return "Usage: replace_in_file requires 'path', 'find' and 'replace'";
    const target = safePath(root, relativePath);
    if (!fs.existsSync(target)) return `File not found: ${relativePath} — check the path with list_files.`;
    const before = fs.readFileSync(target, 'utf8');
    const rel = relativePosix(root, target);
    const all = params.all === true || params.all === 'true';
    let after: string | null = null;
    if (before.includes(find)) {
      after = all ? before.split(find).join(replace) : before.replace(find, () => replace);
    } else {
      // small models get spaces / line breaks slightly wrong: match the text with any whitespace
      const words = find.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (words.length && words[0]) {
        const loose = new RegExp(words.join('\\s+'), all ? 'g' : '');
        if (loose.test(before)) after = before.replace(loose, () => replace);
      }
    }
    if (after === null) {
      // the longest real word of `find` that the file has (tags and punctuation are not words)
      const key = (find.match(/[\p{L}\p{N}_-]{3,}/gu) ?? []).sort((a, b) => b.length - a.length).find((w) => before.includes(w)) ?? '';
      const near = key ? before.split(/\r?\n/).map((l, i) => ({ l, i })).filter((x) => x.l.includes(key)).slice(0, 5) : [];
      return `Text not found in ${rel}; the file is NOT changed.` +
        (near.length ? ` Lines with "${key}":\n${near.map((x) => `${x.i + 1}: ${x.l.trim().slice(0, 200)}`).join('\n')}\nCopy the exact text from there into 'find'.` : ' read_file it and copy the exact text into \'find\'.');
    }
    if (after === before) return `No change: in ${rel} the text already reads like that; nothing was written.`;
    const vet = vetWrite(rel, before, after, 'replace');
    const refused = vet.reject ?? session?.check(name, rel, before, after);
    if (refused) return refused;
    fs.writeFileSync(target, after, 'utf8');
    session?.noteWrite(rel);
    const delta = lineDelta(before, after);
    return `Replaced in ${rel} (${strLen(after)} bytes)${vet.warn ? `\n${vet.warn}\n` : ''}${writeWarnings(rel, before, after, syntaxProblems(rel, '') !== null)}${deltaTag(delta.added, delta.removed)}`;
  }

  if (name === 'delete_file' || name === 'delete_path') {
    const relativePath = String(params.path ?? '');
    if (!relativePath) return "Usage: delete_file requires 'path'";
    const target = safePath(root, relativePath);
    if (target === root) return 'Refusing to delete the project root';
    if (!fs.existsSync(target)) return 'Path not found';
    const rel = relativePosix(root, target);
    const wasDir = fs.statSync(target).isDirectory();
    // Protect critical project files: deleting these breaks the project and is almost always a mistake.
    if (!wasDir) {
      const blocked = isProtectedFile(rel);
      if (blocked) return `REJECTED: ${rel} is a critical project file (${blocked}) and must not be deleted. If you need to change it, use replace_in_file.`;
    }
    let removedLines = 0;
    if (!wasDir && fs.statSync(target).size <= MAX_FILE_SIZE) {
      try {
        removedLines = lineDelta(fs.readFileSync(target, 'utf8'), '').removed;
      } catch {
        removedLines = 0;
      }
    }
    fs.rmSync(target, { recursive: true, force: true });
    return `Deleted ${wasDir ? 'folder' : 'file'}: ${rel}${wasDir ? '' : deltaTag(0, removedLines)}`;
  }

  if (name === 'create_task') {
    const title = String(params.title ?? '').trim();
    const detail = typeof params.detail === 'string' ? params.detail : '';
    if (!title) return "Usage: create_task requires 'title'";
    if (!onCreateTask) return 'Task board is not available';
    onCreateTask(title, detail);
    return `Task created: ${title}`;
  }

  if (name === 'plan_task') {
    const title = String(params.title ?? '').trim();
    const rawSteps = params.steps;
    let steps: unknown = rawSteps;
    if (typeof rawSteps === 'string') {
      // a model may send the list as a JSON string or as "1. …\n2. …" lines
      try {
        steps = JSON.parse(rawSteps);
      } catch {
        steps = rawSteps.split('\n');
      }
    }
    const list = (Array.isArray(steps) ? steps : [])
      .map((s) => String(s).replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 20);
    if (!title || list.length === 0) return "Usage: plan_task requires 'title' and a non-empty 'steps' array";
    if (!onPlanTask) return 'Task board is not available';
    onPlanTask(title, list);
    return `План создан: «${title}», этапов: ${list.length}. Он появился на панели задач — выполнять по этапам можно кнопкой «Выполнить».`;
  }

  return 'Unknown tool';
}

/** The shell run_command uses on this OS (see shell.ts), named for the models. */
export const SHELL_NAME = process.platform === 'win32' ? 'Windows: PowerShell' : process.platform === 'darwin' ? 'macOS: sh, zsh-compatible' : 'Linux: sh';

export function workspaceTools(webEnabled = true): unknown[] {
  const tool = (
    name: string,
    description: string,
    params: Record<string, unknown>,
    optional: string[] = [],
  ) => ({
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: params,
        required: Object.keys(params).filter((key) => !optional.includes(key)),
      },
    },
  });

  return [
    tool(
      'list_files',
      "List files and folders in the selected project. path: relative path like 'src' or '' for root",
      {
        path: {
          type: 'string',
          description: 'Relative path from project root',
        },
      },
    ),
    tool(
      'read_file',
      'Read a UTF-8 text file. Long files are returned in parts: use start_line/end_line to read the next part.',
      {
        path: { type: 'string', description: 'Relative path to the file' },
        start_line: { type: 'number', description: 'First line to read (1-based)' },
        end_line: { type: 'number', description: 'Last line to read' },
      },
      ['start_line', 'end_line'],
    ),
    tool(
      'search_files',
      'Case-insensitive content search across project files (skips node_modules/dist). query: 2-3 lowercase words separated by spaces; all words must occur in a file. Returns matched lines as path:line: text, plus partial matches.',
      {
        query: {
          type: 'string',
          description: '2-3 words to find in file contents, e.g. "stop button"',
        },
      },
    ),
    tool(
      'web_search',
      'Search the internet (documentation, libraries, errors). query: search terms. Returns titles, URLs and snippets; open a result with fetch_url.',
      {
        query: { type: 'string', description: 'Search query' },
      },
    ),
    tool(
      'fetch_url',
      'Download a web page (http/https) and return its readable text. url: full address, e.g. a link from web_search.',
      {
        url: { type: 'string', description: 'Full http(s) URL' },
      },
    ),
    tool(
      'write_file',
      'Create a NEW file, or rewrite a whole file you have read in this run. path: relative path, content: the complete file. To change part of an existing file use replace_in_file instead. A write that would break the syntax of a working file, or drop most of it, is REJECTED and the file stays as it was.',
      {
        path: {
          type: 'string',
          description: 'Relative path from project root',
        },
        content: { type: 'string', description: 'Content to write' },
      },
    ),
    tool(
      'plan_task',
      'Create a checklist plan on the task board for a LARGE multi-step job (3-10 concrete steps). title: overall goal; steps: ordered list of short, independently doable steps. Start a step with "∥ " when it touches DIFFERENT files than the step before it and does not need its result: those two then run in parallel. Use it BEFORE starting big work instead of trying to do everything in one go.',
      {
        title: { type: 'string', description: 'Overall goal' },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered concrete steps',
        },
      },
    ),
    tool(
      'append_file',
      'Append text to the end of a file (creates it if missing). Use for LARGE files: write_file the first part, then append_file the next parts, so no single call gets cut off.',
      {
        path: { type: 'string', description: 'Relative path from project root' },
        content: { type: 'string', description: 'Text to append' },
      },
    ),
    tool(
      'replace_in_file',
      'Change part of a file: replace the text `find` with `replace` (the rest of the file stays as it is). Best for small edits: a heading, a value, a few lines. find must be copied from the file (read_file first). all=true replaces every occurrence.',
      {
        path: { type: 'string', description: 'Relative path to the file' },
        find: { type: 'string', description: 'Exact text to replace (copied from the file)' },
        replace: { type: 'string', description: 'New text' },
        all: { type: 'boolean', description: 'Replace every occurrence (default: the first)' },
      },
      ['all'],
    ),
    tool(
      'delete_file',
      'Delete a file or folder (recursively) inside the project. path: relative path from project root',
      {
        path: { type: 'string', description: 'Relative path to delete' },
      },
    ),
    tool(
      'run_command',
      'Run ONE shell command in the project folder and get its output (' + SHELL_NAME + '). Use it for npm/pnpm/composer/pip, git, migrations and tests. For Docker Compose use Otto’s Docker integration (`otto_docker`) or write a normal `docker compose -f otto.compose.yaml ...` command; Otto routes supported Compose actions through its local Services API. The user may have to approve each command; never run destructive commands. timeout_seconds: up to 600 (default 120).',
      {
        command: { type: 'string', description: 'The command line to run' },
        timeout_seconds: { type: 'number', description: 'Time limit in seconds (default 120, max 600)' },
        background: { type: 'boolean', description: 'true for long-running commands (dev servers like npm run dev / php artisan serve, watchers, docker compose up without -d): it keeps running and you get its first output' },
      },
      ['timeout_seconds', 'background'],
    ),
    tool(
      'otto_docker',
      'Use Otto’s local Docker integration for this project. This sends the action through Otto’s own Services API, not through the agent shell. Use status/validate to inspect; use up to build/start otto.compose.yaml services; use runtime-up to build/start the configured devcontainer. down/runtime-down stop services. service-start/stop/restart/logs manage one compose service; provide service. Mutating actions follow the Agent → Terminal commands permission setting.',
      {
        action: { type: 'string', enum: ['status', 'validate', 'up', 'down', 'runtime-up', 'runtime-down', 'service-start', 'service-stop', 'service-restart', 'service-logs'], description: 'Otto Docker action' },
        service: { type: 'string', description: 'Compose service name for service-* actions' },
      },
      ['service'],
    ),
    tool(
      'create_task',
      'Add a task to the project task board (for follow-up work the user should see). title: short task name, detail: optional description',
      {
        title: { type: 'string', description: 'Short task title' },
        detail: { type: 'string', description: 'Optional longer description' },
      },
    ),
    tool(
      'preview_page',
      'Open a project HTML file in a REAL browser and report what is there: console/JS errors, horizontal overflow at desktop and 375px phone width, headings, buttons/forms, broken anchors and images, external resources; saves a screenshot. Call it after creating or changing a page. look=true also gets a design review of the screenshot from a vision model (slow, use once at the end).',
      {
        path: { type: 'string', description: 'Relative path to the .html file' },
        width: { type: 'number', description: 'Desktop viewport width (default 1280)' },
        look: { type: 'boolean', description: 'Also ask a vision model to review the screenshot' },
      },
      ['width', 'look'],
    ),
    tool(
      'run_in_page',
      'Run a scenario in the page in a real browser and get the result. script is the BODY of an async function: it can await and use $(sel), $$(sel), visible(el), wait(ms); alert() is captured. It must return a JSON value. Example: fill the email field, submit the form and return {successVisible: visible($(".success")), formVisible: visible($("form"))}. Use it to VERIFY forms, buttons, menus, tabs instead of assuming they work.',
      {
        path: { type: 'string', description: 'Relative path to the .html file' },
        script: { type: 'string', description: 'Body of an async function that returns a JSON-serialisable value' },
        width: { type: 'number', description: 'Viewport width (default 1280; use 375 to test the phone layout)' },
      },
      ['width'],
    ),
    tool(
      'use_skill',
      'Load a skill: a pack of expert rules for a kind of work (see the list of available skills in the system prompt). Call it BEFORE starting such work.',
      { name: { type: 'string', description: 'Skill name from the list' } },
    ),
    tool(
      'read_skill_file',
      'Read a file that comes with a skill (a reference, template or script listed by use_skill). name: skill name; path: file path inside the skill, e.g. "reference/forms.md".',
      { name: { type: 'string', description: 'Skill name' }, path: { type: 'string', description: 'File path inside the skill folder' } },
    ),
    ...sshTools.map(asFunctionTool),
    ...connectorTools().map(asFunctionTool),
    ...appTools(null).map(asFunctionTool),
  ].filter((spec) => {
    // Web tools are offered only while the composer's Web toggle is on
    const name = (spec as { function: { name: string } }).function.name;
    return webEnabled || !WEB_TOOLS.has(name);
  });
}

