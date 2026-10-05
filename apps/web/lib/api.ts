import type { Project, ChatMessage, FileInfo, WorkspaceFolder, Task, TaskRun, Chat, Account, Repo, NavInfo, AgentRun, TerminalSessionMeta } from '../types';
import { tt } from './i18n';
import { compareModels } from './models';

/**
 * REST base URL.
 * - Desktop build: the preload exposes `ottoDesktop.apiBase` — '' means the
 *   embedded server hosts the API on the same origin.
 * - Web dev: the Next dev server (:3000) talks to the otto server
 *   (`npm run dev:server`) on :8000; a page served by the otto server itself is
 *   same-origin. `otto-api-base` in localStorage overrides both (e.g. when
 *   :8000 is taken).
 */
function webApiBase(): string {
  try {
    const saved = window.localStorage.getItem('otto-api-base');
    if (saved) return saved.replace(/\/+$/, '');
  } catch { /* storage unavailable */ }
  return window.location.port === '3000' ? `http://${window.location.hostname}:8000` : '';
}

export const API_BASE: string =
  typeof window === 'undefined'
    ? 'http://localhost:8000' // SSR/prerender — never reached by real fetches
    : window.ottoDesktop
      ? window.ottoDesktop.apiBase
      : webApiBase();

/** ws(s) origin of the API server: the API_BASE host, or the page origin when same-origin. */
function socketOrigin(): string {
  const base = API_BASE || window.location.origin;
  return base.replace(/^http/, 'ws');
}

/** WebSocket endpoint for the chat stream (same rules as API_BASE). */
function chatSocketUrl(): string {
  return `${socketOrigin()}/api/chat/ws/chat`;
}

/** Extract a FastAPI `detail` from a failed response (or fall back to a message). */
async function apiError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.detail === 'string') return body.detail;
  } catch { /* not JSON */ }
  return `${fallback}: ${res.status}`;
}

// Projects API (scoped by account: id 0 / omitted = local bucket)
export async function fetchProjects(accountId = 0): Promise<Project[]> {
  const res = await fetch(`${API_BASE}/api/projects/?account_id=${accountId}`);
  if (!res.ok) throw new Error(`Failed to fetch projects: ${res.status}`);
  return res.json();
}

/** Starter files requested together with a new project. */
export interface NewProjectOptions {
  gitignore?: string;
  license?: string;
  license_holder?: string;
  git_init?: boolean;
  /** Organization/account to file the project under (default: the active one). */
  account_id?: number;
}

export async function createProject(name: string, folder?: string, accountId = 0, options: NewProjectOptions = {}): Promise<Project> {
  const body: Record<string, unknown> = { ...(folder ? { name, folder } : { name }) };
  if (options.gitignore && options.gitignore !== 'none') body.gitignore = options.gitignore;
  if (options.license && options.license !== 'none') {
    body.license = options.license;
    body.license_holder = options.license_holder ?? '';
  }
  if (options.git_init) body.git_init = true;
  const owner = options.account_id ?? accountId;
  if (owner > 0) body.account_id = owner;
  const res = await fetch(`${API_BASE}/api/projects/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch { /* keep status */ }
    throw new Error(detail);
  }
  return res.json();
}

export async function updateProject(
  projectId: number,
  patch: { name?: string; folder?: string },
): Promise<Project> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch { /* keep status */ }
    throw new Error(detail);
  }
  return res.json();
}

// Workspace folder browser (for binding an existing folder to a project)
export async function fetchWorkspaceFolders(path = ''): Promise<WorkspaceFolder[]> {
  const res = await fetch(`${API_BASE}/api/projects/workspace?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`Failed to list folders: ${res.status}`);
  return res.json();
}

export async function deleteProject(projectId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Failed to delete project: ${res.status}`);
}

// Files API (backend expects project_id + relative path)
export async function fetchFiles(projectId: number, subPath = ''): Promise<FileInfo[]> {
  if (!projectId) return [];
  const params = new URLSearchParams({ project_id: String(projectId), path: subPath });
  const res = await fetch(`${API_BASE}/api/files/?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch files: ${res.status}`);
  const rows = await res.json();
  // Backend sends is_directory/is_dir in its own shape — normalise to FileInfo
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    name: String(row.name ?? ''),
    path: String(row.path ?? ''),
    is_dir: Boolean(row.is_directory ?? row.is_dir),
    size: typeof row.size === 'number' ? row.size : undefined,
    type: (row.type as FileInfo['type']) ?? (row.is_directory ? 'folder' : 'file'),
  }));
}

/** Framework-aware navigation targets (routes → controller method, etc.). */
export async function fetchNav(projectId: number): Promise<NavInfo> {
  const res = await fetch(`${API_BASE}/api/nav?project_id=${projectId}`);
  if (!res.ok) throw new Error(await apiError(res, 'Failed to load navigation'));
  return res.json();
}

export interface ProjectServices { running: number; total: number; services: Array<{ name: string; state: string }> }

/** Running / total Docker services of every project (one `docker ps` on the server). */
export async function fetchServiceSummary(fresh = false): Promise<{ docker: boolean; projects: Record<string, ProjectServices> }> {
  const res = await fetch(`${API_BASE}/api/services/summary${fresh ? '?fresh=1' : ''}`);
  if (!res.ok) throw new Error(await apiError(res, 'Failed to load services'));
  return res.json();
}

/** Tell every badge to re-read the summary (after a start / stop). */
export const announceServicesChanged = (): void => { window.dispatchEvent(new Event('otto:services-changed')); };

export async function fetchFileContent(projectId: number, filePath: string): Promise<string> {
  if (!projectId || !filePath) return '';
  const params = new URLSearchParams({ project_id: String(projectId), path: filePath });
  const res = await fetch(`${API_BASE}/api/files/content?${params}`);
  if (!res.ok) throw new Error(await apiError(res, 'Failed to fetch file'));
  const data = await res.json();
  return data.content;
}

/** Save edited text back to the project (PUT /api/files/content). */
export async function saveFileContent(projectId: number, filePath: string, content: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/files/content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, path: filePath, content }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to save file'));
}

export async function createProjectFile(projectId: number, filePath: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/files/file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, path: filePath }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to create file'));
}

/** Move/rename a file or folder within the project. */
export async function moveProjectEntry(projectId: number, from: string, to: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/files/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, from, to }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to move'));
}

export async function createProjectFolder(projectId: number, folderPath: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/files/folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, path: folderPath }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to create folder'));
}

export async function dockerProjectAction(projectId: number, action: 'status' | 'start-engine' | 'validate' | 'up' | 'down' | 'runtime-up' | 'runtime-down') {
  const res = await fetch(`${API_BASE}/api/services/docker?project_id=${projectId}&action=${action}`, {
    method: 'POST',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.error || `Docker action failed (${res.status})`);
  return data as { available: boolean; running?: boolean; output?: string; detail?: string };
}

/** Per-service Docker action (stop / start / restart / logs of one container). */
export async function dockerServiceAction(
  projectId: number,
  service: string,
  action: 'service-stop' | 'service-start' | 'service-restart' | 'service-logs',
): Promise<{ available: boolean; running?: boolean; output?: string }> {
  const params = new URLSearchParams({ project_id: String(projectId), action, service });
  const res = await fetch(`${API_BASE}/api/services/docker?${params}`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.error || `Docker action failed (${res.status})`);
  return data;
}

/**
 * Start one service, streaming `docker compose up -d` output (image pulls,
 * container creation) line by line. Resolves with the exit code.
 */
export async function startServiceStream(
  projectId: number,
  service: string,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<number> {
  const params = new URLSearchParams({ project_id: String(projectId), action: 'service-start', service });
  const res = await fetch(`${API_BASE}/api/services/docker?${params}`, { method: 'POST', signal });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || data.error || tt('err.startFailed', { status: res.status }));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let code = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const raw = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (raw) {
        try {
          const msg = JSON.parse(raw) as { line?: string; done?: boolean; code?: number };
          if (msg.line) onLine(msg.line);
          if (msg.done) code = msg.code ?? 0;
        } catch { /* skip */ }
      }
      nl = buffer.indexOf('\n');
    }
  }
  return code;
}

/** URL for serving a previewable binary (image) from the project. */
export function fileRawUrl(projectId: number, filePath: string): string {
  const params = new URLSearchParams({ project_id: String(projectId), path: filePath });
  return `${API_BASE}/api/files/raw?${params}`;
}

// Document extraction (PDF/DOCX/XLSX → text for chat attachments)
export interface ExtractedDoc {
  name: string;
  content: string;
  chars: number;
}

export async function extractDocument(file: File): Promise<ExtractedDoc> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}/api/files/extract`, { method: 'POST', body: form });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch { /* keep status */ }
    throw new Error(detail);
  }
  return res.json();
}

// Chats (conversations within a project)
export async function fetchChats(projectId: number): Promise<Chat[]> {
  const res = await fetch(`${API_BASE}/api/chats?project_id=${projectId}`);
  if (!res.ok) throw new Error(`Failed to fetch chats: ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

export async function createChat(projectId: number, title?: string): Promise<Chat> {
  const res = await fetch(`${API_BASE}/api/chats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(title ? { project_id: projectId, title } : { project_id: projectId }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to create chat'));
  return res.json();
}

export async function renameChat(chatId: number, title: string): Promise<Chat> {
  const res = await fetch(`${API_BASE}/api/chats/${chatId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to rename chat'));
  return res.json();
}

export async function deleteChat(chatId: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/chats/${chatId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to delete chat'));
}

// Chat history API (per chat)
export async function fetchChatHistory(chatId: number): Promise<ChatMessage[]> {
  const res = await fetch(`${API_BASE}/api/chat/history?chat_id=${chatId}`);
  if (!res.ok) throw new Error(`Failed to fetch history: ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

/** Wipe persisted messages for one chat. */
export async function clearChatHistory(chatId: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/chat/history?chat_id=${chatId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to clear history: ${res.status}`);
}

/** Delete one persisted message (regenerate flow). */
export async function deleteChatMessage(msgId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/chat/message?msg_id=${encodeURIComponent(msgId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete message: ${res.status}`);
}

/** Cloud model provider (OpenRouter, Groq, Gemini, OpenCode, custom OpenAI-compatible). */
export interface ProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  hint: string;
  from_env: boolean;
  signup_url: string;
  key_required: boolean;
  needs_base_url: boolean;
  base_url: string;
}

export async function fetchProviders(): Promise<ProviderStatus[]> {
  const res = await fetch(`${API_BASE}/api/providers`);
  if (!res.ok) throw new Error(await apiError(res, 'Failed to load providers'));
  return res.json();
}

/** Save the key and/or base URL of a provider; an empty string clears the value. */
export async function saveProvider(id: string, change: { apiKey?: string; baseUrl?: string }): Promise<ProviderStatus> {
  const res = await fetch(`${API_BASE}/api/providers/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(change.apiKey !== undefined ? { api_key: change.apiKey } : {}),
      ...(change.baseUrl !== undefined ? { base_url: change.baseUrl } : {}),
    }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to save'));
  return res.json();
}

/** Verifies the saved key with a 1-token request. */
export async function testProvider(id: string): Promise<{ ok: boolean; models: number; error?: string }> {
  const res = await fetch(`${API_BASE}/api/providers/${id}/test`, { method: 'POST' });
  if (!res.ok) throw new Error(await apiError(res, 'Key check failed'));
  return res.json();
}

/** Models of every configured cloud provider (ids like `openrouter/nvidia/nemotron-3.5-lightning:free`). */
export async function fetchCloudModels(): Promise<{ models: string[]; errors: Record<string, string> }> {
  try {
    const res = await fetch(`${API_BASE}/api/providers/models`);
    if (!res.ok) return { models: [], errors: {} };
    return res.json();
  } catch {
    return { models: [], errors: {} };
  }
}

// Installed Ollama models + free cloud models (composer model selector)
export async function fetchModels(): Promise<string[]> {
  const [local, cloud] = await Promise.all([fetchLocalModels(), fetchCloudModels()]);
  return [...local, ...cloud.models.sort(compareModels)];
}

async function fetchLocalModels(): Promise<string[]> {
  try {
    const res = await fetch(`${API_BASE}/v1/models`);
    if (!res.ok) return [];
    const data = await res.json();
    const names = Array.isArray(data?.models)
      ? data.models.map((m: { name?: string; model?: string }) => m.name || m.model).filter(Boolean)
      : [];
    return [...new Set(names as string[])].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

// Model catalog / installation (desktop embedded server)
export interface CatalogModel {
  name: string;
  label: string;
  task: 'code' | 'general' | 'reasoning' | 'vision' | 'lightweight';
  size: string;
  note: string;
  vision?: boolean;
  recommended?: boolean;
}

export interface PullProgress {
  status: string;
  total?: number;
  completed?: number;
  error?: string;
}

/** Curated list of free models the app can install. */
export async function fetchModelCatalog(): Promise<CatalogModel[]> {
  try {
    const res = await fetch(`${API_BASE}/api/models/catalog`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as CatalogModel[]) : [];
  } catch {
    return [];
  }
}

/**
 * Install a model, streaming download progress. `onProgress` is called for
 * every progress line; the promise resolves when the pull completes.
 * Pass an `AbortSignal` to cancel the download.
 */
export async function pullModel(
  name: string,
  onProgress: (p: PullProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/models/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(await apiError(res, 'Failed to start download'));

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        try {
          const progress = JSON.parse(line) as PullProgress;
          onProgress(progress);
          if (progress.error) throw new Error(progress.error);
        } catch (exc) {
          if (exc instanceof Error && exc.message) throw exc;
        }
      }
      nl = buffer.indexOf('\n');
    }
  }
}

/** Remove an installed model. */
export async function deleteModel(name: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/models/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to delete model'));
}

// Environment (Ollama + language runtimes) — desktop only
export interface InstallOption { label: string; wingetId: string }
export interface ToolStatus {
  id: string;
  name: string;
  kind: 'ai' | 'runtime' | 'tool' | 'container';
  installed: boolean;
  version: string;
  wingetId: string;
  options?: InstallOption[];
  note?: string;
  running?: boolean;
}

export async function fetchEnvStatus(): Promise<ToolStatus[]> {
  try {
    const res = await fetch(`${API_BASE}/api/env/status`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as ToolStatus[]) : [];
  } catch {
    return [];
  }
}

/**
 * Install a tool via winget, streaming output. `onLine` gets each output line;
 * resolves with the process exit code (0 = success).
 */
export async function installTool(
  id: string,
  onLine: (line: string) => void,
  signal?: AbortSignal,
  wingetId?: string,
  action: 'install' | 'reinstall' | 'uninstall' = 'install',
): Promise<number> {
  const res = await fetch(`${API_BASE}/api/env/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...(wingetId ? { winget_id: wingetId } : {}), ...(action !== 'install' ? { action } : {}) }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(await apiError(res, 'Failed to start install'));

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let code = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const raw = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (raw) {
        try {
          const msg = JSON.parse(raw) as { line?: string; done?: boolean; code?: number };
          if (typeof msg.line === 'string') onLine(msg.line);
          if (msg.done) code = msg.code ?? 0;
        } catch { /* skip */ }
      }
      nl = buffer.indexOf('\n');
    }
  }
  return code;
}

/** Open the external Tabby terminal in the selected project's folder. */
export async function openTabby(projectId: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/connectors/tabby/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to open Tabby'));
}

// Git accounts API
export async function fetchAccounts(): Promise<Account[]> {
  const res = await fetch(`${API_BASE}/api/accounts`);
  if (!res.ok) throw new Error(`Failed to fetch accounts: ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

export async function addAccount(token: string, provider = 'github'): Promise<Account> {
  const res = await fetch(`${API_BASE}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, provider }),
  });
  if (!res.ok) throw new Error(await apiError(res, tt('err.addAccount')));
  return res.json();
}

export async function deleteAccount(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/accounts/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await apiError(res, tt('err.delAccount')));
}

export async function fetchAccountRepos(accountId: number): Promise<Repo[]> {
  const res = await fetch(`${API_BASE}/api/accounts/repos?account_id=${accountId}`);
  if (!res.ok) throw new Error(await apiError(res, tt('err.repos')));
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

/** Delete a file or folder (recycle bin when available). */
export async function deleteProjectEntry(projectId: number, path: string): Promise<{ trashed: boolean }> {
  const res = await fetch(`${API_BASE}/api/files/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, path }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to delete'));
  return (await res.json()) as { trashed: boolean };
}

/** Duplicate a file or folder next to the original; returns the new path. */
export async function copyProjectEntry(projectId: number, from: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/files/copy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, from }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to duplicate'));
  return ((await res.json()) as { to: string }).to;
}

/** Save a dropped file into the project (any type; `overwrite` replaces an existing one). */
export async function uploadProjectFile(projectId: number, path: string, file: Blob, overwrite = false): Promise<{ replaced: boolean }> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  const res = await fetch(`${API_BASE}/api/files/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, path, data: btoa(binary), overwrite }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Upload failed'));
  return (await res.json()) as { replaced: boolean };
}

// .env kept in step with the project's services
export interface EnvChange { key: string; from: string | null; to: string }
export interface EnvSyncResult { path: string; created: boolean; changed: EnvChange[] }
export interface EnvFileStatus { hasEnv: boolean; example: string | null; missing: string[] }

/** Write the services' values into `.env` (`create`: make the file when it is missing — always, never, or only with a .env.example). */
export async function syncProjectEnv(projectId: number, services: unknown[], create: 'always' | 'never' | 'example' = 'example'): Promise<EnvSyncResult> {
  const res = await fetch(`${API_BASE}/api/env-file/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, services, create }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to update .env'));
  return (await res.json()) as EnvSyncResult;
}

export async function fetchEnvFileStatus(projectId: number): Promise<EnvFileStatus | null> {
  try {
    const res = await fetch(`${API_BASE}/api/env-file/status?project_id=${projectId}`);
    return res.ok ? ((await res.json()) as EnvFileStatus) : null;
  } catch {
    return null;
  }
}

// PHP versions (several side by side, per project) — Services tab
export interface PhpInstalled { branch: string; version: string; dir: string }
export interface PhpBuild { branch: string; version: string; archived: boolean }
export interface PhpState {
  installed: PhpInstalled[];
  available: PhpBuild[];
  active: string | null;
  project: { version: string | null; customIni: boolean } | null;
}

async function phpCall<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/php${path}`, init);
  if (!res.ok) throw new Error(await apiError(res, 'PHP request failed'));
  return (await res.json()) as T;
}
const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const fetchPhp = (projectId?: number) => phpCall<PhpState>(projectId ? `?project_id=${projectId}` : '');
export const removePhpBranch = (version: string) => phpCall<{ ok: true }>('/remove', jsonInit('POST', { version }));
export const activatePhpBranch = (version: string) => phpCall<{ ok: true }>('/activate', jsonInit('POST', { version }));
export const fetchPhpIni = (target: { version: string } | { projectId: number }) =>
  phpCall<{ path: string; content: string }>('version' in target ? `/ini?version=${encodeURIComponent(target.version)}` : `/ini?project_id=${target.projectId}`);
export const savePhpIni = (target: { version: string } | { projectId: number }, content: string) =>
  phpCall<{ path: string }>('/ini', jsonInit('PUT', { ...('version' in target ? { version: target.version } : { project_id: target.projectId }), content }));
export const saveProjectPhp = (projectId: number, version: string | null, customIni: boolean) =>
  phpCall<{ version: string | null; customIni: boolean }>('/project', jsonInit('PUT', { project_id: projectId, version, custom_ini: customIni }));

/** Install a PHP branch; `onLine` gets the progress lines, resolves with the exit code (0 = ok). */
export async function installPhpBranch(version: string, onLine: (line: string) => void): Promise<number> {
  const res = await fetch(`${API_BASE}/api/php/install`, jsonInit('POST', { version }));
  if (!res.ok || !res.body) throw new Error(await apiError(res, 'Failed to start install'));
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let code = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const raw = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (raw) {
        try {
          const msg = JSON.parse(raw) as { line?: string; done?: boolean; code?: number };
          if (typeof msg.line === 'string') onLine(msg.line);
          if (msg.done) code = msg.code ?? 0;
        } catch { /* skip */ }
      }
      nl = buffer.indexOf('\n');
    }
  }
  return code;
}

// Database client (Data view)
export interface DbConn { kind: 'postgres' | 'mysql'; host: string; port: number; user: string; password: string; database: string }
export interface DbResult { columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean; ms: number }
export interface DbSchema { schema: string; tables: Array<{ name: string; type: string }> }

async function dbPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}/api/db/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Database request failed'));
  return (await res.json()) as T;
}
export const dbSchema = (conn: DbConn) => dbPost<DbSchema[]>('schema', { conn });
export const dbTable = (conn: DbConn, schema: string, table: string, page: number, pageSize: number) =>
  dbPost<DbResult>('table', { conn, schema, table, page, page_size: pageSize });
export const dbQuery = (conn: DbConn, sql: string) => dbPost<DbResult>('query', { conn, sql });

/** Login names an account can act for: the user and their GitHub organizations. */
export async function fetchAccountOwners(accountId: number): Promise<string[]> {
  try {
    const res = await fetch(`${API_BASE}/api/accounts/owners?account_id=${accountId}`);
    if (!res.ok) return [];
    const rows = await res.json();
    return Array.isArray(rows) ? rows.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

// Git branches / clone
export interface BranchInfo { current: string | null; branches: string[]; isRepo: boolean }

export async function fetchBranches(projectId: number): Promise<BranchInfo> {
  const res = await fetch(`${API_BASE}/api/git/branches?project_id=${projectId}`);
  if (!res.ok) throw new Error(await apiError(res, tt('err.branches')));
  return res.json();
}

export async function checkoutBranch(projectId: number, branch: string, create = false): Promise<BranchInfo> {
  const res = await fetch(`${API_BASE}/api/git/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, branch, create }),
  });
  if (!res.ok) throw new Error(await apiError(res, tt('err.switchBranch')));
  return res.json();
}

/** Clone a repo, streaming git output. Resolves with the created project (or null). */
export async function cloneRepo(
  accountId: number,
  url: string,
  name: string,
  onLine: (line: string) => void,
): Promise<Project | null> {
  const res = await fetch(`${API_BASE}/api/git/clone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: accountId, url, name }),
  });
  if (!res.ok || !res.body) throw new Error(await apiError(res, tt('err.clone')));
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let project: Project | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const raw = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (raw) {
        try {
          const msg = JSON.parse(raw) as { line?: string; done?: boolean; code?: number; project?: Project; error?: string };
          if (msg.line) onLine(msg.line);
          if (msg.done) {
            if (msg.error) throw new Error(msg.error);
            if (msg.code && msg.code !== 0) throw new Error(tt('err.cloneCode', { code: msg.code }));
            project = msg.project ?? null;
          }
        } catch (exc) {
          if (exc instanceof Error && exc.message && !raw.includes('"line"')) throw exc;
        }
      }
      nl = buffer.indexOf('\n');
    }
  }
  return project;
}

// Agents API (background autonomous runs)
export async function startAgent(projectId: number, prompt: string, title?: string, model?: string | null): Promise<AgentRun> {
  const body: Record<string, unknown> = { project_id: projectId, prompt };
  if (title) body.title = title;
  if (model) body.model = model;
  const res = await fetch(`${API_BASE}/api/agents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await apiError(res, tt('err.agentStart')));
  return res.json();
}
export async function fetchAgents(projectId: number): Promise<AgentRun[]> {
  const res = await fetch(`${API_BASE}/api/agents?project_id=${projectId}`);
  if (!res.ok) return [];
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}
export async function fetchAgent(id: string): Promise<AgentRun | null> {
  const res = await fetch(`${API_BASE}/api/agents/${id}`);
  if (!res.ok) return null;
  return res.json();
}
export async function stopAgent(id: string): Promise<void> {
  await fetch(`${API_BASE}/api/agents/${id}/stop`, { method: 'POST' });
}
export async function deleteAgent(id: string): Promise<void> {
  await fetch(`${API_BASE}/api/agents/${id}`, { method: 'DELETE' });
}

// Task board API
export async function fetchTasks(projectId: number): Promise<Task[]> {
  const res = await fetch(`${API_BASE}/api/tasks?project_id=${projectId}`);
  if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

export async function createTask(projectId: number, title: string, detail = '', parentId?: number): Promise<Task> {
  const res = await fetch(`${API_BASE}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, title, detail, ...(parentId ? { parent_id: parentId } : {}) }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to create task'));
  return res.json();
}

export async function updateTask(
  taskId: number,
  patch: { title?: string; detail?: string; status?: Task['status']; parallel?: boolean },
): Promise<Task> {
  const res = await fetch(`${API_BASE}/api/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to update task'));
  return res.json();
}

export async function deleteTask(taskId: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/tasks/${taskId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to delete task'));
}

// WebSocket
export function createChatSocket(
  onMessage: (msg: ChatMessage) => void,
  onError: (error: string) => void,
  onClose: () => void,
): WebSocket {
  const ws = new WebSocket(chatSocketUrl());

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data) as ChatMessage;
      onMessage(msg);
    } catch {
      onError('Failed to parse server message');
    }
  };

  ws.onerror = () => onError('WebSocket error');
  ws.onclose = onClose;

  return ws;
}

// Project terminal sessions (desktop embedded server)
function terminalSocketUrl(): string {
  return `${socketOrigin()}/api/terminal/ws`;
}

export interface TerminalFrame {
  type?: string;
  action?: string;
  session_id?: string;
  data?: string;
  code?: number | null;
  message?: string;
}

/** Open a shell session for the project (cwd = project folder). */
export async function startTerminal(projectId: number): Promise<TerminalSessionMeta> {
  const res = await fetch(`${API_BASE}/api/terminal/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to start terminal'));
  const data = await res.json();
  return data.session as TerminalSessionMeta;
}

/** Kill and forget a session. */
export async function stopTerminal(sessionId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/terminal/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to stop terminal'));
}

/** Live sessions, optionally filtered by project. */
export async function listTerminals(projectId?: number): Promise<TerminalSessionMeta[]> {
  const qs = projectId ? `?project_id=${projectId}` : '';
  const res = await fetch(`${API_BASE}/api/terminal/list${qs}`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.sessions) ? (data.sessions as TerminalSessionMeta[]) : [];
}

/** Live stdio socket for one session (attach → output replay + stream). */
export function createTerminalSocket(
  onFrame: (frame: TerminalFrame) => void,
  onError: (error: string) => void,
  onClose: () => void,
): WebSocket {
  const ws = new WebSocket(terminalSocketUrl());
  ws.onmessage = (event) => {
    try {
      onFrame(JSON.parse(event.data) as TerminalFrame);
    } catch {
      onError('Failed to parse server message');
    }
  };
  ws.onerror = () => onError('WebSocket error');
  ws.onclose = onClose;
  return ws;
}

// Find & replace in project files (JetBrains "Find/Replace in Path")
export interface SearchMatch {
  line: number;
  col: number;
  text: string;
}
export interface SearchFileResult {
  path: string;
  matches: SearchMatch[];
}
export interface SearchResponse {
  files: SearchFileResult[];
  totalMatches: number;
  totalFiles: number;
  truncated: boolean;
}
export interface SearchFlags {
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  mask?: string;
}

/** Find text across the project. Throws with the server's message on error. */
export async function searchContent(
  projectId: number,
  query: string,
  flags: SearchFlags = {},
): Promise<SearchResponse> {
  const res = await fetch(`${API_BASE}/api/search/content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, query, ...flags }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Search failed'));
  return res.json() as Promise<SearchResponse>;
}

export interface ReplaceScopeIn {
  path: string;
  lines?: number[];
}
export interface ReplaceResponse {
  files: Array<{ path: string; replaced: number }>;
  totalReplaced: number;
  totalFiles: number;
}

/**
 * Replace query with replacement. `scope` narrows it (single file / selected
 * lines); omitted = mass replace over everything the search finds.
 */
export async function replaceInFiles(
  projectId: number,
  query: string,
  replacement: string,
  flags: SearchFlags = {},
  scope?: ReplaceScopeIn[],
): Promise<ReplaceResponse> {
  const res = await fetch(`${API_BASE}/api/search/replace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, query, replacement, ...flags, ...(scope ? { scope } : {}) }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Replace failed'));
  return res.json() as Promise<ReplaceResponse>;
}

// Workspace symbols: go to definition / go to symbol (Ctrl+Click, Ctrl+Shift+O)
export interface CodeSymbol {
  name: string;
  kind: 'class' | 'interface' | 'function' | 'method' | 'type';
  path: string;
  line: number;
  container?: string;
}

/** Fuzzy symbol search across the project (classes, methods, functions…). */
export async function fetchSymbols(projectId: number, query: string): Promise<CodeSymbol[]> {
  const res = await fetch(`${API_BASE}/api/symbols?project_id=${projectId}&query=${encodeURIComponent(query)}`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.symbols) ? (data.symbols as CodeSymbol[]) : [];
}

export interface DefinitionRequest {
  path: string;
  line: number;
  symbol: string;
  container?: string;
}

/** Resolve an identifier to its definition file:line. Throws when not found. */
export async function fetchDefinition(
  projectId: number,
  req: DefinitionRequest,
): Promise<{ path: string; line: number }> {
  const res = await fetch(`${API_BASE}/api/symbols/definition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, ...req }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Definition lookup failed'));
  return res.json() as Promise<{ path: string; line: number }>;
}

// Project index: completion and quick open (Ctrl+P)
export interface CompletionItem {
  label: string;
  kind: 'class' | 'interface' | 'function' | 'method' | 'type' | 'variable';
  detail?: string;
  score: number;
}

export async function fetchCompletions(
  projectId: number,
  req: { path?: string; line?: number; prefix: string; container?: string; limit?: number },
): Promise<CompletionItem[]> {
  const res = await fetch(`${API_BASE}/api/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, ...req }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.items) ? (data.items as CompletionItem[]) : [];
}

export interface QuickOpenHit { path: string; score: number; positions: number[] }

export async function fetchQuickOpen(projectId: number, query: string, limit = 50): Promise<{ files: QuickOpenHit[]; total: number }> {
  const res = await fetch(`${API_BASE}/api/index/files?project_id=${projectId}&query=${encodeURIComponent(query)}&limit=${limit}`);
  if (!res.ok) return { files: [], total: 0 };
  const data = await res.json();
  return { files: Array.isArray(data?.files) ? data.files : [], total: Number(data?.total) || 0 };
}

export interface IndexStatus { files: number; symbols: number; words: number; ready: boolean; watching: boolean }

/** Index statistics; the first call also starts building the index in the background. */
export async function fetchIndexStatus(projectId: number): Promise<IndexStatus | null> {
  try {
    const res = await fetch(`${API_BASE}/api/index/status?project_id=${projectId}`);
    return res.ok ? ((await res.json()) as IndexStatus) : null;
  } catch {
    return null;
  }
}

export async function fetchTaskRuns(projectId: number): Promise<TaskRun[]> {
  const res = await fetch(`${API_BASE}/api/tasks/runs?project_id=${projectId}`);
  if (!res.ok) throw new Error(`Failed to fetch task runs: ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

/** Start executing the task's checklist stage by stage, or ask the AI to plan it. */
export async function startTaskAction(taskId: number, action: 'run' | 'plan', model?: string): Promise<TaskRun> {
  const res = await fetch(`${API_BASE}/api/tasks/${taskId}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // default to the model picked in the chat composer
    body: JSON.stringify((model ?? selectedModel()) ? { model: model ?? selectedModel() } : {}),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to start task'));
  return res.json();
}

export async function stopTaskRun(taskId: number): Promise<void> {
  await fetch(`${API_BASE}/api/tasks/${taskId}/stop`, { method: 'POST' });
}

export async function pauseTaskRun(taskId: number): Promise<void> {
  await fetch(`${API_BASE}/api/tasks/${taskId}/pause`, { method: 'POST' });
}

function selectedModel(): string | undefined {
  try {
    return window.localStorage.getItem('otto-selected-model') || undefined;
  } catch {
    return undefined;
  }
}

/** Choices made in the installer wizard, waiting to be applied on first launch. */
export interface FirstRunSetupData { version: 1; locale: string; theme: string; tools: string[] }

export async function fetchSetup(): Promise<FirstRunSetupData | null> {
  try {
    const res = await fetch(`${API_BASE}/api/setup`);
    if (!res.ok) return null;
    const data = (await res.json()) as { setup?: FirstRunSetupData | null };
    return data.setup ?? null;
  } catch {
    return null;
  }
}

export async function finishSetup(): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/setup/done`, { method: 'POST' });
  } catch { /* the setup file stays and is retried next launch */ }
}

export interface ProviderLimits {
  supported: boolean;
  perMinute?: number;
  daily?: { used: number; limit: number; remaining: number };
  freeTier?: boolean;
  error?: string;
}

/** Limits of the saved key (only OpenRouter reports them; others are `supported: false`). */
export async function fetchProviderLimits(id: string): Promise<ProviderLimits> {
  try {
    const res = await fetch(`${API_BASE}/api/providers/${id}/limits`);
    if (!res.ok) return { supported: false };
    return res.json();
  } catch {
    return { supported: false };
  }
}

export interface SkillInfo {
  name: string;
  description: string;
  triggers: string[];
  source: 'builtin' | 'library' | 'user' | 'project';
  enabled: boolean;
  /** The project + model has its own skills profile (otherwise the global choice applies). */
  own_profile?: boolean;
  /** Kind of work, for grouping: design, code, testing, writing, media, workflow, learning, other. */
  category?: string;
  /** From Anthropic's official skills (Apache 2.0). */
  official?: boolean;
  /** anthropic | openai — who made it. */
  vendor?: string | null;
}

const skillQuery = (projectId?: number, model?: string): string =>
  projectId && model ? `?project_id=${projectId}&model=${encodeURIComponent(model)}` : '';

export async function fetchSkills(projectId?: number, model?: string): Promise<SkillInfo[]> {
  const res = await fetch(`${API_BASE}/api/skills${skillQuery(projectId, model)}`);
  if (!res.ok) throw new Error(await apiError(res, 'Failed to load skills'));
  return res.json();
}

export async function setSkillEnabled(name: string, enabled: boolean, projectId?: number, model?: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(projectId && model ? { enabled, project_id: projectId, model } : { enabled }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to update skill'));
}

/** Back to the global skill choice for this project + model. */
export async function resetSkillProfile(projectId: number, model: string): Promise<void> {
  await fetch(`${API_BASE}/api/skills/profile${skillQuery(projectId, model)}`, { method: 'DELETE' });
}

/** State of the project's running app (Preview tab). */
export interface RunState {
  status: 'idle' | 'starting' | 'running' | 'exited';
  command: string;
  url: string | null;
  pid: number | null;
  exit_code: number | null;
  started_at: number | null;
  attached: boolean;
  busy_port: number | null;
  log: string[];
}

export interface RunDetection {
  kind: 'node' | 'laravel' | 'django' | 'static' | 'none';
  command: string;
  port: number | null;
  hasIndex: boolean;
  label: string;
  site_url: string | null;
  stacks: string[];
  /** A UI that can be previewed in a frame. */
  frontend: boolean;
  containers: { compose: string | null; services: Array<{ name: string; ports: number[] }>; dockerfile: boolean; devcontainer: boolean };
  options: Array<{ id: string; label: string; command: string; port: number | null; kind: string; frontend: boolean }>;
}

/** Absolute URL for a server-relative path such as a static-site route. */
export const serverUrl = (relative: string): string => `${API_BASE}${relative}`;

export async function detectRun(projectId: number): Promise<RunDetection> {
  const res = await fetch(`${API_BASE}/api/run/${projectId}/detect`);
  if (!res.ok) throw new Error(await apiError(res, 'Failed to detect the project type'));
  return res.json();
}

export async function fetchRun(projectId: number): Promise<RunState> {
  const res = await fetch(`${API_BASE}/api/run/${projectId}`);
  if (!res.ok) throw new Error(await apiError(res, 'Failed to read the run state'));
  return res.json();
}

export async function startRun(projectId: number, command?: string): Promise<RunState> {
  const res = await fetch(`${API_BASE}/api/run/${projectId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: command ?? '' }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to start'));
  return res.json();
}

export async function stopRun(projectId: number): Promise<RunState> {
  const res = await fetch(`${API_BASE}/api/run/${projectId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to stop'));
  return res.json();
}

export interface StarterTemplates {
  gitignore: Array<{ id: string; label: string }>;
  licenses: Array<{ id: string; label: string; holder: boolean }>;
}

export async function fetchTemplates(): Promise<StarterTemplates> {
  const res = await fetch(`${API_BASE}/api/templates`);
  if (!res.ok) throw new Error(await apiError(res, 'Failed to load templates'));
  return res.json();
}

/** Folder new projects are created in. */
export async function fetchProjectsRoot(): Promise<{ path: string; custom: boolean }> {
  const res = await fetch(`${API_BASE}/api/workspace`);
  if (!res.ok) throw new Error(await apiError(res, 'Failed to read the projects folder'));
  return res.json();
}

export async function saveProjectsRoot(folder: string): Promise<{ path: string; custom: boolean }> {
  const res = await fetch(`${API_BASE}/api/workspace`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: folder }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to save the projects folder'));
  return res.json();
}

/** HTML/SVG files of the project that can be opened in the preview frame. */
export async function fetchPages(projectId: number): Promise<string[]> {
  const res = await fetch(`${API_BASE}/api/run/${projectId}/pages`);
  if (!res.ok) throw new Error(await apiError(res, 'Failed to list pages'));
  return ((await res.json()) as { pages: string[] }).pages;
}

/** Changes whenever a file the static preview depends on changes (live reload). */
export async function fetchSiteStamp(projectId: number): Promise<number> {
  const res = await fetch(`${API_BASE}/api/run/${projectId}/stamp`);
  if (!res.ok) return 0;
  return ((await res.json()) as { stamp: number }).stamp;
}

export interface SettingMeta {
  key: string;
    page: 'models' | 'agent' | 'terminal' | 'permissions' | 'server';
  kind: 'number' | 'text' | 'select' | 'bool';
  default: string | number | boolean;
  min?: number;
  max?: number;
  options?: Array<string | number>;
  restart?: boolean;
}

export type SettingValue = string | number | boolean;

export interface AppSettings {
  values: Record<string, SettingValue>;
  defaults: Record<string, SettingValue>;
  meta: SettingMeta[];
  /** Restart-settings the running app was started with. */
  running: Record<string, unknown>;
  data_dir: string;
}

export interface SaveSettingsResult extends AppSettings {
  saved: string[];
  restart_required: string[];
  errors: Record<string, string>;
}

export async function fetchAppSettings(): Promise<AppSettings> {
  const res = await fetch(`${API_BASE}/api/app-settings`);
  if (!res.ok) throw new Error(await apiError(res, 'Failed to load settings'));
  return res.json();
}

export async function saveAppSettings(values: Record<string, SettingValue>): Promise<SaveSettingsResult> {
  const res = await fetch(`${API_BASE}/api/app-settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) throw new Error(await apiError(res, 'Failed to save settings'));
  return res.json();
}

/** Ask the desktop shell to restart the app; false outside the desktop app. */
export async function relaunchApp(): Promise<boolean> {
  const bridge = (window as unknown as { ottoDesktop?: { relaunch?: () => Promise<boolean> } }).ottoDesktop;
  if (!bridge?.relaunch) return false;
  await bridge.relaunch();
  return true;
}

export const canRelaunch = (): boolean => Boolean((window as unknown as { ottoDesktop?: { relaunch?: unknown } }).ottoDesktop?.relaunch);

/** Check an Ollama address: the model count, or an error text. */
export async function testOllamaUrl(url: string): Promise<{ ok: boolean; models?: number; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/net/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: `${url.replace(/\/+$/, '')}/api/tags`, timeout_ms: 4000 }),
    });
    if (!res.ok) return { ok: false, error: await apiError(res, 'Request failed') };
    const data = (await res.json()) as { status: number; body: string };
    if (data.status !== 200) return { ok: false, error: `HTTP ${data.status}` };
    const parsed = JSON.parse(data.body) as { models?: unknown[] };
    return { ok: true, models: parsed.models?.length ?? 0 };
  } catch (exc) {
    return { ok: false, error: exc instanceof Error ? exc.message : String(exc) };
  }
}
