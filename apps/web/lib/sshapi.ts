import { API_BASE } from './api';

export interface SshKey {
  id: string;
  name: string;
  type: string;
  bits?: number;
  comment: string;
  fingerprint: string;
  publicKey: string;
  encrypted: boolean;
  createdAt: number;
}

export interface RemoteEntry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  mtime: number;
  mode: string;
}

export interface SshProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: 'password' | 'key';
  keyId?: string;
  /** Folder to open first. */
  startPath?: string;
}

export type ConnectAnswer =
  | { status: 'connected'; id: string; fingerprint: string }
  | { status: 'unknown' | 'changed'; fingerprint: string; saved?: string; message: string };

async function post<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${API_BASE}/api/ssh/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : typeof data?.detail === 'string' ? data.detail : `HTTP ${res.status}`);
  return data as T;
}

export const sshKeys = () => post<{ keys: SshKey[] }>('keys').then((r) => r.keys);
export const sshGenerateKey = (o: { name: string; type: 'ed25519' | 'rsa' | 'ecdsa'; bits?: number; comment?: string; passphrase?: string }) => post<SshKey>('keys/generate', o);
export const sshImportKey = (o: { name: string; privateKey: string; passphrase?: string }) => post<SshKey>('keys/import', o);
export const sshDeleteKey = (id: string) => post<{ deleted: boolean }>('keys/delete', { id });
export const sshRenameKey = (id: string, name: string) => post<{ renamed: boolean }>('keys/rename', { id, name });

export const sshConnect = (p: SshProfile, secret: { password?: string; passphrase?: string; trust?: string; useSaved?: boolean }) =>
  post<ConnectAnswer>('connect', { host: p.host, port: p.port, user: p.user, keyId: p.auth === 'key' ? p.keyId : undefined, profileId: p.id, ...secret });
export const sshSaveSecret = (profileId: string, secret: { password?: string; passphrase?: string }) => post<{ ok: boolean }>('secret/set', { profileId, ...secret });
export const sshForgetSecret = (profileId: string) => post<{ ok: boolean }>('secret/forget', { profileId });
export const sshSavedSecretIds = () => post<{ ids: string[] }>('secret/ids').then((r) => r.ids);
export const sshDisconnect = (session: string) => post<{ closed: boolean }>('disconnect', { session });
export const sshForgetHost = (host: string, port: number) => post<{ ok: boolean }>('forget-host', { host, port });
export const sshExec = (session: string, command: string, timeout = 60) => post<{ stdout: string; stderr: string; code: number | null; ms: number }>('exec', { session, command, timeout });

export const sftpList = (session: string, path: string) => post<{ path: string; entries: RemoteEntry[] }>('sftp/list', { session, path });
export const sftpMkdir = (session: string, path: string) => post<{ ok: boolean }>('sftp/mkdir', { session, path });
export const sftpRename = (session: string, from: string, to: string) => post<{ ok: boolean }>('sftp/rename', { session, from, to });
export const sftpChmod = (session: string, path: string, mode: string) => post<{ ok: boolean }>('sftp/chmod', { session, path, mode });
export const sftpDelete = (session: string, path: string) => post<{ ok: boolean }>('sftp/delete', { session, path });
export const sftpRead = (session: string, path: string) => post<{ content: string; size: number; binary: boolean }>('sftp/read', { session, path });
export const sftpWrite = (session: string, path: string, content: string) => post<{ ok: boolean }>('sftp/write', { session, path, content });
export const sftpDownload = (session: string, path: string) => post<{ path: string }>('sftp/download', { session, path });
export const sftpUploadLocal = (session: string, local: string, remoteDir: string) => post<{ path: string }>('sftp/upload', { session, local, remoteDir });

/** Browser-picked file: sent as base64 (for files that have no path on disk). */
export async function sftpUploadFile(session: string, remoteDir: string, file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  await post('sftp/upload-bytes', { session, remoteDir, name: file.name, data: btoa(binary) });
}

// ------------------------------------------------------------- profiles --

const PROFILES_KEY = 'otto-ssh-profiles';

export function loadProfiles(): SshProfile[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PROFILES_KEY) || '[]') as unknown;
    return Array.isArray(parsed) ? (parsed as SshProfile[]) : [];
  } catch {
    return [];
  }
}

export function saveProfiles(list: SshProfile[]): void {
  try { window.localStorage.setItem(PROFILES_KEY, JSON.stringify(list)); } catch { /* storage blocked */ }
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function parentOf(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i <= 0 ? '/' : trimmed.slice(0, i);
}

// ------------------------------------------------------------ local files --

export interface LocalEntry { name: string; path: string; type: 'dir' | 'file'; size: number; mtime: number }
export interface LocalListing { path: string; parent: string | null; home: string; entries: LocalEntry[] }

export async function localList(path: string): Promise<LocalListing> {
  const res = await fetch(`${API_BASE}/api/ssh/local/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`);
  return data as LocalListing;
}

export const sftpDownloadTo = (session: string, path: string, localDir: string) => post<{ path: string }>('sftp/download', { session, path, localDir });

export const localMkdir = (path: string) => fetch(`${API_BASE}/api/ssh/local/mkdir`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) }).then(async (r) => { if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`); });
