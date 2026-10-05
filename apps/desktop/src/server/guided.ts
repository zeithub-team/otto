/**
 * Guided mode: how a small local model works reliably.
 *
 * The model does not call tools by itself. Every turn Ollama constrains its reply with a JSON schema
 * (structured outputs), so the only thing it can produce is ONE action: {"action": "<tool>", "args": {…}}
 * or {"action": "answer", "args": {"text": …}}. That works even for models without the tools API, and
 * rules out the usual failures: calls written as prose, code pasted into the chat, broken JSON, invented
 * tool names. The model only sees the few tools the request needs (`pickGuidedTools`), and a short prompt.
 *
 * Otto's agent loop (ollama.ts) stays the same: a guided reply is turned into an ordinary tool call.
 */

export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }

/** Groups of tools by kind of request; `answer` is always there. */
const GROUPS: Record<string, string[]> = {
  app: ['otto_appearance', 'otto_open', 'otto_settings', 'otto_about'],
  tasks: ['otto_tasks'],
  services: ['otto_docker', 'run_command'],
  ssh: ['ssh_connect', 'ssh_sessions', 'ssh_exec', 'ssh_list', 'ssh_read_file', 'ssh_write_file', 'ssh_disconnect'],
  run: ['run_command', 'otto_preview', 'otto_docker', 'list_files', 'read_file'],
  code: ['list_files', 'read_file', 'search_files', 'replace_in_file', 'write_file', 'append_file', 'delete_file', 'otto_preview', 'use_skill', 'read_skill_file'],
  read: ['list_files', 'read_file', 'search_files'],
  // only offered while the chat's Web switch is on (the tool list itself is filtered by it)
  web: ['web_search', 'fetch_url'],
  // only offered while a service is connected (Connectors)
  connectors: ['connector_tools', 'connector_call'],
};

const KINDS: Array<[string, RegExp]> = [
  ['app', /(тем[уаеы](?![а-яё])|theme|цветов|язык\w* интерфейс|interface language|ui language|настройк|settings|раздел|вкладк|section|\btab\b|mövzu|dil)/i],
  ['tasks', /(задач|\btasks?\b|todo|тудушк|tapşırıq)/i],
  ['services', /(сервис|service|docker|postgres|mysql|maria|redis|mongo|rabbit|elastic|баз[уаы] данн|(?<![а-яё])бд(?![а-яё])|контейнер|container|compose)/i],
  ['ssh', /(\bssh\b|sftp|подключись к сервер|connect to (the )?server|\b\d{1,3}(\.\d{1,3}){3}\b)/i],
  ['run', /(запуст|подними|подним|\bstart\b|\brun\b|serve|превью|preview|покажи|показать|открой в браузер|dev[- ]?сервер|dev server|işə sal)/i],
  ['code', /(файл|file|код|code|html|css|\bjs\b|javascript|typescript|php|python|страниц|page|лендинг|landing|функци|function|компонент|component|исправ|почини|fix|замени|replace|измени|change|добав|add|создай|create|сгенерир|generate|напиши|write|верст|стил|style|удали|delete|remove|fayl)/i],
  ['connectors', /(figma|miro|jira|linear|asana|trello|notion|confluence|slack|github|gitlab|sentry|supabase|коннектор|connector|подключени[ея] (к )?сервис|issue|тикет|ticket|макет|дизайн|design|доск[уаеи]|board|пулл?.?реквест|pull request|\bpr\b|merge request)/i],
  ['web', /(интернет|в сети|поищи|найди в|загугли|погугли|гугл|search the web|web search|search online|online|google|актуальн|свеж|последн\w* верси|latest|новост|news|документаци|\bdocs?\b|курс (валют|доллар|евро)|погод|https?:\/\/|www\.)/i],
];

/** The tools a request needs (union of the matching groups). */
export function pickGuidedTools(prompt: string, available: string[]): string[] {
  const kinds = KINDS.filter(([, re]) => re.test(prompt)).map(([k]) => k);
  // "add a task" is about the task list, not about code
  if (kinds.includes('tasks') && kinds.includes('code') && !/(файл|file|код|code|html|функци|function)/i.test(prompt)) kinds.splice(kinds.indexOf('code'), 1);
  // a plain question: read-only tools; anything else unrecognised: work on the project
  const isQuestion = /(\?|^(что|как|почему|зачем|какой|какая|где|когда|сколько|what|how|why|which|where|when|nə|necə)(?![а-яёa-zəç]))/i.test(prompt.trim());
  // "what is Docker?" mentions a service but asks for nothing to be done: read-only tools
  const asksForWork = /(созда|напиш|запуст|подним|останов|исправ|почин|добав|удал|замени|поменя|смени|открой|покажи|сгенер|сделай|установ|подключ|create|write|run\b|start|stop|fix|add|delete|replace|change|open|show|generate|install|connect)/i.test(prompt);
  // (a web lookup stays: "what is the latest Laravel version?" needs it)
  if (isQuestion && !asksForWork) kinds.splice(0, kinds.length, ...kinds.filter((k) => k === 'web' || k === 'connectors'));
  if (!kinds.length) kinds.push(...(isQuestion ? ['read'] : ['code', 'run']));
  const names = new Set<string>();
  for (const k of kinds) for (const n of GROUPS[k]) names.add(n);
  return [...names].filter((n) => available.includes(n));
}

/** Short descriptions: a small model reads them every turn. */
const SHORT: Record<string, string> = {
  list_files: 'list files of a project folder. args: {path: "" for the root}',
  read_file: 'read a text file. args: {path}',
  search_files: 'find text in the project files. args: {query}',
  write_file: 'create or overwrite a file with the WHOLE content (code goes here, never into the answer). args: {path, content}',
  replace_in_file: 'change part of a file: the text `find` (copied exactly from read_file) becomes `replace`; the rest stays. Best for small edits. args: {path, find, replace}',
  append_file: 'add text to the end of a file (for long files: write_file the first part, then append_file the rest). args: {path, content}',
  delete_file: 'delete a file or folder of the project. args: {path}',
  web_search: 'search the internet; returns titles, links and snippets. args: {query}',
  fetch_url: 'read a web page (text). args: {url}',
  use_skill: 'load the rules of a skill listed in the system prompt before doing that kind of work. args: {name}',
  read_skill_file: 'read a file that comes with a skill. args: {name, path}',
  run_command: 'run ONE shell command in the project folder (Windows PowerShell). background=true for servers that keep running (php artisan serve, npm run dev). args: {command, background?}',
  otto_docker: 'the project\'s Docker services from otto.compose.yaml. args: {action: status|up|down|service-start|service-stop|service-restart|service-logs, service?}',
  otto_preview: 'show in Otto\'s Preview tab. args: {mode: "file", path} for an HTML file; {mode: "url", url} for a running server; {mode: "run"} to start the project and show it',
  otto_open: 'open a section of Otto. args: {view: chat|project|data|ssh|agents|services|models|plugins|connectors|settings|preview|docs, page?: terminal|agent|models|permissions|general|projects|server}',
  otto_appearance: 'change Otto\'s colour theme and/or interface language. args: {theme?, language?: ru|en|az|ge|it|sp}',
  otto_settings: 'read settings, or change one. args: {key?, value?}',
  otto_about: 'what Otto has and its current state. args: {}',
  otto_tasks: 'the project\'s task list. args: {action: "list"} | {action: "add", items: [{title, detail?, status?}]} | {action: "update", id, status: todo|in_progress|done} | {action: "delete", id}',
  ssh_connect: 'connect to a server over SSH. args: {host, user, password?, key?, port?}',
  ssh_sessions: 'list open SSH connections. args: {}',
  ssh_exec: 'run a command on a connected server. args: {session?, command}',
  connector_tools: 'list what a connected service (Figma, GitHub, Jira, Notion…) can do. args: {connector}',
  connector_call: 'call a tool of a connected service. args: {connector, tool, arguments: {…}}',
  ssh_list: 'list a folder on the server. args: {session?, path}',
  ssh_read_file: 'read a file on the server. args: {session?, path}',
  ssh_write_file: 'write a file on the server. args: {session?, path, content}',
  ssh_disconnect: 'close an SSH connection. args: {session}',
};

/** Loosen a tool's parameter schema for the grammar: keep names, types, enums and required fields. */
function argsSchema(parameters: Record<string, unknown>): Record<string, unknown> {
  const props = (parameters.properties ?? {}) as Record<string, Record<string, unknown>>;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    const p: Record<string, unknown> = {};
    if (v.type) p.type = v.type;
    if (Array.isArray(v.enum)) p.enum = v.enum;
    if (v.type === 'array') p.items = v.items ?? {};
    clean[k] = Object.keys(p).length ? p : {};
  }
  const required = Array.isArray(parameters.required) ? (parameters.required as string[]).filter((r) => r in clean) : [];
  return { type: 'object', properties: clean, required };
}

/** One of the allowed actions, or the final answer. */
export function guidedSchema(tools: ToolSpec[]): Record<string, unknown> {
  const options = tools.map((t) => ({
    type: 'object',
    properties: { action: { enum: [t.name] }, args: argsSchema(t.parameters) },
    required: ['action', 'args'],
  }));
  options.push({
    type: 'object',
    properties: { action: { enum: ['answer'] }, args: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    required: ['action', 'args'],
  });
  return { anyOf: options };
}

export function guidedSystemPrompt(tools: ToolSpec[], extra: string): string {
  return [
    'You are the agent inside zeithub.otto, a desktop IDE, working in the user\'s project folder.',
    'Every reply is ONE JSON action: {"action": "<name>", "args": {...}}. Otto runs it and sends you the result; then you choose the next action.',
    'Actions:',
    ...tools.map((t) => `- ${t.name}: ${SHORT[t.name] ?? t.description.slice(0, 200)}`),
    '- answer: the final reply to the user. args: {text}. In the user\'s language. For a question, text IS the full answer itself (not a note that you answered). After work, text says briefly what was really done. Never put code here.',
    'Rules:',
    '- Do the work with actions; never only describe it. Do not invent results: look at the results Otto sends.',
    '- Code and page content go into files. New file: write_file with the whole content. Small change in an existing file: read_file, then replace_in_file. Big rewrite: write_file the full new version.',
    '- If the user wants to see a page or a running app, finish with otto_preview. A static site (index.html, no package.json / artisan): otto_preview mode "file". A project with a dev server: otto_preview mode "run".',
    '- Files that belong together must be linked: a page that uses script.js or style.css includes <script src="script.js"></script> / <link rel="stylesheet" href="style.css">.',
    '- A general question (what is Docker, how does X work) is answered from your own knowledge right away; look into the project files only when the question is about this project.',
    '- A page, landing or mock-up must be complete and good-looking: <style> in <head>, a header, several content sections with real texts, a footer — never a stub.',
    '- If an action fails, fix the cause or try another way; do not repeat the same failing action.',
    extra,
  ].filter(Boolean).join('\n');
}

/** {"action", "args"} from the model's reply, or null. Tolerates text around the JSON. */
export function parseGuided(text: string): { action: string; args: Record<string, unknown> } | null {
  const s = text.trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
    const action = typeof obj.action === 'string' ? obj.action : typeof obj.name === 'string' ? obj.name : '';
    const args = (obj.args ?? obj.arguments ?? obj.parameters ?? {}) as Record<string, unknown>;
    return action ? { action, args: typeof args === 'object' && args ? args : {} } : null;
  } catch {
    return null;
  }
}

interface Msg { role: string; content: string; images?: string[]; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>; tool_name?: string }

/**
 * The conversation as a model without the tools API sees it: its own actions as JSON, results as
 * user messages (a `tool` role would be dropped by such models' templates).
 */
export function toGuidedMessages(messages: Msg[]): Msg[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const c = m.tool_calls[0]?.function ?? {};
      let args: unknown = c.arguments ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep the text */ } }
      return { role: 'assistant', content: JSON.stringify({ action: c.name, args }) };
    }
    if (m.role === 'tool') return { role: 'user', content: `Result of ${m.tool_name ?? 'the action'}:\n${m.content}` };
    return m;
  });
}
