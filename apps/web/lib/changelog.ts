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
    version: '0.2.1',
    date: '2026-10-22',
    items: [
      'The model can ask you to choose between options with buttons in the chat',
      'Sounds when a request starts, an answer arrives and a task is done (Settings → General)',
      'Otto stops repeating the same action in a loop and says so instead',
      'Per-model harness profiles and a bench for measuring multi-step tasks',
      'The local API is protected with a session token; chats no longer wait for each other',
    ],
  },
  {
    version: '0.2.0',
    date: '2026-10-17',
    items: [
      'Agent: each local model gets its own settings — tool mode (native or guided), context size, answer length and temperature are picked by model family and size instead of one set for all',
      'Agent: critical project files (.env, package.json, composer.json, Dockerfile, lock files…) can no longer be deleted by the agent; they can still be edited',
      'Agent: Stop really stops — the model request is closed (the GPU is freed at once) and a running command is killed with everything it started',
      'Agent: a command that hits its time limit on Windows no longer leaves npm/php/artisan running in the background',
      'Agent: "done" is not accepted while the last test/build/migrate still fails — the model is shown the failure and has to fix it or say honestly that it still fails',
      'Agent: in long runs the shrunk context keeps the task, the files already changed and the failing check, so the model does not lose track after compaction',
      'Agent: models no longer copy the "text removed" note of a compacted step into new files',
      'Agent: the "how to run" commands in a final answer are no longer cut out as pasted code',
      'Images: a model that reads pictures and calls tools (Tiel, Qwen3.6, Gemma 4) builds a design from a concept image itself — it no longer fails with "qwen3.6:35b not found" or an empty description',
      'Tasks: big jobs are planned as 8-40 small steps in phases ([Каркас] → [Бэкенд] → [Docker] → …), with "после: N" dependencies and a check command per step; the first step writes .otto/blueprint.md that every later step follows',
      'Tasks: each step runs with a compact context of its own — the blueprint, the phases, the results of the steps it needs, the project\'s running containers — and only its own skills, so a 32K local model can work through long plans',
      'Tasks: a step is ticked off only when its check passes (a failed check goes back to the model with the output) and never when the model itself says it is unfinished; planning writes no files',
      'Skills: NestJS, Laravel, Docker Compose and PostgreSQL skills with the exact imports and commands models get wrong; the framework a request names gets its skill first',
      'Agent: a long job that keeps changing files is no longer cut off at the step limit; a model that only reads is stopped, and in a plan step reads are refused after 25 in a row until it writes',
      'Agent: a broken tool call is asked again, a stub controller/service is reported back, a nested "project/project" folder is refused, UTF-16 logs from PowerShell are readable, `--format` is no longer taken for disk formatting',
    ],
  },
  {
    version: '0.1.11',
    date: '2026-10-15',
    items: [
      'Agent: a change that would break a working file (JS, TS, JSON, CSS, inline scripts, Python and PHP when installed) is refused before it lands, with the exact lines to fix',
      'Agent: a large file is not rewritten before the model has read it, and a rewrite that throws most of a file away has to be confirmed',
      'Agent: every run can be undone — "Undo" on the files card puts the files back as they were before the answer',
      'Agent: one loop watch for every model and mode — repeated calls are answered without running again, and a run that goes in circles is stopped with an honest summary instead of using up all its steps',
      'Tasks: a step is ticked off only when it really changed a file or ran a command — a stopped or apologising model leaves it unchecked to retry',
      'Agent: a local model that falls into repeating itself (Ollama "token repeat limit reached") is asked again with livelier sampling instead of failing the answer',
      'Agent: an empty answer after real work asks the model for its summary instead of showing an error; a model that only reads files is pushed to start the change',
      'Agent: a missing skill or a failing command is no longer a reason to give up — the model is told to go on and fix the cause itself',
      'Agent: existing files are edited in place (replace_in_file) instead of being rewritten whole; the reminder after each step no longer piles up in the context',
    ],
  },
  {
    version: '0.1.10',
    date: '2026-10-12',
    items: [
      'Editor: after opening a file at a line (routes, search, go to definition) the caret no longer jumps back to that line on every Enter or keystroke',
      'macOS builds (Apple Silicon and Intel) attached to every release',
      'macOS: tools install through Homebrew, and the app finds node, git and the AI CLIs from the user’s shell PATH',
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
