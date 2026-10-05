/**
 * SQLite layer of the embedded otto server.
 *
 * TypeScript port of `backend/utils/db.py` on top of `node-sqlite3-wasm`
 * (a WASM build of SQLite — no native compilation, works inside Electron).
 *
 * The schema, the legacy-schema migration and every query are kept identical
 * to the Python source so both backends can share the same `app.db`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Database } from 'node-sqlite3-wasm';

/** Values SQLite can hand back to JS. */
export type SqlValue = string | number | bigint | Uint8Array | null;
export type Row = Record<string, SqlValue>;

/** Shape returned by `get_messages()` (key order matches the Python dicts). */
export interface ChatMessage {
  id: string;
  role: string;
  content: string;
  images: unknown[] | null;
  isError: boolean;
  timestamp: number;
  projectId: number;
}

/** Row of the `projects` table. */
export interface ProjectRow {
  id: number;
  name: string;
  path: string;
  created_at: string;
}

export class Db {
  /** Absolute path of the database file. */
  readonly filePath: string;
  private readonly conn: Database;
  private closed = false;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.conn = new Database(this.filePath);
    this.init();
  }

  /** `init_db()` — schema creation + legacy INTEGER-id messages migration. */
  private init(): void {
    const conn = this.conn;
    conn.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    conn.exec(`
      CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name)
    `);

    // accounts: local Git identities (multi-account). Each project belongs to
    // one account, so switching account shows a different set of projects.
    conn.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL DEFAULT 'github',
        username TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        avatar_url TEXT NOT NULL DEFAULT '',
        token TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      )
    `);

    // projects.account_id — added by migration for existing databases.
    const projCols = conn.all('PRAGMA table_info(projects)') as Row[];
    const hasAccountId = projCols.some((c) => String(c.name).toLowerCase() === 'account_id');
    if (!hasAccountId) {
      conn.exec('ALTER TABLE projects ADD COLUMN account_id INTEGER');
    }

    // messages: id must be TEXT (matches client-side ids / uuid message_ids).
    // Detect the legacy INTEGER-id schema precisely via table_info — a plain
    // substring check on the CREATE SQL would false-positive on "project_id INTEGER".
    const msgTable = conn.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'",
    );
    if (msgTable) {
      // PRAGMA table_info rows are ordered by column; the first row is `id`.
      const idCol = conn.get('PRAGMA table_info(messages)') as Row | null;
      if (
        idCol &&
        String(idCol.name ?? '').toLowerCase() === 'id' &&
        String(idCol.type ?? '').toUpperCase().startsWith('INT')
      ) {
        conn.exec('DROP TABLE messages'); // pre-release schema, no data worth keeping
      }
    }
    conn.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        images TEXT,
        is_error INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);
    conn.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_project
      ON messages(project_id, created_at)
    `);

    // chats: multiple conversations per project (hierarchy in the sidebar).
    conn.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT 'Новый чат',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);
    conn.exec('CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id, created_at)');

    // messages.chat_id — added by migration; existing rows are grouped into one
    // default chat per project so old history stays reachable.
    const msgCols = conn.all('PRAGMA table_info(messages)') as Row[];
    const hasChatId = msgCols.some((c) => String(c.name).toLowerCase() === 'chat_id');
    if (!hasChatId) {
      conn.exec('ALTER TABLE messages ADD COLUMN chat_id INTEGER');
      const projects = conn.all('SELECT DISTINCT project_id FROM messages WHERE chat_id IS NULL') as Row[];
      const now = Date.now();
      for (const p of projects) {
        const pid = Number(p.project_id);
        // Skip orphan messages whose project no longer exists — inserting a chat
        // for them would violate the FK and abort startup.
        const projectExists = conn.get('SELECT 1 FROM projects WHERE id = ?', [pid]);
        if (!projectExists) {
          conn.run('DELETE FROM messages WHERE project_id = ? AND chat_id IS NULL', [pid]);
          continue;
        }
        const res = conn.run(
          'INSERT INTO chats (project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
          [pid, 'Чат 1', now, now],
        );
        conn.run('UPDATE messages SET chat_id = ? WHERE project_id = ? AND chat_id IS NULL', [Number(res.lastInsertRowid), pid]);
      }
    }
    conn.exec('CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at)');

    // tasks: right-hand task board (created by the user or the AI agent).
    conn.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo',
        source TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);
    conn.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_project
      ON tasks(project_id, created_at)
    `);
    // settings: small key/value store (provider API keys, …).
    conn.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    // Steps (checklist items) are tasks that point at a parent task.
    const taskCols = conn.all('PRAGMA table_info(tasks)') as Row[];
    if (!taskCols.some((c) => c.name === 'parent_id')) {
      conn.exec('ALTER TABLE tasks ADD COLUMN parent_id INTEGER');
    }
    conn.exec('CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id)');
    // A step marked `parallel` runs together with the step before it
    if (!taskCols.some((c) => c.name === 'parallel')) {
      conn.exec('ALTER TABLE tasks ADD COLUMN parallel INTEGER NOT NULL DEFAULT 0');
    }

    // project_logs: per-project run history — prompt, model, tool calls, answer.
    conn.exec(`
      CREATE TABLE IF NOT EXISTS project_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        chat_id INTEGER,
        prompt TEXT NOT NULL DEFAULT '',
        model TEXT,
        tools TEXT,
        answer TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);
    conn.exec('CREATE INDEX IF NOT EXISTS idx_logs_project ON project_logs(project_id, created_at)');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.conn.close();
  }

  // ---------------------------------------------------------------- queries

  /**
   * `save_message()` — insert or replace a chat message (replace keeps
   * idempotent retries safe). Timestamps are normalised to milliseconds.
   */
  saveMessage(
    msgId: string,
    projectId: number,
    chatId: number,
    role: string,
    content: string,
    images?: unknown[] | null,
    isError = false,
    createdAt?: number | null,
  ): void {
    let ts: number;
    if (createdAt === undefined || createdAt === null) {
      ts = Date.now();
    } else if (createdAt < 10 ** 12) {
      ts = Math.trunc(createdAt) * 1000;
    } else {
      ts = Math.trunc(createdAt);
    }
    this.conn.run(
      `INSERT OR REPLACE INTO messages
       (id, project_id, chat_id, role, content, images, is_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msgId,
        projectId,
        chatId,
        role,
        content,
        images && images.length ? JSON.stringify(images) : null,
        isError ? 1 : 0,
        ts,
      ],
    );
    this.conn.run('UPDATE chats SET updated_at = ? WHERE id = ?', [Date.now(), chatId]);
  }

  /** `get_messages()` — history for one chat, oldest first. */
  getMessages(chatId: number, limit = 500): ChatMessage[] {
    const rows = this.conn.all(
      `SELECT id, project_id, role, content, images, is_error, created_at
       FROM messages WHERE chat_id = ?
       ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      [chatId, limit],
    ) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      role: String(r.role),
      content: String(r.content ?? ''),
      images: r.images ? (JSON.parse(String(r.images)) as unknown[]) : null,
      isError: Boolean(r.is_error),
      timestamp: Number(r.created_at),
      projectId: Number(r.project_id),
    }));
  }

  /** Wipe one chat's messages. */
  deleteMessages(chatId: number): void {
    this.conn.run('DELETE FROM messages WHERE chat_id = ?', [chatId]);
  }

  // ------------------------------------------------------------------ chats

  listChats(projectId: number): ChatRow[] {
    const rows = this.conn.all(
      'SELECT id, project_id, title, created_at, updated_at FROM chats WHERE project_id = ? ORDER BY created_at ASC',
      [projectId],
    ) as Row[];
    return rows.map(toChatRow);
  }

  createChat(projectId: number, title = 'Новый чат'): ChatRow {
    const now = Date.now();
    const res = this.conn.run(
      'INSERT INTO chats (project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [projectId, title, now, now],
    );
    return this.getChat(Number(res.lastInsertRowid))!;
  }

  getChat(id: number): ChatRow | null {
    const row = this.conn.get(
      'SELECT id, project_id, title, created_at, updated_at FROM chats WHERE id = ?',
      [id],
    ) as Row | null;
    return row ? toChatRow(row) : null;
  }

  renameChat(id: number, title: string): ChatRow | null {
    this.conn.run('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?', [title, Date.now(), id]);
    return this.getChat(id);
  }

  deleteChat(id: number): void {
    this.conn.run('DELETE FROM messages WHERE chat_id = ?', [id]);
    this.conn.run('DELETE FROM chats WHERE id = ?', [id]);
  }

  /** First chat of a project, creating one if none exists. */
  ensureChat(projectId: number): ChatRow {
    const existing = this.listChats(projectId);
    return existing[0] ?? this.createChat(projectId, 'Чат 1');
  }

  /** Single message deletion (used when regenerating a reply). */
  deleteMessage(msgId: string): void {
    this.conn.run('DELETE FROM messages WHERE id = ?', [msgId]);
  }

  /**
   * Projects for an account. `accountId` > 0 filters to that account; `0`,
   * `null` or `undefined` returns the local bucket (projects with no account).
   */
  listProjects(accountId?: number | null): ProjectRow[] {
    const rows = accountId && accountId > 0
      ? this.conn.all('SELECT id, name, path, created_at FROM projects WHERE account_id = ?', [accountId]) as Row[]
      : this.conn.all('SELECT id, name, path, created_at FROM projects WHERE account_id IS NULL') as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      path: String(r.path),
      created_at: String(r.created_at),
    }));
  }

  /** `SELECT path FROM projects WHERE id = ?` */
  getProjectPath(projectId: number): string | null {
    const row = this.conn.get('SELECT path FROM projects WHERE id = ?', [
      projectId,
    ]) as Row | null;
    return row ? String(row.path) : null;
  }

  /** `SELECT id FROM projects WHERE path = ?` */
  findProjectByPath(projectPath: string): number | null {
    const row = this.conn.get('SELECT id FROM projects WHERE path = ?', [
      projectPath,
    ]) as Row | null;
    return row ? Number(row.id) : null;
  }

  /** `SELECT id, name, path, created_at FROM projects WHERE id = ?` */
  getProject(projectId: number): ProjectRow | null {
    const row = this.conn.get(
      'SELECT id, name, path, created_at FROM projects WHERE id = ?',
      [projectId],
    ) as Row | null;
    if (!row) return null;
    return {
      id: Number(row.id),
      name: String(row.name),
      path: String(row.path),
      created_at: String(row.created_at),
    };
  }

  /** `UPDATE projects SET name = ?, path = ?, updated_at = CURRENT_TIMESTAMP` */
  updateProject(projectId: number, name: string, projectPath: string): void {
    this.conn.run(
      `UPDATE projects SET name = ?, path = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [name, projectPath, projectId],
    );
  }

  /** `INSERT INTO projects (name, path, account_id) VALUES (?, ?, ?)` */
  createProject(name: string, projectPath: string, accountId?: number | null): number {
    const res = this.conn.run(
      'INSERT INTO projects (name, path, account_id) VALUES (?, ?, ?)',
      [name, projectPath, accountId && accountId > 0 ? accountId : null],
    );
    return Number(res.lastInsertRowid);
  }

  /** `DELETE FROM projects WHERE id = ?` */
  deleteProject(projectId: number): void {
    this.conn.run('DELETE FROM projects WHERE id = ?', [projectId]);
  }

  // --------------------------------------------------------------- settings

  getSetting(key: string): string {
    const row = this.conn.get('SELECT value FROM settings WHERE key = ?', [key]) as Row | null;
    return row ? String(row.value ?? '') : '';
  }

  /** Empty value removes the setting. */
  setSetting(key: string, value: string): void {
    if (!value) {
      this.conn.run('DELETE FROM settings WHERE key = ?', [key]);
      return;
    }
    this.conn.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value],
    );
  }

  // ------------------------------------------------------------------ tasks

  /** Tasks for a project, newest first. */
  listTasks(projectId: number): TaskRow[] {
    const rows = this.conn.all(
      `SELECT id, project_id, parent_id, title, detail, status, source, parallel, created_at, updated_at
       FROM tasks WHERE project_id = ? ORDER BY
         CASE status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END,
         created_at DESC`,
      [projectId],
    ) as Row[];
    return rows.map(toTaskRow);
  }

  createTask(
    projectId: number,
    title: string,
    detail = '',
    source: TaskRow['source'] = 'user',
    parentId: number | null = null,
    parallel = false,
  ): TaskRow {
    const now = Date.now();
    const res = this.conn.run(
      `INSERT INTO tasks (project_id, parent_id, title, detail, status, source, parallel, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'todo', ?, ?, ?, ?)`,
      [projectId, parentId, title, detail, source, parallel ? 1 : 0, now, now],
    );
    return this.getTask(Number(res.lastInsertRowid))!;
  }

  getTask(id: number): TaskRow | null {
    const row = this.conn.get(
      `SELECT id, project_id, parent_id, title, detail, status, source, parallel, created_at, updated_at
       FROM tasks WHERE id = ?`,
      [id],
    ) as Row | null;
    return row ? toTaskRow(row) : null;
  }

  updateTask(
    id: number,
    patch: { title?: string; detail?: string; status?: TaskRow['status']; parallel?: boolean },
  ): TaskRow | null {
    const current = this.getTask(id);
    if (!current) return null;
    const title = patch.title ?? current.title;
    const detail = patch.detail ?? current.detail;
    const status = patch.status ?? current.status;
    const parallel = patch.parallel ?? current.parallel;
    this.conn.run(
      `UPDATE tasks SET title = ?, detail = ?, status = ?, parallel = ?, updated_at = ? WHERE id = ?`,
      [title, detail, status, parallel ? 1 : 0, Date.now(), id],
    );
    return this.getTask(id);
  }

  deleteTask(id: number): void {
    this.conn.run('DELETE FROM tasks WHERE parent_id = ?', [id]);
    this.conn.run('DELETE FROM tasks WHERE id = ?', [id]);
  }

  /** Checklist steps of a task, in creation order. */
  listSteps(parentId: number): TaskRow[] {
    const rows = this.conn.all(
      `SELECT id, project_id, parent_id, title, detail, status, source, parallel, created_at, updated_at
       FROM tasks WHERE parent_id = ? ORDER BY id`,
      [parentId],
    ) as Row[];
    return rows.map(toTaskRow);
  }

  // ------------------------------------------------------------ project logs

  addProjectLog(
    projectId: number,
    chatId: number | null,
    entry: { prompt: string; model: string | null; tools: unknown; answer: string },
  ): void {
    this.conn.run(
      `INSERT INTO project_logs (project_id, chat_id, prompt, model, tools, answer, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [projectId, chatId, entry.prompt, entry.model, JSON.stringify(entry.tools ?? []), entry.answer, Date.now()],
    );
  }

  listProjectLogs(projectId: number, limit = 100): Array<Record<string, unknown>> {
    const rows = this.conn.all(
      `SELECT id, chat_id, prompt, model, tools, answer, created_at
       FROM project_logs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
      [projectId, limit],
    ) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      chatId: r.chat_id === null ? null : Number(r.chat_id),
      prompt: String(r.prompt ?? ''),
      model: r.model === null ? null : String(r.model),
      tools: r.tools ? JSON.parse(String(r.tools)) : [],
      answer: String(r.answer ?? ''),
      created_at: Number(r.created_at),
    }));
  }

  // --------------------------------------------------------------- accounts

  /** All Git accounts (without tokens — never leaves the server). */
  listAccounts(): AccountRow[] {
    const rows = this.conn.all(
      'SELECT id, provider, username, display_name, avatar_url, created_at FROM accounts ORDER BY created_at ASC',
    ) as Row[];
    return rows.map(toAccountRow);
  }

  createAccount(a: {
    provider: string;
    username: string;
    displayName?: string;
    avatarUrl?: string;
    token: string;
  }): AccountRow {
    const res = this.conn.run(
      `INSERT INTO accounts (provider, username, display_name, avatar_url, token, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [a.provider, a.username, a.displayName ?? a.username, a.avatarUrl ?? '', a.token, Date.now()],
    );
    return this.getAccount(Number(res.lastInsertRowid))!;
  }

  getAccount(id: number): AccountRow | null {
    const row = this.conn.get(
      'SELECT id, provider, username, display_name, avatar_url, created_at FROM accounts WHERE id = ?',
      [id],
    ) as Row | null;
    return row ? toAccountRow(row) : null;
  }

  /** Stored token for server-side Git/API calls (never sent to the client). */
  getAccountToken(id: number): string | null {
    const row = this.conn.get('SELECT token FROM accounts WHERE id = ?', [id]) as Row | null;
    return row ? String(row.token ?? '') : null;
  }

  deleteAccount(id: number): void {
    // Projects keep existing but return to the local bucket.
    this.conn.run('UPDATE projects SET account_id = NULL WHERE account_id = ?', [id]);
    this.conn.run('DELETE FROM accounts WHERE id = ?', [id]);
  }
}

/** Row of the `chats` table. */
export interface ChatRow {
  id: number;
  project_id: number;
  title: string;
  created_at: number;
  updated_at: number;
}

function toChatRow(r: Row): ChatRow {
  return {
    id: Number(r.id),
    project_id: Number(r.project_id),
    title: String(r.title ?? 'Новый чат'),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

/** Public account shape (no token). */
export interface AccountRow {
  id: number;
  provider: string;
  username: string;
  display_name: string;
  avatar_url: string;
  created_at: number;
}

function toAccountRow(r: Row): AccountRow {
  return {
    id: Number(r.id),
    provider: String(r.provider ?? 'github'),
    username: String(r.username ?? ''),
    display_name: String(r.display_name ?? ''),
    avatar_url: String(r.avatar_url ?? ''),
    created_at: Number(r.created_at),
  };
}

/** Row of the `tasks` table (camel-mapped in `toTaskRow`). */
export interface TaskRow {
  id: number;
  project_id: number;
  /** Set for checklist steps; null for top-level tasks. */
  parent_id: number | null;
  title: string;
  detail: string;
  status: 'todo' | 'in_progress' | 'done';
  source: 'user' | 'agent';
  /** Steps only: runs together with the step before it. */
  parallel: boolean;
  created_at: number;
  updated_at: number;
}

function toTaskRow(r: Row): TaskRow {
  const status = String(r.status ?? 'todo');
  const source = String(r.source ?? 'user');
  return {
    id: Number(r.id),
    project_id: Number(r.project_id),
    parent_id: r.parent_id === null || r.parent_id === undefined ? null : Number(r.parent_id),
    title: String(r.title ?? ''),
    detail: String(r.detail ?? ''),
    status: (status === 'in_progress' || status === 'done' ? status : 'todo') as TaskRow['status'],
    source: (source === 'agent' ? 'agent' : 'user') as TaskRow['source'],
    parallel: Number(r.parallel ?? 0) === 1,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}
