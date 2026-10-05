export interface Project {
  id: number;
  name: string;
  path: string;
  created_at: string;
  updated_at: string;
}

/** A local Git identity (multi-account). id 0 is the built-in "Local" bucket. */
export interface Account {
  id: number;
  provider: string;
  username: string;
  display_name: string;
  avatar_url: string;
  created_at: number;
}

/** A remote repository available to an account (for cloning). */
export interface Repo {
  name: string;
  full_name: string;
  clone_url: string;
  private: boolean;
  owner: string;
  description: string;
}

/** Background autonomous agent run. */
export interface AgentLogEntry { ts: number; kind: 'tool' | 'note' | 'error'; text: string }
export interface AgentRun {
  id: string;
  projectId: number;
  title: string;
  prompt: string;
  model: string | null;
  status: 'running' | 'done' | 'error' | 'stopped';
  content: string;
  log: AgentLogEntry[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
  /** A step of a task run from the task board (else started on the Agents tab). */
  source?: 'agent' | 'task';
}

/** Framework-aware navigation (e.g. Laravel route → controller method). */
export interface RouteEntry {
  method: string;
  uri: string;
  controller: string;
  action: string;
  file: string;
  line: number;
}
export interface NavInfo {
  stack: 'laravel' | 'node' | 'nextjs' | 'generic';
  routes: RouteEntry[];
}

/** A conversation within a project (sidebar hierarchy). */
export interface Chat {
  id: number;
  project_id: number;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'activity' | 'thinking' | 'approval';
  content: string;
  timestamp: number;
  projectId?: number;
  isStreaming?: boolean;
  isError?: boolean;
  images?: string[];
  /** Options the user sent this message with (kept for regenerate). */
  sendOptions?: SendOptions;
  /** For role 'activity': tool lifecycle events from the backend. */
  event?: 'tool_start' | 'tool_end';
  /** For role 'activity': tool name (read_file, write_file, ...). */
  tool?: string;
  /** For role 'activity': relative paths the tool call touches. */
  paths?: string[];
  /** For role 'approval': the command the agent wants to run, where, and the user's answer. */
  approvalId?: string;
  command?: string;
  cwd?: string;
  status?: 'pending' | 'allowed' | 'denied';
  /** A system message that offers an action (e.g. 'claude_cli_login'). */
  action?: string;
}

export type FileKind = 'folder' | 'code' | 'data' | 'doc' | 'image' | 'media' | 'binary' | 'file';

/** Per-message options passed from the composer to the backend. */
export interface SendOptions {
  model?: string;
  useTools?: boolean;
  useContext?: boolean;
  /** Web tools (search, open pages); on by default. */
  useWeb?: boolean;
  /** Reasoning effort: auto | off | low | medium | high | max. */
  effort?: string;
  /** Context window for local models (tokens). */
  numCtx?: number;
  temperature?: number;
}

export interface FileInfo {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number;
  type?: FileKind;
  children?: FileInfo[];
}

export interface WorkspaceFolder {
  name: string;
  path: string;
}

export interface ContextItem {
  path: string;
  type: 'file' | 'folder';
  tokens?: number;
}

export interface TerminalLine {
  id: string;
  type: 'input' | 'output' | 'error';
  content: string;
  timestamp: number;
}

export type ViewType = 'home' | 'chat' | 'project' | 'context' | 'services' | 'models' | 'settings' | 'docs' | 'agents' | 'preview' | 'data' | 'ssh' | 'plugins' | 'connectors';

/** A project shell session managed by the desktop server (`terminal.ts`). */
export interface TerminalSessionMeta {
  id: string;
  project_id: number;
  shell: string;
  running: boolean;
  exit_code: number | null;
  started_at: number;
}

/** State of a background task run (planning or executing the checklist). */
export interface TaskRun {
  taskId: number;
  projectId: number;
  status: 'planning' | 'running' | 'done' | 'error' | 'stopped';
  /** Step being worked on right now. */
  stepId: number | null;
  /** All steps running at this moment (several when steps are marked parallel). */
  stepIds?: number[];
  /** Latest action of each running step, and when each started (ms). */
  activity?: Record<number, { tool: string; path?: string; at: number }>;
  startedAt?: Record<number, number>;
  paused?: boolean;
  error: string | null;
  updatedAt: number;
}

/** A unit of work shown in the right-hand task board. */
export interface Task {
  id: number;
  project_id: number;
  /** Set for checklist steps; null for top-level tasks. */
  parent_id: number | null;
  title: string;
  detail: string;
  status: 'todo' | 'in_progress' | 'done';
  /** Who created it: the user or the AI agent. */
  source: 'user' | 'agent';
  /** Steps only: runs together with the step before it. */
  parallel?: boolean;
  created_at: number;
  updated_at: number;
}

/** Bridge injected by the Electron preload (absent in the plain web build). */
declare global {
  interface Window {
    ottoDesktop?: {
      isDesktop: boolean;
      platform: string;
      /** '' = same origin (embedded desktop server) */
      apiBase: string;
      /** This build's version, e.g. '0.1.6'. */
      appVersion?: string;
      /** Reveal a folder in the OS file manager (desktop build only). */
      revealPath?: (path: string) => Promise<string | undefined>;
      /** The embedded Tabby terminal window (desktop build, Windows). */
      tabby?: (req: { op: 'status' | 'open' | 'bounds' | 'hide' | 'detach'; rect?: { x: number; y: number; width: number; height: number }; cwd?: string }) => Promise<{ status: string; detail?: string }>;
      versions: { electron?: string; chrome?: string; node?: string };
    };
  }
}
