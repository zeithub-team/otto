/**
 * REST layer — 1:1 port of `backend/main.py`, `backend/api/projects.py`,
 * `backend/api/files.py` and `backend/api/chat.py` (HTTP part).
 *
 * Same paths, query parameters, status codes, response bodies and error texts
 * as the FastAPI backend; the only intentional change is that a project may
 * live anywhere on disk (no `/workspace` requirement) — see `paths.ts`.
 */
import { forgetServiceSummary, serviceSummary } from './servicesummary';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import type { Db } from './db';
import { handleExtract } from './extract';
import { dockerCliPath, envStatus, handleInstall, startDockerDesktop } from './env';
import { getHardware } from './hardware';
import { activatePhp, activeBranch, availableBuilds, iniFile, installPhp, listInstalled, readIni, readProjectPhp, removePhp, writeIni, writeProjectPhp } from './phpvm';
import { isPluginName, readPlugin, writePlugin } from './pluginstore';
import { claudeLimits, cliAuthStatus, openCliLogin } from './claudecli';
import { codexStatus, openCodexLogin } from './codexcli';
import { listBackground, resolveApproval } from './shell';
import { DBX_ROUTES, handleDbxRoute } from './dbxroutes';
import { detectProjectDatabases } from './dbdetect';
import { SSH_ROUTES, handleSshRoute } from './sshroutes';
import { listConnectors, removeConnector, saveConnector, testConnector } from './connectors';
import { listSchema, runQuery, tableRows, type DbConn } from './dbclient';
import { checkoutBranch, cloneRepo, listBranches, listOwners, listRepos, validateToken } from './git';
import { projectNav } from './nav';
import { startAgent, listAgents, getAgent, stopAgent, deleteAgent } from './agents';
import { markSetupDone, readSetup } from './setup';
import { allSkills, isSkillOn, librarySkills, profileDisabled, profileKey, skillChoice } from './skills';
import { applyLiveSettings, saveSettings, snapshot } from './appconfig';
import { collectOpenApi, proxyRequest, saveOpenApi, scanLocalServers } from './netclient';
import { gitignoreContent, gitignoreList, licenseList, renderLicense } from './templates';
import { detectRun, getRun, listPages, mimeFor, siteStamp, startRun, staticSiteUrl, stopRun } from './runner';
import {
  PROVIDERS, isConfigured, keySetting, listAllCloudModels, providerById, providerForModel, providerLimits, providerStatus, testProvider, urlSetting,
} from './providers';
import { listTaskRuns, pauseTaskRun, startTaskPlan, startTaskRun, stopTaskRun } from './taskrunner';
import { listTerminals, removeTerminal, startTerminal } from './terminal';
import { requestPermission, resolvePermission } from './permissions';
import {
  replaceInFiles,
  searchContent,
  type ReplaceScope,
} from './filesearch';
import { findDefinition } from './symbols';
import { getIndex } from './projectindex';
import { envStatus as envFileStatus, findEnvExample, servicesToEnv, syncEnvFile, type ServiceInstance } from './envfile';
import {
  errorMessage,
  HttpError,
  queryInt,
  queryString,
  readJsonBody,
  sendJson,
  sendRedirect,
  validateBody,
} from './http';
import {
  deleteModel,
  FREE_MODEL_CATALOG,
  listModels,
  OllamaConnectionError,
  pullModel,
} from './ollama';
import {
  expandUser,
  isDirectory,
  isFile,
  isInside,
  listDrives,
  projectSkipDirs,
  relativePosix,
  resolvePath,
  resolveProjectFile,
  resolveProjectRoot,
} from './paths';

export interface ServerDeps {
  db: Db;
  workspaceRoot: string;
  /** Folder next to the database (user data): holds the installer's setup.json. */
  dataDir: string;
  /** Restart-settings in effect right now (the port the server really listens on). */
  running?: Record<string, unknown>;
}

/** Files above these names are hidden by the file listing. */
const LISTING_SKIP = new Set(['.git', '.next', 'node_modules', '.venv']);

const MAX_TEXT_FILE_BYTES = 1_000_000;
const MAX_RAW_FILE_BYTES = 15_000_000;

// --- File type classification (verbatim from `backend/api/files.py`) --------

const KIND_BY_EXT: Record<string, string> = {
  // code
  py: 'code', js: 'code', mjs: 'code', cjs: 'code', ts: 'code', tsx: 'code',
  jsx: 'code', vue: 'code', svelte: 'code', astro: 'code', html: 'code',
  css: 'code', scss: 'code', less: 'code', c: 'code', cpp: 'code', h: 'code',
  hpp: 'code', java: 'code', go: 'code', rs: 'code', rb: 'code', php: 'code',
  swift: 'code', kt: 'code', lua: 'code', dart: 'code', sh: 'code', bat: 'code',
  ps1: 'code', graphql: 'code', proto: 'code', r: 'code', pl: 'code',
  // data / config
  json: 'data', yaml: 'data', yml: 'data', toml: 'data', ini: 'data',
  cfg: 'data', env: 'data', xml: 'data', sql: 'data', csv: 'data',
  tsv: 'data', properties: 'data', gradle: 'data',
  // docs
  md: 'doc', txt: 'doc', rst: 'doc', log: 'doc', pdf: 'doc',
  docx: 'doc', doc: 'doc', rtf: 'doc', xlsx: 'doc', pptx: 'doc',
  // images / media
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  bmp: 'image', svg: 'image', ico: 'image', avif: 'image',
  mp4: 'media', mov: 'media', webm: 'media', mp3: 'media', wav: 'media',
  // archives / binaries
  zip: 'binary', rar: 'binary', '7z': 'binary', gz: 'binary', tar: 'binary',
  exe: 'binary', dll: 'binary', so: 'binary', bin: 'binary', db: 'binary',
  sqlite: 'binary', lock: 'binary',
};

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  avif: 'image/avif',
};

function extensionOf(target: string): string {
  return path.extname(target).slice(1).toLowerCase();
}

/** `file_kind()` — "folder" for directories, otherwise the extension map. */
function fileKind(target: string, isDir: boolean): string {
  if (isDir) return 'folder';
  return KIND_BY_EXT[extensionOf(target)] ?? 'file';
}

/** `image_mime()` */
function imageMime(target: string): string | undefined {
  return IMAGE_MIME[extensionOf(target)];
}

/** Python's `sorted(key=lambda p: (not p.is_dir(), p.name.lower()))`. */
function byDirectoryThenName(
  a: { is_directory: boolean; name: string },
  b: { is_directory: boolean; name: string },
): number {
  const first = Number(!a.is_directory) - Number(!b.is_directory);
  if (first !== 0) return first;
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** `sorted(key=lambda p: p.name.lower())` for directory names. */
function byLowerName(a: { name: string }, b: { name: string }): number {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

// ------------------------------------------------------------ route matching
//
// One entry per FastAPI route, in registration order: `/health` and
// `/v1/models` from `main.py`, then the projects, files and chat routers
// (`backend/api/*.py` — every decorator registers its own route). The order
// matters: Starlette answers 405 with the `Allow` header of the *first*
// partially matching route.

interface RouteSpec {
  /** Path exactly as FastAPI registered it (a trailing `/` is significant). */
  path: string;
  methods: string[];
  /** `path: int` converter — `/api/projects/{project_id}`. */
  param?: 'int';
}

const ROUTES: RouteSpec[] = [
  { path: '/health', methods: ['GET'] },
  { path: '/v1/models', methods: ['GET'] },
  { path: '/api/hardware', methods: ['GET'] },
  { path: '/api/php', methods: ['GET'] },
  { path: '/api/php/install', methods: ['POST'] },
  { path: '/api/php/remove', methods: ['POST'] },
  { path: '/api/php/activate', methods: ['POST'] },
  { path: '/api/php/ini', methods: ['GET', 'PUT'] },
  { path: '/api/php/project', methods: ['PUT'] },
  ...SSH_ROUTES,
  { path: '/api/plugins/coverty', methods: ['GET', 'PUT'] },
  { path: '/api/plugins/alertas', methods: ['GET', 'PUT'] },
  ...DBX_ROUTES,
  { path: '/api/db/schema', methods: ['POST'] },
  { path: '/api/db/table', methods: ['POST'] },
  { path: '/api/db/query', methods: ['POST'] },
  { path: '/api/models/catalog', methods: ['GET'] },
  { path: '/api/models/pull', methods: ['POST'] },
  { path: '/api/models/delete', methods: ['POST'] },
  { path: '/api/env/status', methods: ['GET'] },
  { path: '/api/env/install', methods: ['POST'] },
  { path: '/api/accounts', methods: ['GET'] },
  { path: '/api/accounts', methods: ['POST'] },
  { path: '/api/accounts/repos', methods: ['GET'] },
  { path: '/api/accounts/owners', methods: ['GET'] },
  { path: '/api/accounts/{account_id}', methods: ['DELETE'], param: 'int' },
  { path: '/api/git/branches', methods: ['GET'] },
  { path: '/api/git/checkout', methods: ['POST'] },
  { path: '/api/git/clone', methods: ['POST'] },
  { path: '/api/services/docker', methods: ['POST'] },
  { path: '/api/services/summary', methods: ['GET'] },
  { path: '/api/connectors/tabby/open', methods: ['POST'] },
  { path: '/api/connectors', methods: ['GET'] },
  { path: '/api/connectors/save', methods: ['POST'] },
  { path: '/api/connectors/test', methods: ['POST'] },
  { path: '/api/connectors/remove', methods: ['POST'] },
  { path: '/api/terminal/start', methods: ['POST'] },
  { path: '/api/terminal/stop', methods: ['POST'] },
  { path: '/api/terminal/list', methods: ['GET'] },
  { path: '/api/search/content', methods: ['POST'] },
  { path: '/api/search/replace', methods: ['POST'] },
  { path: '/api/env-file/status', methods: ['GET'] },
  { path: '/api/env-file/sync', methods: ['POST'] },
  { path: '/api/index/files', methods: ['GET'] },
  { path: '/api/index/status', methods: ['GET'] },
  { path: '/api/index/refresh', methods: ['POST'] },
  { path: '/api/complete', methods: ['POST'] },
  { path: '/api/symbols', methods: ['GET'] },
  { path: '/api/symbols/definition', methods: ['POST'] },
  // projects router: POST "/", GET "/workspace", GET "/", PATCH, DELETE
  { path: '/api/projects/', methods: ['POST'] },
  { path: '/api/projects/workspace', methods: ['GET'] },
  { path: '/api/projects/', methods: ['GET'] },
  { path: '/api/projects/{project_id}', methods: ['PATCH'], param: 'int' },
  { path: '/api/projects/{project_id}', methods: ['DELETE'], param: 'int' },
  // files router: "/", "/raw", "/content" GET, "/content" PUT, "/file", …
  { path: '/api/files/', methods: ['GET'] },
  { path: '/api/files/raw', methods: ['GET'] },
  { path: '/api/files/content', methods: ['GET'] },
  { path: '/api/files/content', methods: ['PUT'] },
  { path: '/api/files/file', methods: ['POST'] },
  { path: '/api/files/upload', methods: ['POST'] },
  { path: '/api/files/delete', methods: ['POST'] },
  { path: '/api/files/copy', methods: ['POST'] },
  { path: '/api/files/folder', methods: ['POST'] },
  { path: '/api/files/move', methods: ['POST'] },
  { path: '/api/files/extract', methods: ['POST'] },
  { path: '/api/nav', methods: ['GET'] },
  { path: '/api/logs', methods: ['GET'] },
  { path: '/api/agent/approval', methods: ['POST'] },
  { path: '/api/claude-cli/status', methods: ['GET'] },
  { path: '/api/claude-cli/login', methods: ['POST'] },
  { path: '/api/codex-cli/status', methods: ['GET'] },
  { path: '/api/codex-cli/login', methods: ['POST'] },
  { path: '/api/agent/background', methods: ['GET'] },
  { path: '/api/agents', methods: ['GET'] },
  { path: '/api/agents', methods: ['POST'] },
  { path: '/api/agents/{agent_id}', methods: ['GET'] },
  { path: '/api/agents/{agent_id}', methods: ['DELETE'] },
  { path: '/api/agents/{agent_id}/stop', methods: ['POST'] },
  // chat router
  { path: '/api/chat/history', methods: ['GET'] },
  { path: '/api/chat/history', methods: ['DELETE'] },
  { path: '/api/chat/message', methods: ['DELETE'] },
  // chats router (conversations within a project)
  { path: '/api/chats', methods: ['GET'] },
  { path: '/api/chats', methods: ['POST'] },
  { path: '/api/chats/{chat_id}', methods: ['PATCH'], param: 'int' },
  { path: '/api/chats/{chat_id}', methods: ['DELETE'], param: 'int' },
  // tasks router
  { path: '/api/setup', methods: ['GET'] },
  { path: '/api/skills', methods: ['GET'] },
  { path: '/api/skills/profile', methods: ['DELETE'] },
  { path: '/api/skills/{name}', methods: ['PUT'] },
  { path: '/api/setup/done', methods: ['POST'] },
  { path: '/api/providers', methods: ['GET'] },
  { path: '/api/providers/models', methods: ['GET'] },
  { path: '/api/providers/{provider_id}', methods: ['PUT'] },
  { path: '/api/providers/{provider_id}/test', methods: ['POST'] },
  { path: '/api/providers/{provider_id}/limits', methods: ['GET'] },
  { path: '/api/tasks', methods: ['GET'] },
  { path: '/api/tasks', methods: ['POST'] },
  { path: '/api/tasks/runs', methods: ['GET'] },
  { path: '/api/tasks/{task_id}', methods: ['PATCH'], param: 'int' },
  { path: '/api/tasks/{task_id}', methods: ['DELETE'], param: 'int' },
];

/** Integer id out of `/api/tasks/{id}`. */
function taskPathInt(pathname: string): number {
  const match = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
  const raw = match ? match[1] : '';
  if (!/^[+-]?\d+$/.test(raw)) {
    throw new HttpError(422, [
      { type: 'int_parsing', loc: ['path', 'task_id'], msg: 'Input should be a valid integer, unable to parse string as an integer', input: raw },
    ]);
  }
  return parseInt(raw, 10);
}

/** `route.matches()` — path only (the method decides FULL vs PARTIAL). */
function pathMatches(route: RouteSpec, pathname: string): boolean {
  if (!route.param) return pathname === route.path;
  const prefix = route.path.slice(0, route.path.indexOf('{'));
  if (!pathname.startsWith(prefix)) return false;
  const rest = pathname.slice(prefix.length);
  return rest.length > 0 && !rest.includes('/');
}

/** FastAPI's `path: int` conversion for `/api/projects/{project_id}`. */
function pathInt(pathname: string, name: string): number {
  const match = /^\/api\/projects\/([^/]+)$/.exec(pathname);
  const raw = match ? match[1] : '';
  if (!/^[+-]?\d+$/.test(raw)) {
    throw new HttpError(422, [
      {
        type: 'int_parsing',
        loc: ['path', name],
        msg: 'Input should be a valid integer, unable to parse string as an integer',
        input: raw,
      },
    ]);
  }
  return parseInt(raw, 10);
}

// ----------------------------------------------------------------- handlers

async function handleModels(res: http.ServerResponse): Promise<void> {
  try {
    const models = await listModels();
    sendJson(res, 200, models);
  } catch (exc) {
    // main.py: `JSONResponse(status_code=502, content={"error": str(e)})` —
    // str(HTTPException(status_code=502, ...)) is an empty string in Python.
    const detail = exc instanceof OllamaConnectionError ? '' : errorMessage(exc);
    sendJson(res, 502, { error: detail });
  }
}

/**
 * `POST /api/models/pull` — stream `ollama pull` progress to the client as
 * newline-delimited JSON (one progress object per line). The connection stays
 * open until the download finishes, errors, or the client disconnects.
 */
async function handlePullModel(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  const fields = validateBody(body, [{ name: 'name', kind: 'string' }]);
  const name = String(fields.name);

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
  });

  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });

  try {
    for await (const progress of pullModel(name)) {
      if (aborted || res.writableEnded) return;
      res.write(JSON.stringify(progress) + '\n');
      if (progress.error) break;
    }
  } catch (exc) {
    if (!res.writableEnded) {
      res.write(JSON.stringify({ status: 'error', error: errorMessage(exc) }) + '\n');
    }
  }
  if (!res.writableEnded) res.end();
}

/**
 * `_resolve_bindable_folder()` from `backend/api/projects.py`: absolute paths
 * may point anywhere on disk, relative ones live in the workspace.
 */
function resolveBindableFolder(folder: string, deps: ServerDeps): string {
  const expanded = expandUser(folder);
  const candidate = path.isAbsolute(expanded)
    ? resolvePath(expanded)
    : resolvePath(path.join(deps.workspaceRoot, folder));
  if (!isDirectory(candidate)) {
    throw new HttpError(404, 'Folder not found');
  }
  return candidate;
}

/**
 * Optional starter files for a new project: .gitignore, LICENSE, `git init`.
 * Existing files are never overwritten.
 */
async function applyProjectSetup(
  projectPath: string,
  body: Record<string, unknown>,
): Promise<{ gitignore: string; license: string; git: string; warnings: string[] }> {
  const result = { gitignore: 'none', license: 'none', git: 'none', warnings: [] as string[] };
  const gitignore = typeof body.gitignore === 'string' ? body.gitignore : '';
  if (gitignore && gitignore !== 'none') {
    const content = gitignoreContent(gitignore);
    const target = path.join(projectPath, '.gitignore');
    if (!content) result.warnings.push(`Unknown .gitignore template: ${gitignore}`);
    else if (fs.existsSync(target)) result.gitignore = 'exists';
    else {
      fs.writeFileSync(target, content, 'utf8');
      result.gitignore = 'created';
    }
  }
  const license = typeof body.license === 'string' ? body.license : '';
  if (license && license !== 'none') {
    const target = path.join(projectPath, 'LICENSE');
    if (fs.existsSync(target) || fs.existsSync(`${target}.md`) || fs.existsSync(`${target}.txt`)) result.license = 'exists';
    else {
      const holder = typeof body.license_holder === 'string' ? body.license_holder : '';
      const rendered = await renderLicense(license, holder);
      if (!rendered) result.warnings.push(`Unknown license: ${license}`);
      else {
        fs.writeFileSync(target, rendered.text, 'utf8');
        result.license = 'created';
        if (rendered.warning) result.warnings.push(rendered.warning);
      }
    }
  }
  if (body.git_init === true) {
    if (fs.existsSync(path.join(projectPath, '.git'))) result.git = 'exists';
    else {
      const init = spawnSync('git', ['init'], { cwd: projectPath, windowsHide: true, encoding: 'utf8', timeout: 15000 });
      if (init.status === 0) result.git = 'created';
      else result.warnings.push('git init failed — is Git installed?');
    }
  }
  return result;
}

async function createProject(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  const fields = validateBody(body, [
    { name: 'name', kind: 'string' },
    { name: 'folder', kind: 'optString' },
  ]);
  const name = String(fields.name);
  const folder = typeof fields.folder === 'string' ? fields.folder : undefined;
  const rawAccountId = (body as Record<string, unknown>).account_id;
  const accountId = typeof rawAccountId === 'number' ? rawAccountId : 0;

  let projectPath: string;
  let displayName: string;

  if (folder !== undefined) {
    // Bind an existing folder — any location on disk.
    projectPath = resolveBindableFolder(folder, deps);
    displayName = name.trim() || path.basename(projectPath);
  } else {
    // Sanitize name to prevent path traversal
    const safeName = name.trim().replace(/\//g, '_').replace(/\\/g, '_');
    if (!safeName) {
      throw new HttpError(400, 'Project name cannot be empty');
    }
    projectPath = resolvePath(path.join(deps.workspaceRoot, safeName));
    if (!isInside(deps.workspaceRoot, projectPath)) {
      throw new HttpError(400, 'Project must be inside /workspace');
    }
    // Create the project directory if it doesn't exist
    fs.mkdirSync(projectPath, { recursive: true });
    displayName = name.trim();
  }

  if (!displayName) {
    throw new HttpError(400, 'Project name cannot be empty');
  }

  const existing = deps.db.findProjectByPath(projectPath);
  if (existing !== null) {
    throw new HttpError(409, 'This folder is already a project');
  }
  const projectId = deps.db.createProject(displayName, projectPath, accountId);
  const setup = await applyProjectSetup(projectPath, body as Record<string, unknown>);
  sendJson(res, 200, { id: projectId, name: displayName, path: projectPath, setup });
}

/**
 * `PATCH /api/projects/{project_id}` — rename and/or rebind a project
 * (`update_project` in `backend/api/projects.py`).
 */
async function updateProject(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: ServerDeps,
): Promise<void> {
  const projectId = pathInt(pathname, 'project_id');
  const body = await readJsonBody(req);
  const fields = validateBody(body, [
    { name: 'name', kind: 'optString' },
    { name: 'folder', kind: 'optString' },
  ]);

  const row = deps.db.getProject(projectId);
  if (row === null) {
    throw new HttpError(404, 'Project not found');
  }

  let newName = row.name;
  if (typeof fields.name === 'string') {
    newName = fields.name.trim();
    if (!newName) {
      throw new HttpError(400, 'Project name cannot be empty');
    }
  }

  let newPath = row.path;
  if (typeof fields.folder === 'string') {
    const candidate = resolveBindableFolder(fields.folder, deps);
    const clash = deps.db.findProjectByPath(candidate);
    if (clash !== null && clash !== projectId) {
      throw new HttpError(409, 'This folder is already a project');
    }
    newPath = candidate;
  }

  deps.db.updateProject(projectId, newName, newPath);
  sendJson(res, 200, {
    id: projectId,
    name: newName,
    path: newPath,
    created_at: row.created_at,
  });
}

function listWorkspaceFolders(
  res: http.ServerResponse,
  params: URLSearchParams,
  deps: ServerDeps,
): void {
  const requested = queryString(params, 'path', '');

  if (!requested) {
    // Root level: the default workspace followed by every existing drive.
    const items: { name: string; path: string }[] = [
      {
        name: path.basename(deps.workspaceRoot) || deps.workspaceRoot,
        path: deps.workspaceRoot,
      },
    ];
    if (process.platform === 'win32') {
      for (const drive of listDrives()) {
        items.push({ name: drive.replace(/[\\/]+$/, ''), path: drive });
      }
    }
    sendJson(res, 200, items);
    return;
  }

  // Absolute paths may point anywhere on disk; relative ones stay inside the
  // workspace (no containment check — Python resolves and browses whatever
  // the relative path lands on).
  const expanded = expandUser(requested);
  const folder = path.isAbsolute(expanded)
    ? resolvePath(expanded)
    : resolvePath(path.join(deps.workspaceRoot, requested));
  if (!isDirectory(folder)) {
    throw new HttpError(400, 'Folder not found');
  }

  const children = fs
    .readdirSync(folder, { withFileTypes: true })
    .filter(
      (child) =>
        child.isDirectory() &&
        !child.isSymbolicLink() &&
        !LISTING_SKIP.has(child.name),
    )
    .map((child) => ({
      name: child.name,
      path: path.join(folder, child.name),
    }))
    .sort(byLowerName);
  sendJson(res, 200, children);
}

function listProjects(res: http.ServerResponse, deps: ServerDeps, accountId = 0): void {
  const rows = deps.db.listProjects(accountId);
  const projects = rows
    .map((row) => {
      // Projects live anywhere on disk; only skip entries whose folder is gone
      // (`Path(row[2]).is_dir()`), and echo the stored path verbatim.
      if (!isDirectory(row.path)) return null;
      return {
        id: row.id,
        name: row.name,
        path: row.path,
        created_at: row.created_at,
      };
    })
    .filter((row) => row !== null);
  sendJson(res, 200, projects);
}

function listFiles(
  res: http.ServerResponse,
  params: URLSearchParams,
  deps: ServerDeps,
): void {
  const projectId = queryInt(params, 'project_id');
  const requestedPath = queryString(params, 'path', '');
  const { root, file } = resolveProjectFile(deps.db, projectId, requestedPath);
  if (!isDirectory(file)) {
    throw new HttpError(404, 'Folder not found');
  }
  try {
    const skip = projectSkipDirs(root);
    const entries = fs
      .readdirSync(file, { withFileTypes: true })
      .filter((item) => !(item.isDirectory() && skip.has(item.name)))
      .map((item) => {
        const full = path.join(file, item.name);
        let isDir = false;
        let size = 0;
        try {
          const stat = fs.statSync(full);
          isDir = stat.isDirectory();
          size = stat.isFile() ? stat.size : 0;
        } catch {
          /* broken symlink / vanished entry */
        }
        return {
          path: relativePosix(root, full),
          name: item.name,
          is_directory: isDir,
          size,
          type: fileKind(full, isDir),
        };
      });
    entries.sort(byDirectoryThenName);
    sendJson(res, 200, entries);
  } catch (exc) {
    const code = (exc as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new HttpError(403, 'Permission denied');
    }
    throw exc;
  }
}

function getRawFile(
  res: http.ServerResponse,
  params: URLSearchParams,
  deps: ServerDeps,
): void {
  const projectId = queryInt(params, 'project_id');
  const requestedPath = queryString(params, 'path');
  const { file } = resolveProjectFile(deps.db, projectId, requestedPath);
  if (!isFile(file)) {
    throw new HttpError(404, 'File not found');
  }
  const mime = imageMime(file);
  if (!mime) {
    throw new HttpError(415, 'Not a previewable file type');
  }
  const size = fs.statSync(file).size;
  if (size > MAX_RAW_FILE_BYTES) {
    throw new HttpError(413, 'File is larger than 15 MB');
  }
  res.writeHead(200, {
    'content-type': mime,
    'content-length': String(size),
  });
  fs.createReadStream(file).pipe(res);
}

function getFileContent(
  res: http.ServerResponse,
  params: URLSearchParams,
  deps: ServerDeps,
): void {
  const projectId = queryInt(params, 'project_id');
  const requestedPath = queryString(params, 'path');
  const { file } = resolveProjectFile(deps.db, projectId, requestedPath);
  if (!isFile(file)) {
    throw new HttpError(404, 'File not found');
  }
  if (fs.statSync(file).size > MAX_TEXT_FILE_BYTES) {
    throw new HttpError(413, 'File is larger than 1 MB');
  }
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      fs.readFileSync(file),
    );
  } catch {
    throw new HttpError(415, 'This file is not UTF-8 text');
  }
  // Python reads files in text mode: universal newlines are normalised
  sendJson(res, 200, { content: content.replace(/\r\n?/g, '\n') });
}

/** Python writes text files with `os.linesep` as the line separator. */
function toDiskEol(content: string): string {
  return process.platform === 'win32' ? content.replace(/\n/g, '\r\n') : content;
}

async function saveFileContent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  const fields = validateBody(body, [
    { name: 'project_id', kind: 'int' },
    { name: 'path', kind: 'string' },
    { name: 'content', kind: 'string' },
  ]);
  const projectId = Number(fields.project_id);
  const requestedPath = String(fields.path);
  const content = String(fields.content);

  const { file } = resolveProjectFile(deps.db, projectId, requestedPath);
  if (isDirectory(file)) {
    throw new HttpError(400, 'Invalid file path');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_FILE_BYTES) {
    throw new HttpError(413, 'File is larger than 1 MB');
  }
  if (!isDirectory(path.dirname(file))) {
    throw new HttpError(404, 'Parent folder not found');
  }
  try {
    fs.writeFileSync(file, toDiskEol(content), 'utf8');
  } catch (exc) {
    throw new HttpError(500, `Could not save file: ${errorMessage(exc)}`);
  }
  sendJson(res, 200, { saved: true, path: requestedPath });
}

async function createFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  const fields = validateBody(body, [
    { name: 'project_id', kind: 'int' },
    { name: 'path', kind: 'string' },
  ]);
  const projectId = Number(fields.project_id);
  const requestedPath = String(fields.path);

  const { file } = resolveProjectFile(deps.db, projectId, requestedPath);
  if (fs.existsSync(file)) {
    throw new HttpError(409, 'File already exists');
  }
  if (!isDirectory(path.dirname(file))) {
    throw new HttpError(404, 'Parent folder not found');
  }
  try {
    fs.writeFileSync(file, '', 'utf8');
  } catch (exc) {
    throw new HttpError(500, `Could not create file: ${errorMessage(exc)}`);
  }
  sendJson(res, 200, { created: true, path: requestedPath });
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * `POST /api/files/upload` — a file dropped into the explorer: bytes come base64-encoded,
 * folders on the way are created, an existing file is only replaced with `overwrite`.
 */
async function uploadFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const fields = validateBody(body, [
    { name: 'project_id', kind: 'int' },
    { name: 'path', kind: 'string' },
    { name: 'data', kind: 'string' },
  ]);
  const requestedPath = String(fields.path);
  const { file } = resolveProjectFile(deps.db, Number(fields.project_id), requestedPath);
  const data = Buffer.from(String(fields.data), 'base64');
  if (data.length > MAX_UPLOAD_BYTES) throw new HttpError(413, `File is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  const exists = fs.existsSync(file);
  if (exists && body.overwrite !== true) throw new HttpError(409, 'File already exists');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  } catch (exc) {
    throw new HttpError(500, `Could not save file: ${errorMessage(exc)}`);
  }
  sendJson(res, 200, { saved: true, path: requestedPath, size: data.length, replaced: exists });
}

async function createFolder(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  const fields = validateBody(body, [
    { name: 'project_id', kind: 'int' },
    { name: 'path', kind: 'string' },
  ]);
  const projectId = Number(fields.project_id);
  const requestedPath = String(fields.path);

  const { file } = resolveProjectFile(deps.db, projectId, requestedPath);
  if (fs.existsSync(file)) {
    throw new HttpError(409, 'Folder already exists');
  }
  try {
    fs.mkdirSync(file);
  } catch (exc) {
    throw new HttpError(500, `Could not create folder: ${errorMessage(exc)}`);
  }
  sendJson(res, 200, { created: true, path: requestedPath });
}

async function moveFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  const fields = validateBody(body, [
    { name: 'project_id', kind: 'int' },
    { name: 'from', kind: 'string' },
    { name: 'to', kind: 'string' },
  ]);
  const projectId = Number(fields.project_id);
  const { file: src } = resolveProjectFile(deps.db, projectId, String(fields.from));
  const { file: dst } = resolveProjectFile(deps.db, projectId, String(fields.to));
  if (!fs.existsSync(src)) throw new HttpError(404, 'Source not found');
  // `a.txt` → `A.txt` is the same file on a case-insensitive disk: that is a rename, not a clash
  const caseOnly = src !== dst && src.toLowerCase() === dst.toLowerCase();
  if (fs.existsSync(dst) && !caseOnly) throw new HttpError(409, 'Target already exists');
  // Refuse moving a folder into itself / its own subtree.
  if (dst === src || dst.startsWith(src + path.sep)) throw new HttpError(400, 'Cannot move into itself');
  if (!isDirectory(path.dirname(dst))) throw new HttpError(404, 'Target folder not found');
  try {
    if (caseOnly) {
      const temp = `${src}.otto-rename-${process.pid}`;
      fs.renameSync(src, temp);
      fs.renameSync(temp, dst);
    } else {
      fs.renameSync(src, dst);
    }
  } catch (exc) {
    throw new HttpError(500, `Could not move: ${errorMessage(exc)}`);
  }
  sendJson(res, 200, { moved: true, from: fields.from, to: fields.to });
}

/** Send a file or folder to the recycle bin. Returns false when no recycle bin is available. */
async function moveToTrash(target: string): Promise<boolean> {
  if (process.versions.electron) {
    try {
      const electron = (await import('electron')) as unknown as { shell?: { trashItem?: (p: string) => Promise<void> } };
      if (electron.shell?.trashItem) {
        await electron.shell.trashItem(target);
        return true;
      }
    } catch {
      /* fall through */
    }
  }
  if (process.platform === 'win32') {
    const isDir = isDirectory(target);
    const script = `Add-Type -AssemblyName Microsoft.VisualBasic; $p = $env:OTTO_TRASH; ` +
      (isDir
        ? `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')`
        : `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')`);
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, OTTO_TRASH: target }, windowsHide: true, timeout: 30_000,
    });
    return r.status === 0 && !fs.existsSync(target);
  }
  return false;
}

/** `POST /api/files/delete` — remove a file or folder of the project (recycle bin first). */
async function deleteEntry(req: http.IncomingMessage, res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  const body = await readJsonBody(req);
  const fields = validateBody(body, [{ name: 'project_id', kind: 'int' }, { name: 'path', kind: 'string' }]);
  const requested = String(fields.path).replace(/^\/+|\/+$/g, '');
  if (!requested || requested === '.') throw new HttpError(400, 'Cannot delete the project folder');
  const { root, file } = resolveProjectFile(deps.db, Number(fields.project_id), requested);
  if (file === root || root.startsWith(file + path.sep)) throw new HttpError(400, 'Cannot delete the project folder');
  if (!fs.existsSync(file)) throw new HttpError(404, 'Not found');
  let trashed = false;
  try {
    trashed = await moveToTrash(file);
    if (!trashed) fs.rmSync(file, { recursive: true, force: true });
  } catch (exc) {
    throw new HttpError(500, `Could not delete: ${errorMessage(exc)}`);
  }
  sendJson(res, 200, { deleted: true, path: requested, trashed });
}

/** `POST /api/files/copy` — duplicate a file or folder (`name copy.ext`, `name copy 2.ext`… unless `to` is given). */
async function copyEntry(req: http.IncomingMessage, res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const fields = validateBody(body, [{ name: 'project_id', kind: 'int' }, { name: 'from', kind: 'string' }, { name: 'to', kind: 'optString' }]);
  const projectId = Number(fields.project_id);
  const from = String(fields.from);
  const { file: src } = resolveProjectFile(deps.db, projectId, from);
  if (!fs.existsSync(src)) throw new HttpError(404, 'Source not found');
  let to = typeof fields.to === 'string' && fields.to ? fields.to : '';
  if (!to) {
    const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
    const name = from.slice(dir.length);
    const dot = isDirectory(src) ? -1 : name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 1; ; n++) {
      const candidate = `${dir}${stem} copy${n > 1 ? ` ${n}` : ''}${ext}`;
      if (!fs.existsSync(resolveProjectFile(deps.db, projectId, candidate).file)) { to = candidate; break; }
    }
  }
  const { file: dst } = resolveProjectFile(deps.db, projectId, to);
  if (fs.existsSync(dst)) throw new HttpError(409, 'Target already exists');
  if (dst === src || dst.startsWith(src + path.sep)) throw new HttpError(400, 'Cannot copy into itself');
  try {
    fs.cpSync(src, dst, { recursive: true, errorOnExist: true });
  } catch (exc) {
    throw new HttpError(500, `Could not copy: ${errorMessage(exc)}`);
  }
  sendJson(res, 200, { copied: true, from, to });
}

// ---------------------------------------------------------------- dispatcher

/**
 * Returns `true` when the request was an API route (handled or answered with
 * an error), `false` when the caller should fall through to static files.
 */
export async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  params: URLSearchParams,
  deps: ServerDeps,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  try {
    // --- extract (multipart) -------------------------------------------
    if (pathname === '/api/files/extract') {
      return await handleExtract(req, res, pathname);
    }

    // --- root services --------------------------------------------------
    if (pathname === '/health') {
      if (method !== 'GET') return false;
      sendJson(res, 200, { status: 'ok' });
      return true;
    }
    if (pathname === '/v1/models') {
      if (method !== 'GET') return false;
      await handleModels(res);
      return true;
    }
    if (pathname === '/api/hardware') {
      if (method !== 'GET') return false;
      sendJson(res, 200, await getHardware());
      return true;
    }
    if (pathname === '/api/models/catalog') {
      if (method !== 'GET') return false;
      sendJson(res, 200, FREE_MODEL_CATALOG);
      return true;
    }
    if (pathname === '/api/models/pull') {
      if (method !== 'POST') return false;
      await handlePullModel(req, res);
      return true;
    }
    if (pathname === '/api/models/delete') {
      if (method !== 'POST') return false;
      const body = await readJsonBody(req);
      const fields = validateBody(body, [{ name: 'name', kind: 'string' }]);
      try {
        await deleteModel(String(fields.name));
      } catch (exc) {
        throw new HttpError(502, errorMessage(exc));
      }
      sendJson(res, 200, { deleted: fields.name });
      return true;
    }
    if (pathname === '/api/env/status') {
      if (method !== 'GET') return false;
      sendJson(res, 200, await envStatus());
      return true;
    }
    if (pathname === '/api/env/install') {
      if (method !== 'POST') return false;
      const body = await readJsonBody(req);
      const fields = validateBody(body, [{ name: 'id', kind: 'string' }, { name: 'winget_id', kind: 'optString' }, { name: 'action', kind: 'optString' }]);
      const action = fields.action === 'reinstall' || fields.action === 'uninstall' ? fields.action : 'install';
      handleInstall(res, String(fields.id), typeof fields.winget_id === 'string' ? fields.winget_id : undefined, action);
      return true;
    }

    // --- accounts (Git identities) --------------------------------------
    if (pathname === '/api/accounts') {
      if (method === 'GET') {
        sendJson(res, 200, deps.db.listAccounts());
        return true;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const fields = validateBody(body, [
          { name: 'provider', kind: 'optString' },
          { name: 'token', kind: 'string' },
        ]);
        const provider = typeof fields.provider === 'string' && fields.provider ? fields.provider : 'github';
        const token = String(fields.token).trim();
        if (!token) throw new HttpError(400, 'Token cannot be empty');
        let identity;
        try {
          identity = await validateToken(provider, token);
        } catch (exc) {
          throw new HttpError(401, errorMessage(exc));
        }
        const account = deps.db.createAccount({
          provider,
          username: identity.username,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl,
          token,
        });
        sendJson(res, 200, account);
        return true;
      }
      return false;
    }
    if (pathname === '/api/accounts/repos') {
      if (method !== 'GET') return false;
      const accountId = queryInt(params, 'account_id');
      const token = deps.db.getAccountToken(accountId);
      if (!token) throw new HttpError(404, 'Account not found');
      try {
        sendJson(res, 200, await listRepos(token));
      } catch (exc) {
        throw new HttpError(502, errorMessage(exc));
      }
      return true;
    }
    if (pathname === '/api/accounts/owners') {
      if (method !== 'GET') return false;
      const token = deps.db.getAccountToken(queryInt(params, 'account_id'));
      if (!token) throw new HttpError(404, 'Account not found');
      try {
        sendJson(res, 200, await listOwners(token));
      } catch (exc) {
        throw new HttpError(502, errorMessage(exc));
      }
      return true;
    }
    if (/^\/api\/accounts\/[^/]+$/.test(pathname)) {
      if (method !== 'DELETE') return false;
      const match = /^\/api\/accounts\/([^/]+)$/.exec(pathname);
      const raw = match ? match[1] : '';
      if (!/^[+-]?\d+$/.test(raw)) {
        throw new HttpError(422, [{ type: 'int_parsing', loc: ['path', 'account_id'], msg: 'Input should be a valid integer, unable to parse string as an integer', input: raw }]);
      }
      deps.db.deleteAccount(parseInt(raw, 10));
      sendJson(res, 200, { deleted: parseInt(raw, 10) });
      return true;
    }

    // --- git ------------------------------------------------------------
    if (pathname === '/api/git/branches') {
      if (method !== 'GET') return false;
      const projectId = queryInt(params, 'project_id');
      const root = deps.db.getProjectPath(projectId);
      if (!root || !isDirectory(root)) throw new HttpError(404, 'Project folder not found');
      sendJson(res, 200, listBranches(root));
      return true;
    }
    if (pathname === '/api/git/checkout') {
      if (method !== 'POST') return false;
      const body = await readJsonBody(req);
      const fields = validateBody(body, [
        { name: 'project_id', kind: 'int' },
        { name: 'branch', kind: 'string' },
      ]);
      const root = deps.db.getProjectPath(Number(fields.project_id));
      if (!root || !isDirectory(root)) throw new HttpError(404, 'Project folder not found');
      const create = (body as Record<string, unknown>).create === true;
      try {
        const output = checkoutBranch(root, String(fields.branch), create);
        sendJson(res, 200, { ok: true, output, ...listBranches(root) });
      } catch (exc) {
        throw new HttpError(400, errorMessage(exc));
      }
      return true;
    }
    if (pathname === '/api/git/clone') {
      if (method !== 'POST') return false;
      const body = await readJsonBody(req);
      const fields = validateBody(body, [
        { name: 'account_id', kind: 'int' },
        { name: 'url', kind: 'string' },
        { name: 'name', kind: 'optString' },
      ]);
      const accountId = Number(fields.account_id);
      const url = String(fields.url).trim();
      const repoName = (typeof fields.name === 'string' && fields.name.trim())
        ? fields.name.trim().replace(/[\\/]/g, '_')
        : (url.split('/').pop() ?? 'repo').replace(/\.git$/, '');
      const token = accountId > 0 ? deps.db.getAccountToken(accountId) : null;
      const dest = path.join(deps.workspaceRoot, repoName);
      if (fs.existsSync(dest)) throw new HttpError(409, 'Folder already exists in workspace');

      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      const code = await cloneRepo(dest, url, token, (line) => {
        if (!res.writableEnded) res.write(JSON.stringify({ line }) + '\n');
      });
      if (code === 0 && isDirectory(dest)) {
        try {
          const id = deps.db.createProject(repoName, resolvePath(dest), accountId > 0 ? accountId : null);
          res.write(JSON.stringify({ done: true, code, project: { id, name: repoName, path: resolvePath(dest) } }) + '\n');
        } catch (exc) {
          res.write(JSON.stringify({ done: true, code: 1, error: errorMessage(exc) }) + '\n');
        }
      } else {
        res.write(JSON.stringify({ done: true, code: code || 1 }) + '\n');
      }
      if (!res.writableEnded) res.end();
      return true;
    }

    // running / total services of every project (badges in the sidebar)
    if (pathname === '/api/services/summary' && method === 'GET') {
      if (queryString(params, 'fresh', '') === '1') forgetServiceSummary();
      sendJson(res, 200, serviceSummary(deps.db.listProjects().map((p) => ({ id: p.id, path: p.path }))));
      return true;
    }
    if (pathname === '/api/services/docker') {
      if (method !== 'POST') return false;
      forgetServiceSummary();
      const projectId = queryInt(params, 'project_id');
      const action = queryString(params, 'action');
      if (!['status', 'start-engine', 'validate', 'up', 'down', 'runtime-up', 'runtime-down', 'service-stop', 'service-restart', 'service-start', 'service-logs'].includes(action)) throw new HttpError(400, 'Unsupported Docker action');
      const projectPath = deps.db.getProjectPath(projectId);
      if (!projectPath || !isDirectory(projectPath)) throw new HttpError(404, 'Project folder not found');
      const composeFile = path.join(projectPath, 'otto.compose.yaml');
      if (['up', 'down', 'validate'].includes(action) && !isFile(composeFile)) throw new HttpError(404, 'Save otto.compose.yaml from Services before starting Docker');
      const docker = dockerCliPath();
      if (!docker) throw new HttpError(503, 'Docker CLI not found. Install Docker Desktop and retry; restarting Otto is not required.');
      const run = (args: string[], timeout = 90000) => {
        const result = spawnSync(docker, args, { cwd: projectPath, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024, shell: process.platform === 'win32' });
        if (result.error) {
          const msg = result.error.message.includes('ENOENT') ? 'Docker CLI could not be started. Check the Docker Desktop installation.' : result.error.message;
          throw new HttpError(503, msg);
        }
        const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(-12000);
        if (result.status !== 0) {
          const lower = output.toLowerCase();
          if (/docker\\config\.json|error loading config file/.test(lower) && /access is denied|permission denied/.test(lower)) {
            throw new HttpError(503, 'Windows denied Docker CLI access to its user config file. Check the permissions on %USERPROFILE%\\.docker\\config.json, then retry.');
          }
          if (/cannot connect|is the docker daemon running|docker_engine|error during connect/.test(lower)) {
            throw new HttpError(503, 'Docker Engine rejected the connection to its Windows pipe (docker_engine). Make sure Docker Desktop is running under this Windows account and that the account has access to the Docker pipe.');
          }
          if (/access is denied|permission denied|pipe.*access|拒绝访问/.test(lower)) {
            throw new HttpError(503, `${output}\n\nDocker Engine rejected this Windows user. Check that Docker Desktop is running under this account and that the account has access to its Docker pipe; restarting Otto will not grant elevated permissions.`);
          }
          throw new HttpError(502, output || 'Docker Compose command failed');
        }
        return output;
      };
      if (action === 'start-engine') {
        const result = startDockerDesktop();
        if (!result.started) throw new HttpError(503, result.message ?? 'Could not start Docker Desktop.');
        sendJson(res, 200, { available: true, running: false, detail: 'Docker Desktop is starting. Wait for Engine to become ready, then check status again.' });
        return true;
      }
      if (action === 'status' && queryString(params, 'start', '') === '1') {
        const started = startDockerDesktop();
        if (!started.started) throw new HttpError(503, started.message ?? 'Could not start Docker Desktop.');
      }
      run(['info', '--format', '{{.ServerVersion}}'], 20000);
      if (action.startsWith('service-')) {
        if (!isFile(composeFile)) throw new HttpError(404, 'Save otto.compose.yaml from Services before managing services');
        const service = queryString(params, 'service', '');
        if (!/^[A-Za-z0-9_-]+$/.test(service)) throw new HttpError(400, 'Invalid service name');
        const base = ['compose', '-f', 'otto.compose.yaml'];
        if (action === 'service-logs') {
          const output = run([...base, 'logs', '--tail', '200', '--no-color', service], 30000);
          sendJson(res, 200, { available: true, output });
          return true;
        }
        if (action === 'service-start') {
          // Stream `up -d` output (image pulls, container create) so the UI shows
          // live progress instead of blocking on a single request.
          res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
          const child = spawn(docker, [...base, 'up', '-d', service], { cwd: projectPath, windowsHide: true, shell: process.platform === 'win32' });
          const pump = (buf: Buffer) => { for (const line of buf.toString('utf8').split(/\r?\n/)) { const t = line.trim(); if (t && !res.writableEnded) res.write(JSON.stringify({ line: t }) + '\n'); } };
          child.stdout.on('data', pump);
          child.stderr.on('data', pump);
          child.on('error', (exc) => { if (!res.writableEnded) { res.write(JSON.stringify({ line: exc.message }) + '\n'); res.write(JSON.stringify({ done: true, code: 1 }) + '\n'); res.end(); } });
          child.on('close', (code) => { if (!res.writableEnded) { res.write(JSON.stringify({ done: true, code: code ?? 0 }) + '\n'); res.end(); } });
          req.on('close', () => { if (child.exitCode === null) child.kill(); });
          return true;
        }
        const sub = action === 'service-stop' ? ['stop', service] : ['restart', service];
        const output = run([...base, ...sub], 120000);
        sendJson(res, 200, { available: true, running: action !== 'service-stop', output });
        return true;
      }
      if (action.startsWith('runtime-')) {
        const devcontainerConfig = path.join(projectPath, '.devcontainer', 'devcontainer.json');
        if (action === 'runtime-up' && !isFile(devcontainerConfig)) throw new HttpError(404, 'Save a language runtime configuration first');
        if (action === 'runtime-down') {
          const ids = run(['ps', '-q', '--filter', `label=otto.project_id=${projectId}`]).split(/\s+/).filter(Boolean);
          const output = ids.length ? run(['stop', ...ids]) : 'No running development container for this project.';
          sendJson(res, 200, { available: true, running: false, output });
          return true;
        }
        const result = spawnSync('npx', ['--yes', '@devcontainers/cli', 'up', '--id-label', `otto.project_id=${projectId}`, '--workspace-folder', '.'], {
          cwd: projectPath, encoding: 'utf8', timeout: 900000, windowsHide: true,
          maxBuffer: 2 * 1024 * 1024, shell: process.platform === 'win32',
        });
        if (result.error) throw new HttpError(503, `Could not start Dev Containers CLI: ${result.error.message}`);
        const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(-12000);
        if (result.status !== 0) throw new HttpError(502, output || 'Dev Container build failed');
        sendJson(res, 200, { available: true, running: true, output });
        return true;
      }
      if (action === 'status') {
        const output = isFile(composeFile) ? run(['compose', '-f', 'otto.compose.yaml', 'ps', '--format', 'json']) : '';
        const running = output.split(/\r?\n/).some((line) => {
          try { return String((JSON.parse(line) as { State?: unknown }).State ?? '').toLowerCase() === 'running'; }
          catch { return false; }
        });
        sendJson(res, 200, { available: true, running, output, detail: isFile(composeFile) ? undefined : 'Docker is running; no otto.compose.yaml saved yet.' });
        return true;
      }
      if (action === 'validate') {
        const output = run(['compose', '-f', 'otto.compose.yaml', 'config', '-q']);
        sendJson(res, 200, { available: true, valid: true, output });
        return true;
      }
      const output = action === 'up'
        ? run(['compose', '-f', 'otto.compose.yaml', 'up', '-d'], 300000)
        : run(['compose', '-f', 'otto.compose.yaml', 'down']);
      sendJson(res, 200, { available: true, running: action === 'up', output });
      return true;
    }

    if (pathname === '/api/connectors' && method === 'GET') {
      sendJson(res, 200, { connectors: listConnectors() });
      return true;
    }
    if ((pathname === '/api/connectors/save' || pathname === '/api/connectors/test' || pathname === '/api/connectors/remove') && method === 'POST') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const id = typeof body.id === 'string' ? body.id : '';
      try {
        if (pathname.endsWith('/save')) sendJson(res, 200, await saveConnector(id, (body.values ?? {}) as Record<string, unknown>));
        else if (pathname.endsWith('/test')) sendJson(res, 200, await testConnector(id));
        else { await removeConnector(id); sendJson(res, 200, { removed: true }); }
      } catch (exc) {
        throw new HttpError(400, exc instanceof Error ? exc.message : String(exc));
      }
      return true;
    }
    if (pathname === '/api/connectors/tabby/open') {
      if (method !== 'POST') return false;
      const body = await readJsonBody(req);
      const fields = validateBody(body, [{ name: 'project_id', kind: 'int' }]);
      const projectPath = deps.db.getProjectPath(Number(fields.project_id));
      if (!projectPath || !isDirectory(projectPath)) throw new HttpError(404, 'Project folder not found');
      const candidates = [
        ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs', 'Tabby', 'Tabby.exe')] : []),
        ...(process.env.ProgramFiles ? [path.join(process.env.ProgramFiles, 'Tabby', 'Tabby.exe')] : []),
        ...(process.env['ProgramW6432'] ? [path.join(process.env['ProgramW6432'], 'Tabby', 'Tabby.exe')] : []),
        ...(process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'tabby.exe')),
      ];
      const binary = candidates.find((candidate) => fs.existsSync(candidate));
      if (!binary) throw new HttpError(503, 'Tabby is not installed or its executable was not found. Install it from Connectors and retry.');
      const child = spawn(binary, ['open', projectPath], { cwd: projectPath, detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', (exc) => console.warn('[tabby] launch failed:', exc.message));
      child.unref();
      sendJson(res, 200, { opened: true, path: projectPath });
      return true;
    }

    // --- projects -------------------------------------------------------
    if (pathname === '/api/projects/') {
      if (method === 'POST') {
        await createProject(req, res, deps);
        return true;
      }
      if (method === 'GET') {
        const accountId = params.has('account_id') ? queryInt(params, 'account_id') : 0;
        listProjects(res, deps, accountId);
        return true;
      }
      return false;
    }
    if (pathname === '/api/projects/workspace') {
      // GET "/workspace" is registered before the `{project_id}` converter
      // routes, so a different method falls through to them (FastAPI then
      // fails to convert "workspace" to int and answers 422).
      if (method === 'GET') {
        listWorkspaceFolders(res, params, deps);
        return true;
      }
    }
    if (/^\/api\/projects\/[^/]+$/.test(pathname)) {
      if (method === 'PATCH') {
        await updateProject(req, res, pathname, deps);
        return true;
      }
      if (method === 'DELETE') {
        const projectId = pathInt(pathname, 'project_id');
        deps.db.deleteProject(projectId);
        sendJson(res, 200, { message: 'Project deleted' });
        return true;
      }
      return false;
    }

    // --- files ----------------------------------------------------------
    if (pathname === '/api/files/') {
      if (method !== 'GET') return false;
      listFiles(res, params, deps);
      return true;
    }
    if (pathname === '/api/files/raw') {
      if (method !== 'GET') return false;
      getRawFile(res, params, deps);
      return true;
    }
    if (pathname === '/api/files/content') {
      if (method === 'GET') {
        getFileContent(res, params, deps);
        return true;
      }
      if (method === 'PUT') {
        await saveFileContent(req, res, deps);
        return true;
      }
      return false;
    }
    if (pathname === '/api/files/file') {
      if (method !== 'POST') return false;
      await createFile(req, res, deps);
      return true;
    }
    if (pathname === '/api/files/delete') {
      if (method !== 'POST') return false;
      await deleteEntry(req, res, deps);
      return true;
    }
    if (pathname === '/api/files/copy') {
      if (method !== 'POST') return false;
      await copyEntry(req, res, deps);
      return true;
    }
    if (pathname === '/api/files/upload') {
      if (method !== 'POST') return false;
      await uploadFile(req, res, deps);
      return true;
    }
    if (pathname === '/api/files/folder') {
      if (method !== 'POST') return false;
      await createFolder(req, res, deps);
      return true;
    }
    if (pathname === '/api/files/move') {
      if (method !== 'POST') return false;
      await moveFile(req, res, deps);
      return true;
    }
    if (pathname === '/api/nav') {
      if (method !== 'GET') return false;
      const projectId = queryInt(params, 'project_id');
      const root = resolveProjectRoot(deps.db, projectId);
      sendJson(res, 200, projectNav(root));
      return true;
    }

    if (pathname === '/api/logs') {
      if (method !== 'GET') return false;
      const projectId = queryInt(params, 'project_id');
      sendJson(res, 200, deps.db.listProjectLogs(projectId));
      return true;
    }

    // --- terminal (project shell sessions) ------------------------------
    if (pathname === '/api/terminal/start') {
      if (method !== 'POST') return false;
      const body = await readJsonBody(req);
      const fields = validateBody(body, [{ name: 'project_id', kind: 'int' }]);
      const projectId = Number(fields.project_id);
      const projectPath = deps.db.getProjectPath(projectId);
      if (!projectPath || !isDirectory(projectPath)) {
        throw new HttpError(404, 'Папка проекта не найдена');
      }
      try {
        const session = await startTerminal(projectId, projectPath);
        sendJson(res, 200, 'external' in session ? session : { session });
      } catch (exc) {
        throw new HttpError(403, errorMessage(exc));
      }
      return true;
    }
    if (pathname === '/api/terminal/stop') {
      if (method !== 'POST') return false;
      const body = await readJsonBody(req);
      const fields = validateBody(body, [{ name: 'session_id', kind: 'string' }]);
      const sessionId = String(fields.session_id);
      if (!removeTerminal(sessionId)) throw new HttpError(404, 'Сессия не найдена');
      sendJson(res, 200, { stopped: sessionId });
      return true;
    }
    if (pathname === '/api/terminal/list') {
      if (method !== 'GET') return false;
      const projectId = params.has('project_id') ? queryInt(params, 'project_id') : undefined;
      sendJson(res, 200, { sessions: listTerminals(projectId) });
      return true;
    }

    // --- find & replace in files (JetBrains "Find/Replace in Path") -----
    if (pathname === '/api/search/content') {
      if (method !== 'POST') return false;
      const body = await readJsonBody(req);
      const fields = validateBody(body, [
        { name: 'project_id', kind: 'int' },
        { name: 'query', kind: 'string' },
        { name: 'mask', kind: 'optString' },
      ]);
      const projectPath = deps.db.getProjectPath(Number(fields.project_id));
      if (!projectPath || !isDirectory(projectPath)) {
        throw new HttpError(404, 'Папка проекта не найдена');
      }
      const query = String(fields.query);
      if (!query.trim()) throw new HttpError(400, 'Пустой поисковый запрос.');
      const flags = body as {
        caseSensitive?: unknown; regex?: unknown; wholeWord?: unknown;
      };
      try {
        sendJson(res, 200, searchContent(projectPath, {
          query,
          caseSensitive: flags.caseSensitive === true,
          regex: flags.regex === true,
          wholeWord: flags.wholeWord === true,
          mask: typeof fields.mask === 'string' ? fields.mask : '',
        }));
      } catch (exc) {
        throw new HttpError(400, errorMessage(exc));
      }
      return true;
    }
    if (pathname === '/api/search/replace') {
      if (method !== 'POST') return false;
      const body = await readJsonBody(req);
      const fields = validateBody(body, [
        { name: 'project_id', kind: 'int' },
        { name: 'query', kind: 'string' },
        { name: 'replacement', kind: 'string' },
        { name: 'mask', kind: 'optString' },
      ]);
      const projectPath = deps.db.getProjectPath(Number(fields.project_id));
      if (!projectPath || !isDirectory(projectPath)) {
        throw new HttpError(404, 'Папка проекта не найдена');
      }
      const query = String(fields.query);
      if (!query.trim()) throw new HttpError(400, 'Пустой поисковый запрос.');
      const flags = body as {
        caseSensitive?: unknown; regex?: unknown; wholeWord?: unknown;
        scope?: unknown;
      };
      let scope: ReplaceScope[] | undefined;
      if (Array.isArray(flags.scope)) {
        scope = [];
        for (const s of flags.scope as Array<{ path?: unknown; lines?: unknown }>) {
          if (!s || typeof s.path !== 'string' || !s.path) {
            throw new HttpError(400, 'Некорректный scope замены.');
          }
          const rawLines = Array.isArray(s.lines) ? s.lines : [];
          const lines = rawLines.filter(
            (n): n is number => Number.isInteger(n) && (n as number) > 0,
          );
          scope.push({ path: s.path, lines: lines.length ? lines : undefined });
        }
        if (!scope.length) throw new HttpError(400, 'Пустой scope замены.');
      }
      try {
        sendJson(res, 200, replaceInFiles(projectPath, {
          query,
          replacement: String(fields.replacement),
          caseSensitive: flags.caseSensitive === true,
          regex: flags.regex === true,
          wholeWord: flags.wholeWord === true,
          mask: typeof fields.mask === 'string' ? fields.mask : '',
          scope,
        }));
      } catch (exc) {
        throw new HttpError(400, errorMessage(exc));
      }
      return true;
    }

    // --- workspace symbols: go to definition / go to symbol ---------------
    if (pathname === '/api/symbols') {
      if (method !== 'GET') return false;
      const projectId = queryInt(params, 'project_id');
      const projectPath = deps.db.getProjectPath(projectId);
      if (!projectPath || !isDirectory(projectPath)) {
        throw new HttpError(404, 'Папка проекта не найдена');
      }
      const query = params.get('query') ?? '';
      const index = getIndex(projectPath);
      await index.freshen();
      sendJson(res, 200, { symbols: index.searchSymbols(query) });
      return true;
    }
    // --- .env kept in step with the project's services -------------------
    if (pathname === '/api/env-file/status' && method === 'GET') {
      const projectPath = deps.db.getProjectPath(queryInt(params, 'project_id'));
      if (!projectPath || !isDirectory(projectPath)) throw new HttpError(404, 'Папка проекта не найдена');
      sendJson(res, 200, envFileStatus(projectPath));
      return true;
    }
    if (pathname === '/api/env-file/sync' && method === 'POST') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const projectPath = deps.db.getProjectPath(Number(body.project_id));
      if (!projectPath || !isDirectory(projectPath)) throw new HttpError(404, 'Папка проекта не найдена');
      // either ready values, or the project's services to derive them from
      const updates: Record<string, string> = Array.isArray(body.services) ? servicesToEnv(body.services as ServiceInstance[]) : {};
      for (const [key, value] of Object.entries((body.updates ?? {}) as Record<string, unknown>)) {
        if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key) && (typeof value === 'string' || typeof value === 'number')) updates[key] = String(value);
      }
      // create: 'always' | 'never' | 'example' (only when the project ships a .env.example)
      const create = body.create === 'never' || body.create === false ? false : body.create === 'example' ? findEnvExample(projectPath) !== null : true;
      sendJson(res, 200, syncEnvFile(projectPath, updates, { create }));
      return true;
    }
    // --- project index: quick open (Ctrl+P), completion, status ----------
    if (pathname.startsWith('/api/index/')) {
      const projectId = params.has('project_id') ? queryInt(params, 'project_id') : Number(((await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>).project_id);
      const projectPath = deps.db.getProjectPath(projectId);
      if (!projectPath || !isDirectory(projectPath)) throw new HttpError(404, 'Папка проекта не найдена');
      const index = getIndex(projectPath);
      if (pathname === '/api/index/files' && method === 'GET') {
        await index.freshen();
        const limit = params.has('limit') ? Math.min(Math.max(queryInt(params, 'limit'), 1), 200) : 50;
        sendJson(res, 200, { files: index.quickOpen(params.get('query') ?? '', limit), total: index.listFiles().length });
        return true;
      }
      if (pathname === '/api/index/status' && method === 'GET') {
        sendJson(res, 200, index.stats);
        void index.ensure(); // start building in the background
        return true;
      }
      if (pathname === '/api/index/refresh' && method === 'POST') {
        await index.rebuild();
        sendJson(res, 200, index.stats);
        return true;
      }
      return false;
    }
    if (pathname === '/api/complete' && method === 'POST') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const projectPath = deps.db.getProjectPath(Number(body.project_id));
      if (!projectPath || !isDirectory(projectPath)) throw new HttpError(404, 'Папка проекта не найдена');
      const index = getIndex(projectPath);
      await index.freshen();
      sendJson(res, 200, {
        items: index.complete({
          path: typeof body.path === 'string' ? body.path : undefined,
          line: typeof body.line === 'number' ? body.line : undefined,
          prefix: String(body.prefix ?? ''),
          container: typeof body.container === 'string' && body.container ? body.container : undefined,
          limit: typeof body.limit === 'number' ? body.limit : undefined,
        }),
      });
      return true;
    }
    if (pathname === '/api/symbols/definition') {
      if (method !== 'POST') return false;
      const body = await readJsonBody(req);
      const fields = validateBody(body, [
        { name: 'project_id', kind: 'int' },
        { name: 'path', kind: 'string' },
        { name: 'line', kind: 'int' },
        { name: 'symbol', kind: 'string' },
        { name: 'container', kind: 'optString' },
      ]);
      const projectPath = deps.db.getProjectPath(Number(fields.project_id));
      if (!projectPath || !isDirectory(projectPath)) {
        throw new HttpError(404, 'Папка проекта не найдена');
      }
      const symbol = String(fields.symbol);
      if (!symbol) throw new HttpError(400, 'Пустой идентификатор.');
      const index = getIndex(projectPath);
      await index.freshen();
      const found = findDefinition(projectPath, {
        path: String(fields.path),
        line: Number(fields.line),
        symbol,
        container: typeof fields.container === 'string' ? fields.container : undefined,
      }, index.allSymbols());
      if (!found) throw new HttpError(404, `Определение «${symbol}» не найдено.`);
      sendJson(res, 200, found);
      return true;
    }

    // --- agents (background autonomous runs) ----------------------------
    if (pathname === '/api/agents') {
      if (method === 'GET') {
        const projectId = params.has('project_id') ? queryInt(params, 'project_id') : undefined;
        sendJson(res, 200, listAgents(projectId));
        return true;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const fields = validateBody(body, [
          { name: 'project_id', kind: 'int' },
          { name: 'prompt', kind: 'string' },
          { name: 'title', kind: 'optString' },
          { name: 'model', kind: 'optString' },
        ]);
        const prompt = String(fields.prompt).trim();
        if (!prompt) throw new HttpError(400, 'Prompt cannot be empty');
        try {
          const run = startAgent(deps, {
            projectId: Number(fields.project_id),
            prompt,
            title: typeof fields.title === 'string' ? fields.title : undefined,
            model: typeof fields.model === 'string' ? fields.model : null,
          });
          sendJson(res, 200, run);
        } catch (exc) {
          throw new HttpError(400, errorMessage(exc));
        }
        return true;
      }
      return false;
    }
    if (/^\/api\/agents\/[^/]+\/stop$/.test(pathname)) {
      if (method !== 'POST') return false;
      const id = pathname.split('/')[3];
      sendJson(res, 200, { stopped: stopAgent(id) });
      return true;
    }
    if (/^\/api\/agents\/[^/]+$/.test(pathname)) {
      const id = pathname.split('/')[3];
      if (method === 'GET') {
        const run = getAgent(id);
        if (!run) throw new HttpError(404, 'Agent not found');
        sendJson(res, 200, run);
        return true;
      }
      if (method === 'DELETE') {
        sendJson(res, 200, { deleted: deleteAgent(id) });
        return true;
      }
      return false;
    }

    // --- chat -----------------------------------------------------------
    if (pathname === '/api/chat/history') {
      if (method === 'GET') {
        const chatId = queryInt(params, 'chat_id');
        try {
          sendJson(res, 200, deps.db.getMessages(chatId));
        } catch (exc) {
          throw new HttpError(500, `Failed to load history: ${errorMessage(exc)}`);
        }
        return true;
      }
      if (method === 'DELETE') {
        const chatId = queryInt(params, 'chat_id');
        try {
          deps.db.deleteMessages(chatId);
        } catch (exc) {
          throw new HttpError(500, `Failed to clear history: ${errorMessage(exc)}`);
        }
        sendJson(res, 200, { cleared: chatId });
        return true;
      }
      return false;
    }
    if (pathname === '/api/chat/message') {
      if (method !== 'DELETE') return false;
      const msgId = queryString(params, 'msg_id');
      try {
        deps.db.deleteMessage(msgId);
      } catch (exc) {
        throw new HttpError(500, `Failed to delete message: ${errorMessage(exc)}`);
      }
      sendJson(res, 200, { deleted: msgId });
      return true;
    }

    // --- chats (conversations within a project) -------------------------
    if (pathname === '/api/chats') {
      if (method === 'GET') {
        const projectId = queryInt(params, 'project_id');
        sendJson(res, 200, deps.db.listChats(projectId));
        return true;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const fields = validateBody(body, [
          { name: 'project_id', kind: 'int' },
          { name: 'title', kind: 'optString' },
        ]);
        const title = typeof fields.title === 'string' && fields.title.trim() ? fields.title.trim() : 'Новый чат';
        sendJson(res, 200, deps.db.createChat(Number(fields.project_id), title));
        return true;
      }
      return false;
    }
    if (/^\/api\/chats\/[^/]+$/.test(pathname)) {
      const match = /^\/api\/chats\/([^/]+)$/.exec(pathname);
      const raw = match ? match[1] : '';
      if (!/^[+-]?\d+$/.test(raw)) {
        throw new HttpError(422, [{ type: 'int_parsing', loc: ['path', 'chat_id'], msg: 'Input should be a valid integer, unable to parse string as an integer', input: raw }]);
      }
      const chatId = parseInt(raw, 10);
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        const fields = validateBody(body, [{ name: 'title', kind: 'string' }]);
        const title = String(fields.title).trim();
        if (!title) throw new HttpError(400, 'Chat title cannot be empty');
        const chat = deps.db.renameChat(chatId, title);
        if (!chat) throw new HttpError(404, 'Chat not found');
        sendJson(res, 200, chat);
        return true;
      }
      if (method === 'DELETE') {
        deps.db.deleteChat(chatId);
        sendJson(res, 200, { deleted: chatId });
        return true;
      }
      return false;
    }

    // --- first-run setup from the installer wizard ------------------------
    if (pathname === '/api/setup' && method === 'GET') {
      sendJson(res, 200, { setup: readSetup(deps.dataDir) });
      return true;
    }
    if (pathname === '/api/setup/done' && method === 'POST') {
      sendJson(res, 200, { done: markSetupDone(deps.dataDir) });
      return true;
    }

    // --- application settings (port, Ollama address, agent defaults, terminal shell) ---
    if (pathname === '/api/app-settings' && method === 'GET') {
      sendJson(res, 200, { ...snapshot(deps.dataDir, deps.db), running: deps.running ?? {}, data_dir: deps.dataDir });
      return true;
    }
    if (pathname === '/api/permissions/answer' && method === 'POST') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      sendJson(res, 200, { resolved: resolvePermission(String(body.id ?? ''), body.allow === true) });
      return true;
    }
    if (pathname === '/api/app-settings' && method === 'PUT') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const values = body.values && typeof body.values === 'object' ? (body.values as Record<string, unknown>) : {};
      const result = saveSettings(deps.dataDir, deps.db, values, deps.running ?? {});
      if (Object.keys(result.errors).length && !result.saved.length) throw new HttpError(400, Object.values(result.errors)[0]);
      applyLiveSettings(deps.db);
      sendJson(res, 200, { ...result, ...snapshot(deps.dataDir, deps.db), running: deps.running ?? {} });
      return true;
    }

    // --- API tab: request proxy, local server scan, OpenAPI ---------------------
    if (pathname === '/api/net/scan' && method === 'GET') {
      const extra = (params.get('ports') ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
      sendJson(res, 200, { servers: await scanLocalServers(extra) });
      return true;
    }
    if (pathname === '/api/net/request' && method === 'POST') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      try {
        const headers: Record<string, string> = {};
        if (body.headers && typeof body.headers === 'object') {
          for (const [k, v] of Object.entries(body.headers as Record<string, unknown>)) if (typeof v === 'string' && k.trim()) headers[k.trim()] = v;
        }
        sendJson(res, 200, await proxyRequest({
          method: String(body.method ?? 'GET'),
          url: String(body.url ?? ''),
          headers,
          body: typeof body.body === 'string' ? body.body : undefined,
          timeoutMs: typeof body.timeout_ms === 'number' ? body.timeout_ms : undefined,
        }));
      } catch (exc) {
        throw new HttpError(400, exc instanceof Error ? (exc.name === 'TimeoutError' ? 'The request timed out' : exc.message) : String(exc));
      }
      return true;
    }
    if (pathname === '/api/php' || pathname.startsWith('/api/php/')) {
      const projectRoot = (id: unknown): string => {
        const root = deps.db.getProjectPath(Number(id));
        if (!root) throw new HttpError(404, 'Project not found');
        return root;
      };
      try {
        if (pathname === '/api/php' && method === 'GET') {
          const installed = listInstalled();
          const projectId = params.has('project_id') ? queryInt(params, 'project_id') : 0;
          sendJson(res, 200, {
            installed,
            available: await availableBuilds(),
            active: activeBranch(),
            project: projectId ? readProjectPhp(projectRoot(projectId)) : null,
          });
          return true;
        }
        if (pathname === '/api/php/install' && method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
          const code = await installPhp(String(body.version ?? ''), (line) => { if (!res.writableEnded) res.write(JSON.stringify({ line }) + '\n'); });
          res.write(JSON.stringify({ done: true, code }) + '\n');
          res.end();
          return true;
        }
        if (pathname === '/api/php/remove' && method === 'POST') {
          removePhp(String(((await readJsonBody(req)) as Record<string, unknown>).version ?? ''));
          sendJson(res, 200, { ok: true });
          return true;
        }
        if (pathname === '/api/php/activate' && method === 'POST') {
          activatePhp(String(((await readJsonBody(req)) as Record<string, unknown>).version ?? ''));
          sendJson(res, 200, { ok: true });
          return true;
        }
        if (pathname === '/api/php/ini' && method === 'GET') {
          const file = params.has('project_id') ? iniFile({ projectRoot: projectRoot(queryInt(params, 'project_id')) }) : iniFile({ branch: String(params.get('version') ?? '') });
          sendJson(res, 200, { path: file, content: readIni(file) });
          return true;
        }
        if (pathname === '/api/php/ini' && method === 'PUT') {
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          const file = body.project_id ? iniFile({ projectRoot: projectRoot(body.project_id) }) : iniFile({ branch: String(body.version ?? '') });
          if (typeof body.content !== 'string') throw new HttpError(422, 'content must be a string');
          writeIni(file, body.content);
          sendJson(res, 200, { path: file });
          return true;
        }
        if (pathname === '/api/php/project' && method === 'PUT') {
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          sendJson(res, 200, writeProjectPhp(projectRoot(body.project_id), { version: typeof body.version === 'string' ? body.version : null, customIni: body.custom_ini === true }));
          return true;
        }
      } catch (exc) {
        if (exc instanceof HttpError) throw exc;
        throw new HttpError(400, exc instanceof Error ? exc.message : String(exc));
      }
      return false;
    }
    const pluginRoute = /^\/api\/plugins\/([a-z]+)$/.exec(pathname);
    if (pluginRoute && isPluginName(pluginRoute[1])) {
      if (method === 'GET') {
        sendJson(res, 200, { data: readPlugin(deps.dataDir, pluginRoute[1]) });
        return true;
      }
      if (method === 'PUT') {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        try {
          writePlugin(deps.dataDir, pluginRoute[1], body.data ?? null);
        } catch (exc) {
          throw new HttpError(400, exc instanceof Error ? exc.message : String(exc));
        }
        sendJson(res, 200, { ok: true });
        return true;
      }
    }
    // Claude via subscription: is the CLI signed in, and open its sign-in window
    if (pathname === '/api/claude-cli/status' && method === 'GET') {
      sendJson(res, 200, { ...(await cliAuthStatus()), limits: claudeLimits() });
      return true;
    }
    if (pathname === '/api/codex-cli/status' && method === 'GET') {
      sendJson(res, 200, await codexStatus());
      return true;
    }
    if (pathname === '/api/codex-cli/login' && method === 'POST') {
      sendJson(res, 200, { started: openCodexLogin() });
      return true;
    }
    if (pathname === '/api/claude-cli/login' && method === 'POST') {
      sendJson(res, 200, { started: openCliLogin() });
      return true;
    }
    // the user's answer to a run_command approval card in the chat
    if (pathname === '/api/agent/approval' && method === 'POST') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      sendJson(res, 200, { ok: resolveApproval(String(body.id ?? ''), body.allow === true) });
      return true;
    }
    if (pathname === '/api/agent/background' && method === 'GET') {
      sendJson(res, 200, { runs: listBackground() });
      return true;
    }
    if (pathname === '/api/dbx/detect' && method === 'GET') {
      const root = deps.db.getProjectPath(queryInt(params, 'project_id'));
      sendJson(res, 200, { connections: root ? detectProjectDatabases(root) : [] });
      return true;
    }
    if (pathname.startsWith('/api/dbx/') && method === 'POST') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      try {
        const out = await handleDbxRoute(pathname, body);
        if (!out) return false;
        sendJson(res, 200, out.payload);
      } catch (exc) {
        // driver errors (bad password, syntax error…) are shown to the user as they are
        throw new HttpError(400, exc instanceof Error ? exc.message : String(exc));
      }
      return true;
    }
    if (pathname.startsWith('/api/ssh/') && method === 'POST') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      try {
        const action = pathname.slice('/api/ssh/'.length);
        const mutating = new Set(['keys/generate', 'keys/import', 'keys/delete', 'keys/rename', 'forget-host', 'secret/set', 'secret/forget', 'exec', 'sftp/mkdir', 'sftp/rename', 'sftp/chmod', 'sftp/delete', 'sftp/write', 'sftp/upload', 'sftp/upload-bytes', 'sftp/download', 'local/mkdir']);
        const mode = deps.db.getSetting('app.permissions.ssh') || 'ask';
        if (mutating.has(action)) {
          if (mode === 'off') throw new HttpError(403, 'SSH-действия запрещены в настройках разрешений');
          if (mode !== 'allow') {
            const target = String(body.path ?? body.command ?? body.to ?? body.remoteDir ?? body.name ?? '');
            const approval = requestPermission({ kind: 'ssh', action: action === 'exec' ? `Выполнить команду: ${String(body.command ?? '')}` : action, target });
            if (!(await approval.decision)) throw new HttpError(403, 'SSH-действие отклонено или время подтверждения истекло');
          }
        }
        const out = await handleSshRoute(pathname, body, deps.dataDir);
        if (!out) return false;
        sendJson(res, 200, out.payload);
      } catch (exc) {
        if (exc instanceof HttpError) throw exc;
        throw new HttpError(400, exc instanceof Error ? exc.message : String(exc));
      }
      return true;
    }
    if (pathname.startsWith('/api/db/') && method === 'POST') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const raw = (body.conn ?? {}) as Record<string, unknown>;
      const conn: DbConn = {
        kind: raw.kind === 'mysql' ? 'mysql' : 'postgres',
        host: String(raw.host ?? '127.0.0.1'),
        port: Number(raw.port),
        user: String(raw.user ?? ''),
        password: String(raw.password ?? ''),
        database: String(raw.database ?? ''),
      };
      try {
        if (pathname === '/api/db/schema') sendJson(res, 200, await listSchema(conn));
        else if (pathname === '/api/db/table') sendJson(res, 200, await tableRows(conn, String(body.schema ?? ''), String(body.table ?? ''), Number(body.page) || 0, Number(body.page_size) || 100));
        else if (pathname === '/api/db/query') sendJson(res, 200, await runQuery(conn, String(body.sql ?? '')));
        else return false;
      } catch (exc) {
        // driver errors (bad password, syntax error…) are shown to the user as they are
        throw new HttpError(400, exc instanceof Error ? exc.message : String(exc));
      }
      return true;
    }
    const openApiRoute = /^\/api\/net\/openapi\/(\d+)(\/save)?$/.exec(pathname);
    if (openApiRoute) {
      const projectId = Number(openApiRoute[1]);
      const root = deps.db.getProjectPath(projectId);
      if (!root) throw new HttpError(404, 'Project not found');
      if (!openApiRoute[2] && method === 'GET') {
        sendJson(res, 200, await collectOpenApi(root, params.get('base')));
        return true;
      }
      if (openApiRoute[2] && method === 'POST') {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        if (!body.spec || typeof body.spec !== 'object') throw new HttpError(400, 'spec is required');
        sendJson(res, 200, { file: saveOpenApi(root, body.spec as Record<string, unknown>, body.format === 'yaml' ? 'yaml' : 'json') });
        return true;
      }
    }

    // --- projects root folder + starter templates ------------------------------
    if (pathname === '/api/workspace' && method === 'GET') {
      sendJson(res, 200, { path: deps.workspaceRoot, custom: Boolean(deps.db.getSetting('workspace_root')) });
      return true;
    }
    if (pathname === '/api/workspace' && method === 'PUT') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const raw = typeof body.path === 'string' ? body.path.trim() : '';
      if (!raw) throw new HttpError(400, 'Path is required');
      const expanded = expandUser(raw);
      if (!path.isAbsolute(expanded)) throw new HttpError(400, 'Use an absolute path');
      const target = resolvePath(expanded);
      if (fs.existsSync(target) && !isDirectory(target)) throw new HttpError(400, 'That path is a file');
      try {
        fs.mkdirSync(target, { recursive: true });
      } catch (exc) {
        throw new HttpError(400, `Cannot create the folder: ${exc instanceof Error ? exc.message : String(exc)}`);
      }
      deps.db.setSetting('workspace_root', target);
      deps.workspaceRoot = target;
      sendJson(res, 200, { path: target, custom: true });
      return true;
    }
    if (pathname === '/api/templates' && method === 'GET') {
      sendJson(res, 200, { gitignore: gitignoreList(), licenses: licenseList() });
      return true;
    }

    // --- preview: run the app, serve a static site ----------------------------
    const runRoute = /^\/api\/run\/(\d+)(\/detect|\/pages|\/stamp)?$/.exec(pathname);
    if (runRoute) {
      const projectId = Number(runRoute[1]);
      const root = deps.db.getProjectPath(projectId);
      if (!root) throw new HttpError(404, 'Project not found');
      if (runRoute[2] === '/detect' && method === 'GET') {
        const found = detectRun(root);
        sendJson(res, 200, { ...found, site_url: found.hasIndex ? staticSiteUrl(projectId) : null });
        return true;
      }
      if (runRoute[2] === '/pages' && method === 'GET') {
        sendJson(res, 200, { pages: listPages(root) });
        return true;
      }
      if (runRoute[2] === '/stamp' && method === 'GET') {
        sendJson(res, 200, { stamp: siteStamp(root) });
        return true;
      }
      if (!runRoute[2] && method === 'GET') {
        sendJson(res, 200, getRun(projectId));
        return true;
      }
      if (!runRoute[2] && method === 'POST') {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const found = detectRun(root);
        const typed = typeof body.command === 'string' ? body.command.trim() : '';
        const chosen = found.options.find((o) => (typed ? o.command === typed : o.id === body.option_id)) ?? (typed ? undefined : found.options[0]);
        const command = typed || chosen?.command || '';
        if (!command) throw new HttpError(400, 'Nothing to run: no command given and none detected');
        sendJson(res, 200, startRun(projectId, root, command, chosen?.port ?? null));
        return true;
      }
      if (!runRoute[2] && method === 'DELETE') {
        sendJson(res, 200, stopRun(projectId));
        return true;
      }
    }
    const siteRoute = /^\/api\/site\/(\d+)\/(.*)$/.exec(pathname);
    if (siteRoute && (method === 'GET' || method === 'HEAD')) {
      const root = deps.db.getProjectPath(Number(siteRoute[1]));
      if (!root) throw new HttpError(404, 'Project not found');
      let rel = '';
      try {
        rel = decodeURIComponent(siteRoute[2]);
      } catch {
        throw new HttpError(400, 'Bad path');
      }
      const base = resolvePath(root);
      let file = path.resolve(base, rel || 'index.html');
      if (!isInside(base, file)) throw new HttpError(403, 'Outside the project');
      if (isDirectory(file)) file = path.join(file, 'index.html');
      if (!isFile(file)) throw new HttpError(404, 'File not found');
      res.writeHead(200, { 'content-type': mimeFor(file), 'cache-control': 'no-store' });
      if (method === 'HEAD') res.end();
      else fs.createReadStream(file).pipe(res);
      return true;
    }

    // --- skills -------------------------------------------------------------
    // ?project_id=&model= : the skills of that project + model (its own profile, or the global choice)
    if (pathname === '/api/skills/profile' && method === 'DELETE') {
      const key = profileKey(Number(params.get('project_id')) || null, params.get('model'));
      if (key) deps.db.setSetting(key, '');
      sendJson(res, 200, { ok: Boolean(key) });
      return true;
    }
    if (pathname === '/api/skills' && method === 'GET') {
      const projectId = Number(params.get('project_id')) || null;
      const key = profileKey(projectId, params.get('model'));
      const choice = skillChoice(key);
      const root = projectId ? deps.db.getProjectPath(projectId) : null;
      sendJson(
        res,
        200,
        allSkills(root).map((s) => ({
          name: s.name,
          description: s.description,
          triggers: s.triggers,
          source: s.source,
          category: s.category,
          official: s.official,
          vendor: s.vendor ?? null,
          enabled: isSkillOn(s, choice),
          own_profile: profileDisabled(key) !== null,
        })),
      );
      return true;
    }
    const skillRoute = /^\/api\/skills\/([\w.-]+)$/.exec(pathname);
    if (skillRoute && method === 'PUT') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const projectId = Number(body.project_id) || null;
      const key = profileKey(projectId, typeof body.model === 'string' ? body.model : null);
      // the first change for a project + model copies the current choice into its own profile
      const choice = skillChoice(key);
      const name = skillRoute[1];
      const isLibrary = librarySkills().some((s) => s.name === name);
      const on = body.enabled !== false;
      if (isLibrary) { if (on) choice.enabled.add(name); else choice.enabled.delete(name); }
      else if (on) choice.disabled.delete(name); else choice.disabled.add(name);
      if (key) deps.db.setSetting(key, JSON.stringify({ disabled: [...choice.disabled], enabled: [...choice.enabled] }));
      else {
        deps.db.setSetting('skills_disabled', [...choice.disabled].join(','));
        deps.db.setSetting('skills_enabled', [...choice.enabled].join(','));
      }
      sendJson(res, 200, { name: skillRoute[1], enabled: body.enabled !== false });
      return true;
    }

    // --- cloud providers (OpenRouter, Groq, Gemini, OpenCode, custom) -------
    if (pathname === '/api/providers' && method === 'GET') {
      sendJson(res, 200, PROVIDERS.map(providerStatus));
      return true;
    }
    if (pathname === '/api/providers/models' && method === 'GET') {
      sendJson(res, 200, await listAllCloudModels());
      return true;
    }
    const providerRoute = /^\/api\/providers\/([a-z]+)(\/test|\/limits)?$/.exec(pathname);
    if (providerRoute) {
      const def = providerById(providerRoute[1]);
      if (!def) throw new HttpError(404, 'Unknown provider');
      if (providerRoute[2] === '/limits' && method === 'GET') {
        sendJson(res, 200, await providerLimits(def));
        return true;
      }
      if (providerRoute[2] === '/test' && method === 'POST') {
        try {
          sendJson(res, 200, await testProvider(def));
        } catch (exc) {
          sendJson(res, 200, { ok: false, models: 0, error: errorMessage(exc) });
        }
        return true;
      }
      if (!providerRoute[2] && method === 'PUT') {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        // only fields that are present are changed; an empty string clears a value
        if (typeof body.api_key === 'string') {
          deps.db.setSetting(keySetting(def), body.api_key.trim());
          if (def.id === 'opencode') deps.db.setSetting('opencode_api_key', ''); // pre-registry copy
        }
        if (def.needsBaseUrl && typeof body.base_url === 'string') {
          const url = body.base_url.trim();
          if (url && !/^https?:\/\//i.test(url)) throw new HttpError(400, 'Base URL must start with http:// or https://');
          deps.db.setSetting(urlSetting(def), url);
        }
        sendJson(res, 200, providerStatus(def));
        return true;
      }
    }

    // --- tasks ----------------------------------------------------------
    if (pathname === '/api/tasks') {
      if (method === 'GET') {
        const projectId = queryInt(params, 'project_id');
        sendJson(res, 200, deps.db.listTasks(projectId));
        return true;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const fields = validateBody(body, [
          { name: 'project_id', kind: 'int' },
          { name: 'title', kind: 'string' },
          { name: 'detail', kind: 'optString' },
        ]);
        const title = String(fields.title).trim();
        if (!title) throw new HttpError(400, 'Task title cannot be empty');
        const rawParent = (body as Record<string, unknown>).parent_id;
        let parentId: number | null = null;
        if (typeof rawParent === 'number' && Number.isInteger(rawParent)) {
          const parent = deps.db.getTask(rawParent);
          if (!parent || parent.parent_id !== null || parent.project_id !== Number(fields.project_id)) {
            throw new HttpError(400, 'Invalid parent task');
          }
          parentId = parent.id;
        }
        const task = deps.db.createTask(
          Number(fields.project_id),
          title,
          typeof fields.detail === 'string' ? fields.detail : '',
          'user',
          parentId,
        );
        sendJson(res, 200, task);
        return true;
      }
      return false;
    }
    if (pathname === '/api/tasks/runs' && method === 'GET') {
      sendJson(res, 200, listTaskRuns(queryInt(params, 'project_id')));
      return true;
    }
    const taskAction = /^\/api\/tasks\/(\d+)\/(run|plan|stop|pause)$/.exec(pathname);
    if (taskAction && method === 'POST') {
      const taskId = parseInt(taskAction[1], 10);
      if (taskAction[2] === 'pause') {
        sendJson(res, 200, { paused: pauseTaskRun(taskId) });
        return true;
      }
      if (taskAction[2] === 'stop') {
        sendJson(res, 200, { stopped: stopTaskRun(taskId) });
        return true;
      }
      const body = await readJsonBody(req).catch(() => ({}));
      let model = typeof (body as Record<string, unknown>)?.model === 'string'
        ? String((body as Record<string, unknown>).model)
        : null;
      // a model remembered by the browser may belong to a provider that is no longer set up
      const modelProvider = model ? providerForModel(model) : undefined;
      if (modelProvider && !isConfigured(modelProvider)) model = null;
      try {
        const run = taskAction[2] === 'run'
          ? startTaskRun(deps, taskId, model)
          : startTaskPlan(deps, taskId, model);
        sendJson(res, 200, run);
      } catch (exc) {
        throw new HttpError(400, errorMessage(exc));
      }
      return true;
    }
    if (/^\/api\/tasks\/[^/]+$/.test(pathname)) {
      if (method === 'PATCH') {
        const taskId = taskPathInt(pathname);
        const body = await readJsonBody(req);
        const fields = validateBody(body, [
          { name: 'title', kind: 'optString' },
          { name: 'detail', kind: 'optString' },
          { name: 'status', kind: 'optString' },
        ]);
        const patch: { title?: string; detail?: string; status?: 'todo' | 'in_progress' | 'done' } = {};
        if (typeof fields.title === 'string') patch.title = fields.title;
        if (typeof fields.detail === 'string') patch.detail = fields.detail;
        if (typeof fields.status === 'string') {
          if (!['todo', 'in_progress', 'done'].includes(fields.status)) {
            throw new HttpError(400, 'Invalid status');
          }
          patch.status = fields.status as 'todo' | 'in_progress' | 'done';
        }
        const parallel = (body as Record<string, unknown>).parallel;
        const task = deps.db.updateTask(taskId, typeof parallel === 'boolean' ? { ...patch, parallel } : patch);
        if (!task) throw new HttpError(404, 'Task not found');
        sendJson(res, 200, task);
        return true;
      }
      if (method === 'DELETE') {
        const taskId = taskPathInt(pathname);
        deps.db.deleteTask(taskId);
        sendJson(res, 200, { deleted: taskId });
        return true;
      }
      return false;
    }

    return false;
  } catch (exc) {
    if (exc instanceof HttpError) {
      sendJson(res, exc.status, { detail: exc.detail }, exc.headers);
      return true;
    }
    console.error(`[api] ${method} ${pathname} failed:`, exc);
    sendJson(res, 500, { detail: 'Internal Server Error' });
    return true;
  }
}

/**
 * Fallback for API paths the router did not answer: Starlette answers 405
 * (with the `Allow` header of the first partially matching route), then
 * redirects when only the trailing slash differs, and 404s otherwise.
 */
export function handleApiMiss(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): void {
  const method = req.method ?? 'GET';

  let partial: RouteSpec | undefined;
  for (const route of ROUTES) {
    if (!pathMatches(route, pathname)) continue;
    if (route.methods.includes(method)) {
      // `handleApi` owns every fully matching route — reaching here means the
      // dispatch table and the route table have drifted apart.
      sendJson(res, 404, { detail: 'Not Found' });
      return;
    }
    if (!partial) partial = route;
  }

  if (partial) {
    sendJson(
      res,
      405,
      { detail: 'Method Not Allowed' },
      { allow: partial.methods.join(', ') },
    );
    return;
  }

  // `redirect_slashes`: one alternative only, and only when it matches.
  if (pathname !== '/') {
    const candidate = pathname.endsWith('/')
      ? pathname.replace(/\/+$/, '')
      : pathname + '/';
    if (ROUTES.some((route) => pathMatches(route, candidate))) {
      const query = (req.url ?? '').includes('?')
        ? '?' + (req.url ?? '').split('?').slice(1).join('?')
        : '';
      sendRedirect(req, res, candidate + query);
      return;
    }
  }

  sendJson(res, 404, { detail: 'Not Found' });
}
