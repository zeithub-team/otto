/**
 * Otto itself as tools, for every model (Otto's own agent loop and the Claude / Codex CLIs alike):
 * what the app can do and its current state, opening a section or the Preview, running the project in
 * the Preview, theme and language, safe settings, and SSH connections.
 *
 * Things that happen in the window (open a tab, switch the theme…) go out as `ui` actions through the
 * chat socket (`ctx.emitUi`); the page carries them out (useChat → `otto:ui` → page.tsx).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentTool } from './agentbridge';
import * as ssh from './sshclient';
import { detectRun, getRun, startRun, stopRun } from './runner';
import { live } from './appconfig';
import { serviceSummary } from './servicesummary';

let dataDir = '';
/** Where SSH keys and known hosts live (set once by index.ts). */
export function configureAppTools(opts: { dataDir: string }): void { dataDir = opts.dataDir; }

export interface AppToolContext {
  root: string;
  projectId: number | null;
  /** Send an action to the open Otto window; false when this run has no window (background agents). */
  emitUi: ((action: Record<string, unknown>) => boolean) | null;
}

export const VIEWS = ['chat', 'project', 'data', 'ssh', 'agents', 'services', 'models', 'plugins', 'connectors', 'settings', 'preview', 'docs', 'home'] as const;
export const SETTINGS_PAGES = ['general', 'models', 'agent', 'projects', 'terminal', 'permissions', 'server', 'about'] as const;
export const THEMES = ['emerald', 'ocean', 'violet', 'amber', 'light', 'dracula', 'nord', 'tokyo', 'onedark', 'gruvbox', 'catppuccin', 'solarized', 'solarized-light'] as const;
export const LANGUAGES = ['ru', 'en', 'az', 'ge', 'it', 'sp'] as const;
/** Settings a model may change; security switches (command / SSH permissions, port) stay the user's. */
export const AGENT_SETTABLE = ['agent.effort', 'agent.numCtx', 'agent.maxSteps', 'agent.parallelSteps', 'agent.web', 'terminal.shell', 'claude.cli', 'codex.cli'] as const;

/** What every model is told about Otto (system prompt). */
export const OTTO_GUIDE = [
  'You work inside zeithub.otto, a desktop IDE, and you can operate the app itself with the otto_* tools:',
  '- otto_about: what Otto has (sections, settings, services, SSH sessions, the running project) — call it when unsure.',
  '- otto_open: open a section for the user (chat, project=files, data=databases, ssh, agents, services=Docker, models, plugins, connectors, settings with a page, preview, docs).',
  '- otto_preview: show something in the Preview tab: mode=url for a running server (e.g. after `php artisan serve --port 8080` → http://127.0.0.1:8080), mode=file for an HTML page you generated, mode=run to start the project and show it, mode=stop. "Open in the browser / preview" always means this tab.',
  '- otto_appearance: change the colour theme or the interface language.',
  '- otto_settings: read settings or change the safe ones.',
  '- otto_tasks: the project\'s task list (the Tasks panel): list, add (one or many, e.g. imported from TASKS.md, with their status), update the status (todo / in_progress / done) or title, delete.',
  '- ssh_connect / ssh_disconnect: connect to a server (host, user, password or a saved key); then ssh_exec, ssh_list, ssh_read_file, ssh_write_file.',
  '- otto_docker: the project\'s Docker services (PostgreSQL, Redis…); run_command: shell commands in the project.',
  'When the user asks to run, show, open or switch something in Otto, do it with these tools instead of explaining how. Changes are approved by the user in the chat.',
  'Never paste code into the chat: code goes into project files (write_file), the chat gets a short summary.',
].join('\n');

/** http(s) only; 0.0.0.0 / [::] (what servers print) become 127.0.0.1, a bare host:port gets http://. */
export function normalizePreviewUrl(raw: string): string | null {
  let url = raw.trim();
  if (!url) return null;
  if (!/^[a-z]+:\/\//i.test(url)) url = `http://${url}`;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.hostname === '0.0.0.0' || u.hostname === '[::]' || u.hostname === '::') u.hostname = '127.0.0.1';
    return u.toString();
  } catch {
    return null;
  }
}

/** The first local address a dev server printed (php artisan serve, vite, next…), for the Preview. */
export function localServerUrl(output: string): string | null {
  const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?[^\s"'`)<>\]]*/i.exec(output);
  return m ? normalizePreviewUrl(m[0].replace(/[.,;]+$/, '')) : null;
}

/** The user asked to see the result. */
export const wantsPreview = (prompt: string): boolean => /превью|preview|покажи|показать|открой|открыть|önizlə|anteprima|vista previa|show|open/i.test(prompt);

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

async function internal(method: string, route: string, body?: unknown): Promise<unknown> {
  const base = process.env.OTTO_INTERNAL_API_URL;
  if (!base) throw new Error('Otto local API is unavailable');
  const res = await fetch(new URL(route, base), { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new Error(str(data.detail ?? data.error ?? res.statusText));
  return data;
}

function ui(ctx: AppToolContext | null, action: Record<string, unknown>): boolean {
  return Boolean(ctx?.emitUi?.(action));
}
const NO_WINDOW = ' (no Otto window is attached to this run, so nothing was shown — tell the user where to find it)';

/** A saved SSH key by id or name. */
function keyIdOf(ref: string): string | undefined {
  if (!ref) return undefined;
  const hit = ssh.listKeys(dataDir).find((k) => k.id === ref || k.name === ref);
  if (!hit) throw new Error(`No saved SSH key "${ref}". Keys: ${ssh.listKeys(dataDir).map((k) => k.name).join(', ') || 'none'}`);
  return hit.id;
}

/** `ctx` is null only when the schemas are listed. */
export function appTools(ctx: AppToolContext | null, approve?: (kind: 'shell' | 'ssh', text: string, always?: boolean) => Promise<string | null>): AgentTool[] {
  return [
    {
      name: 'otto_about',
      description: 'What Otto can do and its current state: sections, settings (values), the project\'s Docker services, open SSH sessions, saved SSH keys, the project run in the Preview.',
      properties: {},
      required: [],
      approval: () => null,
      run: async () => {
        const settings = await internal('GET', '/api/app-settings').catch(() => null) as { values?: Record<string, unknown> } | null;
        const svc = ctx?.projectId ? serviceSummary([{ id: ctx.projectId, path: ctx.root }]).projects[ctx.projectId] : undefined;
        const run = ctx?.projectId ? getRun(ctx.projectId) : null;
        return [
          OTTO_GUIDE,
          '',
          `Sections (otto_open view): ${VIEWS.join(', ')}. Settings pages: ${SETTINGS_PAGES.join(', ')}.`,
          `Themes: ${THEMES.join(', ')}. Languages: ${LANGUAGES.join(', ')}.`,
          `Settings: ${settings?.values ? JSON.stringify(settings.values) : 'unavailable'}. You may change: ${AGENT_SETTABLE.join(', ')}.`,
          `Project folder: ${ctx?.root ?? '-'}`,
          `Docker services: ${svc ? `${svc.running}/${svc.total} running — ${svc.services.map((s) => `${s.name}: ${s.state}`).join(', ') || 'none'}` : 'none declared (Services tab writes otto.compose.yaml)'}`,
          `Preview run: ${run ? `${run.status}${run.url ? ` at ${run.url}` : ''}${run.command ? ` (${run.command})` : ''}` : '-'}`,
          `SSH sessions: ${ssh.listSessions().map((s) => `${s.user}@${s.host}:${s.port}`).join(', ') || 'none'}`,
          `Saved SSH keys: ${dataDir ? ssh.listKeys(dataDir).map((k) => k.name).join(', ') || 'none' : '-'}`,
        ].join('\n');
      },
    },
    {
      name: 'otto_open',
      description: 'Open a section of Otto for the user. view: chat, project (files), data (databases), ssh, agents, services (Docker), models, plugins, connectors, settings (with page), preview, docs, home.',
      properties: {
        view: { type: 'string', enum: [...VIEWS], description: 'Section to open' },
        page: { type: 'string', enum: [...SETTINGS_PAGES], description: 'Settings page (view=settings)' },
      },
      required: ['view'],
      approval: () => null,
      run: async (a) => {
        const page = (SETTINGS_PAGES as readonly string[]).includes(str(a.page)) ? str(a.page) : undefined;
        // a settings page is only in Settings (small models pair "terminal" with another section)
        const view = page ? 'settings' : str(a.view);
        if (!(VIEWS as readonly string[]).includes(view)) return `Unknown section "${view}". Sections: ${VIEWS.join(', ')}`;
        return ui(ctx, { action: 'navigate', view, page }) ? `Opened ${view}${page ? ` → ${page}` : ''}.` : `Could not open ${view}${NO_WINDOW}.`;
      },
    },
    {
      name: 'otto_preview',
      description: 'The Preview tab. mode=url: show an address, e.g. the dev server you started with run_command (http://127.0.0.1:8080). mode=file: show an HTML file of the project (path relative to the project, e.g. "index.html" or a page you just generated). mode=run: start the project (dev server; command optional, otherwise the detected one) and show it. mode=stop: stop the running project.',
      properties: {
        mode: { type: 'string', enum: ['url', 'file', 'run', 'stop'], description: 'What to do' },
        url: { type: 'string', description: 'Address to show (mode=url)' },
        path: { type: 'string', description: 'HTML file (mode=file)' },
        command: { type: 'string', description: 'Start command (mode=run), e.g. "npm run dev"; detected when omitted' },
      },
      required: ['mode'],
      approval: (a) => {
        if (str(a.mode) !== 'run' || !ctx) return null;
        const found = detectRun(ctx.root);
        const command = str(a.command).trim() || found.options[0]?.command || '';
        return command ? { kind: 'shell', text: `Preview: ${command}` } : null;
      },
      run: async (a) => {
        if (!ctx?.projectId) return 'No project is selected.';
        const mode = str(a.mode);
        if (mode === 'url') {
          const url = normalizePreviewUrl(str(a.url));
          if (!url) return 'Give an http(s) address, e.g. http://127.0.0.1:8080';
          return ui(ctx, { action: 'preview-url', url }) ? `Showing ${url} in the Preview.` : `Could not show it${NO_WINDOW}.`;
        }
        if (mode === 'file') {
          const rel = str(a.path).replace(/^[\\/]+/, '');
          const full = path.resolve(ctx.root, rel);
          if (!rel || path.relative(ctx.root, full).startsWith('..')) return 'Give a file inside the project.';
          if (!fs.existsSync(full)) return `${rel} does not exist — write it first.`;
          return ui(ctx, { action: 'preview-file', path: rel.replace(/\\/g, '/') }) ? `Showing ${rel} in the Preview.` : `Saved, but${NO_WINDOW}.`;
        }
        if (mode === 'stop') {
          const state = stopRun(ctx.projectId);
          ui(ctx, { action: 'preview-refresh' });
          return `Stopped (${state.status}).`;
        }
        const found = detectRun(ctx.root);
        const typed = str(a.command).trim();
        const chosen = found.options.find((o) => o.command === typed) ?? (typed ? undefined : found.options[0]);
        const command = typed || chosen?.command || '';
        if (!command) {
          if (found.hasIndex) return ui(ctx, { action: 'preview-file', path: 'index.html' }) ? 'A static site: showing index.html in the Preview.' : `Static site${NO_WINDOW}.`;
          return 'Nothing to run: no start command detected. Give one (e.g. "npm run dev", "php artisan serve").';
        }
        startRun(ctx.projectId, ctx.root, command, chosen?.port ?? null);
        // the dev server needs a moment: report its address once it is up
        for (let i = 0; i < 40 && getRun(ctx.projectId).status === 'starting'; i++) await new Promise((r) => setTimeout(r, 500));
        const now = getRun(ctx.projectId);
        // the port is taken (an earlier run of the same project, usually): if a server answers there, that is the app
        if (!now.url) {
          const busy = /EADDRINUSE[^\n]*?:(\d{2,5})/.exec(now.log.join('\n'))?.[1] ?? (now.busy_port ? String(now.busy_port) : '');
          if (busy) {
            const probe = `http://127.0.0.1:${busy}/`;
            const up = await fetch(probe, { signal: AbortSignal.timeout(2500) }).then(() => true, () => false);
            if (up) now.url = probe;
          }
        }
        // the server's address goes to the Preview explicitly (the tab also picks the run up by itself)
        const shown = now.url
          ? ui(ctx, { action: 'preview-url', url: normalizePreviewUrl(now.url) ?? now.url })
          : ui(ctx, { action: 'navigate', view: 'preview' }) && ui(ctx, { action: 'preview-refresh' });
        return `Started "${command}": ${now.status}${now.url ? ` at ${now.url}` : ''}${shown ? ', shown in the Preview' : NO_WINDOW}.${now.status === 'exited' ? ` It stopped (exit code ${now.exit_code}) — output:\n${now.log.join('\n').slice(-3000)}` : ''}`;
      },
    },
    {
      name: 'otto_appearance',
      description: `Change Otto's colour theme (${THEMES.join(', ')}) and/or interface language (ru, en, az, ge=Georgian, it, sp=Spanish).`,
      properties: {
        theme: { type: 'string', enum: [...THEMES], description: 'Colour theme' },
        language: { type: 'string', enum: [...LANGUAGES], description: 'Interface language' },
      },
      required: [],
      approval: () => null,
      run: async (a) => {
        const done: string[] = [];
        const theme = str(a.theme);
        const language = str(a.language);
        if (theme) {
          if (!(THEMES as readonly string[]).includes(theme)) return `Unknown theme "${theme}". Themes: ${THEMES.join(', ')}`;
          if (ui(ctx, { action: 'theme', id: theme })) done.push(`theme ${theme}`);
        }
        if (language) {
          if (!(LANGUAGES as readonly string[]).includes(language)) return `Unknown language "${language}". Languages: ${LANGUAGES.join(', ')}`;
          if (ui(ctx, { action: 'locale', id: language })) done.push(`language ${language}`);
        }
        if (!theme && !language) return 'Give theme and/or language.';
        return done.length ? `Changed: ${done.join(', ')}.` : `Nothing changed${NO_WINDOW}.`;
      },
    },
    {
      name: 'otto_settings',
      description: `Read Otto's settings (no key = all) or change one. Changeable: ${AGENT_SETTABLE.join(', ')}. The user approves every change; command / SSH permissions are only changed by the user.`,
      properties: {
        key: { type: 'string', description: 'Setting key, e.g. agent.maxSteps' },
        value: { description: 'New value (string, number or boolean); omit to read' },
      },
      required: [],
      approval: (a) => (a.value === undefined ? null : { kind: 'shell', text: `Setting ${str(a.key)} = ${JSON.stringify(a.value)}`, always: true }),
      run: async (a) => {
        const key = str(a.key);
        const data = await internal('GET', '/api/app-settings') as { values: Record<string, unknown>; meta?: Array<{ key: string; options?: unknown[] }> };
        if (a.value === undefined) return key ? `${key} = ${JSON.stringify(data.values[key])}` : JSON.stringify(data.values, null, 1);
        if (!(AGENT_SETTABLE as readonly string[]).includes(key)) return `${key} can only be changed by the user (Settings). Changeable: ${AGENT_SETTABLE.join(', ')}`;
        const saved = await internal('PUT', '/api/app-settings', { values: { [key]: a.value } }) as { errors?: Record<string, string> };
        if (saved.errors?.[key]) return `Not saved: ${saved.errors[key]}`;
        ui(ctx, { action: 'settings-changed', key });
        return `${key} = ${JSON.stringify(a.value)} saved.`;
      },
    },
    {
      name: 'otto_tasks',
      description: 'The project\'s task list in Otto (Tasks panel next to the chat). action=list; action=add with items [{title, detail?, status?, parent_id?}] (many at once, e.g. everything from TASKS.md, done ones with status "done"); action=update with id and status (todo | in_progress | done) and/or title/detail; action=delete with id.',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'update', 'delete'], description: 'What to do' },
        items: {
          type: 'array',
          description: 'Tasks to add (action=add)',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              detail: { type: 'string' },
              status: { type: 'string', enum: ['todo', 'in_progress', 'done'] },
              parent_id: { type: 'number', description: 'Make it a step of this task' },
            },
            required: ['title'],
          },
        },
        id: { type: 'number', description: 'Task id (update / delete)' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done'] },
        title: { type: 'string' },
        detail: { type: 'string' },
      },
      required: ['action'],
      approval: (a) => (str(a.action) === 'delete' ? { kind: 'shell', text: `Delete task #${str(a.id)}`, always: true } : null),
      run: async (a) => {
        if (!ctx?.projectId) return 'No project is selected.';
        const pid = ctx.projectId;
        const action = str(a.action);
        type Task = { id: number; title: string; status: string; parent_id: number | null; detail?: string };
        if (action === 'list') {
          const list = await internal('GET', `/api/tasks?project_id=${pid}`) as Task[];
          if (!list.length) return 'The task list is empty.';
          const top = list.filter((t) => t.parent_id === null);
          return top.map((t) => [`#${t.id} [${t.status}] ${t.title}`, ...list.filter((x) => x.parent_id === t.id).map((x) => `   #${x.id} [${x.status}] ${x.title}`)].join('\n')).join('\n');
        }
        if (action === 'add') {
          const items = Array.isArray(a.items) ? a.items as Array<Record<string, unknown>> : (a.title ? [{ title: a.title, detail: a.detail, status: a.status }] : []);
          if (!items.length) return 'Give items: [{title, detail?, status?}].';
          const made: string[] = [];
          for (const it of items.slice(0, 200)) {
            const title = str(it.title).trim();
            if (!title) continue;
            const body: Record<string, unknown> = { project_id: pid, title, detail: str(it.detail) };
            if (Number.isInteger(Number(it.parent_id)) && it.parent_id !== undefined && it.parent_id !== null) body.parent_id = Number(it.parent_id);
            const task = await internal('POST', '/api/tasks', body) as Task;
            const status = str(it.status);
            if (status === 'done' || status === 'in_progress') await internal('PATCH', `/api/tasks/${task.id}`, { status });
            made.push(`#${task.id} [${status || 'todo'}] ${title}`);
          }
          ui(ctx, { action: 'tasks-changed' });
          return `Added ${made.length}:\n${made.join('\n')}`;
        }
        const id = Number(a.id);
        if (!Number.isInteger(id)) return 'Give the task id (see action=list).';
        if (action === 'update') {
          const patch: Record<string, unknown> = {};
          if (a.status !== undefined) patch.status = str(a.status);
          if (a.title !== undefined) patch.title = str(a.title);
          if (a.detail !== undefined) patch.detail = str(a.detail);
          if (!Object.keys(patch).length) return 'Nothing to change: give status, title or detail.';
          const task = await internal('PATCH', `/api/tasks/${id}`, patch) as Task;
          ui(ctx, { action: 'tasks-changed' });
          return `#${task.id} [${task.status}] ${task.title}`;
        }
        if (action === 'delete') {
          await internal('DELETE', `/api/tasks/${id}`);
          ui(ctx, { action: 'tasks-changed' });
          return `Deleted #${id}.`;
        }
        return 'action must be list, add, update or delete.';
      },
    },
    {
      name: 'ssh_connect',
      description: 'Connect to a server over SSH (it then appears in ssh_sessions and the ssh_* tools work on it). Give host, user and either password or key (a saved key\'s name; passphrase if it has one). The user approves the connection and must confirm a new server\'s host key.',
      properties: {
        host: { type: 'string', description: 'IP address or host name' },
        port: { type: 'number', description: 'Port (default 22)' },
        user: { type: 'string', description: 'User name' },
        password: { type: 'string', description: 'Password (if no key)' },
        key: { type: 'string', description: 'Name of a saved SSH key (Otto → SSH → keys)' },
        passphrase: { type: 'string', description: 'Passphrase of the key' },
      },
      required: ['host', 'user'],
      approval: (a) => ({ kind: 'ssh', text: `SSH connect ${str(a.user)}@${str(a.host)}:${Number(a.port) || 22}${a.key ? ` (key ${str(a.key)})` : a.password ? ' (password)' : ''}` }),
      run: async (a) => {
        if (!dataDir) return 'SSH is not available in this run.';
        const target: ssh.SshTarget = {
          host: str(a.host).trim(), port: Number(a.port) || 22, user: str(a.user).trim(),
          password: str(a.password) || undefined, keyId: keyIdOf(str(a.key)), passphrase: str(a.passphrase) || undefined,
        };
        try {
          const r = await ssh.connect(dataDir, target);
          return `Connected to ${target.user}@${target.host}:${target.port} (session ${r.id}). Use ssh_exec / ssh_list / ssh_read_file / ssh_write_file.`;
        } catch (exc) {
          if (exc instanceof ssh.HostKeyError) {
            if (exc.status === 'changed') return `The server's host key CHANGED (now ${exc.fingerprint}, was ${exc.saved}). This may be an attack; the user must check it in the SSH tab. Not connected.`;
            const refused = approve ? await approve('ssh', `New server ${target.host}:${target.port} — trust host key ${exc.fingerprint}?`, true) : 'No one to confirm the host key.';
            if (refused) return `Not connected: ${refused}`;
            const r = await ssh.connect(dataDir, { ...target, trust: exc.fingerprint });
            return `Connected to ${target.user}@${target.host}:${target.port} (session ${r.id}); its host key is now trusted.`;
          }
          throw exc;
        }
      },
    },
    {
      name: 'ssh_disconnect',
      description: 'Close an open SSH session (user@host or its id).',
      properties: { session: { type: 'string', description: 'user@host or id' } },
      required: ['session'],
      approval: () => null,
      run: async (a) => {
        const want = str(a.session);
        const hit = ssh.listSessions().find((s) => s.id === want || `${s.user}@${s.host}` === want || s.host === want);
        if (!hit) return `No open session "${want}".`;
        ssh.disconnect(hit.id);
        return `Disconnected ${hit.user}@${hit.host}.`;
      },
    },
  ];
}

// ---------------------------------------------------------------- fast path --

const THEME_WORDS: Array<[RegExp, string]> = [
  [/solari[sz]ed[\s-]*light|солярайз\w*\s*светл/i, 'solarized-light'], [/solari[sz]ed|солярайз/i, 'solarized'],
  [/emerald|изумруд/i, 'emerald'], [/ocean|океан/i, 'ocean'], [/violet|фиолет/i, 'violet'], [/amber|янтар/i, 'amber'],
  [/dracula|дракул/i, 'dracula'], [/\bnord\b|норд/i, 'nord'], [/tokyo|токио/i, 'tokyo'], [/one\s*dark|ван\s*дарк/i, 'onedark'],
  [/gruvbox|грувбокс/i, 'gruvbox'], [/catppuccin|каппучин|капучин/i, 'catppuccin'], [/\blight\b|светл/i, 'light'],
];
const LANG_WORDS: Array<[RegExp, string]> = [
  [/англ|english|ingilis/i, 'en'], [/русск|russian|rus dil/i, 'ru'], [/азерб|azerbaij|azərbaycan/i, 'az'],
  [/грузин|georgian|gürcü/i, 'ge'], [/итальян|italian/i, 'it'], [/испан|spanish/i, 'sp'],
];
const VIEW_WORDS: Array<[RegExp, string]> = [
  [/настройк|settings|parametr/i, 'settings'], [/сервис|services|docker/i, 'services'], [/модел|models/i, 'models'],
  [/агент|agents/i, 'agents'], [/плагин|plugins/i, 'plugins'], [/подключени|connectors/i, 'connectors'], [/\bssh\b|sftp/i, 'ssh'],
  [/баз[уыа]? данн|data\b|\bdata tab/i, 'data'], [/файл|files/i, 'project'], [/превью|preview/i, 'preview'],
  [/документац|справк|docs|help/i, 'docs'], [/(?<![а-яё])чат(?![а-яё])|\bchat\b/i, 'chat'],
];
const PAGE_WORDS: Array<[RegExp, string]> = [
  [/терминал|terminal/i, 'terminal'], [/разрешени|permission/i, 'permissions'], [/агент|agent/i, 'agent'],
  [/модел|model/i, 'models'], [/проект|project/i, 'projects'], [/сервер|server/i, 'server'], [/общ|general/i, 'general'], [/о программ|about/i, 'about'],
];
const first = <T>(list: Array<[RegExp, T]>, text: string): T | undefined => list.find(([re]) => re.test(text))?.[1];

/**
 * Plain app commands Otto carries out itself, with no model involved (instant and the same for every
 * model): theme, interface language, opening a section. Only when the whole message is such a command.
 */
export function routeAppCommand(prompt: string): Array<{ tool: string; args: Record<string, unknown> }> | null {
  const p = prompt.trim();
  if (!p || p.length > 120 || p.includes('\n')) return null;
  // anything that asks for work goes to the model
  if (/(созда|напиш|запуст|подним|исправ|почин|добав|удал|сгенер|сделай|установ|подключ|create|write|run\b|start|fix|add|delete|install|generate|connect|\?)/i.test(p)) return null;
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const wantsTheme = /(тем[уаеы](?![а-яё])|theme|цветов\w* схем|color scheme|mövzu)/i.test(p);
  const wantsLang = /(язык|language|\bdil\b)/i.test(p);
  if (wantsTheme || wantsLang) {
    const args: Record<string, unknown> = {};
    if (wantsTheme) { const t = first(THEME_WORDS, p); if (!t) return null; args.theme = t; }
    if (wantsLang) { const l = first(LANG_WORDS, p.slice(p.search(/язык|language|\bdil\b/i))); if (!l) return null; args.language = l; }
    calls.push({ tool: 'otto_appearance', args });
    return calls;
  }
  if (/^(открой|откройте|покажи|перейди|зайди|open|go to|show)(?![а-яёa-z])/i.test(p)) {
    const view = first(VIEW_WORDS, p);
    if (!view) return null;
    const page = view === 'settings' ? first(PAGE_WORDS, p.replace(/настройк\w*|settings/gi, '')) : undefined;
    calls.push({ tool: 'otto_open', args: page ? { view, page } : { view } });
    return calls;
  }
  return null;
}
