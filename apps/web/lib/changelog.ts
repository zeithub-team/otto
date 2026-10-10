/**
 * Release notes shown in Settings → About, newest first. Every release adds an
 * entry here and keeps the old ones — the GitHub release text is made from it.
 */
export interface ChangelogEntry {
  version: string;
  date: string; // YYYY-MM-DD
  items: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.1.9',
    date: '2026-10-10',
    items: [
      'Stop really stops: the model request, a running CLI and the tool loop are cut off at once; the files already changed stay',
      'Loop guard: the same tool call 3 times gets a warning, 5 times ends the run with a summary',
      'Write while the agent works: the message reaches the running task at its next step instead of waiting for the end',
      'Switching the model, context size or effort during a run applies from the next step',
      'Runs keep going when you switch projects or chats; coming back shows the live answer again; different chats run side by side',
      'Agents: who started each run (Agents tab, task step, chat) and in which project, an "all projects" view, what it did (files, commands, tool calls) and its answer formatted like the chat',
      'Tasks: "run the next stage only" for step-by-step work; every model sees the task list and "do the remaining ones" works through it',
      'Project composition: every app in the folder (Laravel, Next.js, React, Django, FastAPI, Go, Java, .NET…) with its ports, Docker files, needed services and .env settings (secrets hidden), plus port conflicts',
      'Model roles (Settings → Models): plans, task lists and audits go to the planner, code to the coder; ready schemes — same model thinking on high and working on low, strong local planner + fast local coder, cloud planner + local coder; "audit and fix" runs the plan right away',
      'Whole-stack start: hybrid (databases in Docker, apps local), local or docker; the Preview starts the full stack of a multi-app folder; Dockerfiles and compose files the AI writes must cover every app',
    ],
  },
  {
    version: '0.1.8',
    date: '2026-10-05',
    items: [
      'Connectors: Figma, Miro, Jira, Linear, Asana, Trello, Notion, Confluence, Slack, GitHub, GitLab, Sentry, Supabase and any MCP server, by access token',
      'Every model and agent can use connected services; changes in them ask first (Settings → Permissions)',
      'Microsoft Store package (MSIX) build',
    ],
  },
  {
    version: '0.1.7',
    date: '2026-10-05',
    items: [
      'The installer finds an installed Otto and offers to update it in place, skipping the setup pages',
      'An update keeps settings, language and theme (setup.json is no longer rewritten)',
    ],
  },
  {
    version: '0.1.6',
    date: '2026-10-05',
    items: [
      'Otto checks GitHub for a new version at startup and once a day and offers to download it',
      'Settings → About shows the real version and the list of changes of every release',
    ],
  },
  {
    version: '0.1.5',
    date: '2026-10-05',
    items: [
      'Model switch notice is one line: the first model, how many were skipped and the current one',
      'Two failures in a row at one provider skip the rest of its models',
      'Cloud models run commands with run_command instead of pasting them into the chat',
      'Short shell commands in an answer are no longer replaced with the "code instead of write_file" marker',
    ],
  },
  {
    version: '0.1.4',
    date: '2026-10-03',
    items: [
      'Preview tabs: every page or address opens in its own tab',
      'Browser check after the model finishes a site: Otto shows the model what looks off at desktop and phone width',
      'New local models in the catalog: Qwen3.6, Qwen3.5, Gemma 4, Qwen3-VL, DeepSeek R1, GPT-OSS, Devstral',
      'Guided mode: small local models write files step by step instead of pasting code',
      'Automatic fallback to the next provider when one is down or out of quota, ending with a local model',
      'Step-by-step builder for multi-page sites',
      'The model can drive Otto: preview, theme, language, tasks, settings, SSH (risky actions ask first)',
      'Tabby can replace the built-in terminal; Agents and Services counters in the header',
      'New free providers: NVIDIA, Cohere, Z.ai, Cloudflare',
      'Fixed: badges overlapping the model name in Models; the installer theme is applied',
    ],
  },
];
