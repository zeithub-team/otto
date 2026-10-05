/**
 * SSH / SFTP client (in the spirit of Bitvise): key management, connections with host-key checking,
 * command execution and a full SFTP file browser. Private keys never leave the machine: they live in
 * `<dataDir>/ssh/keys` and the UI only ever sees public keys and fingerprints.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, utils, type ConnectConfig, type SFTPWrapper } from 'ssh2';

// ------------------------------------------------------------------ keys --

export type KeyType = 'ed25519' | 'rsa' | 'ecdsa';

export interface SshKeyInfo {
  id: string;
  name: string;
  type: string;
  bits?: number;
  comment: string;
  /** `SHA256:…` like `ssh-keygen -l`. */
  fingerprint: string;
  publicKey: string;
  encrypted: boolean;
  createdAt: number;
}

interface KeyIndexEntry extends SshKeyInfo {}

const keysDir = (dataDir: string): string => path.join(dataDir, 'ssh', 'keys');
const indexFile = (dataDir: string): string => path.join(keysDir(dataDir), 'index.json');

function readIndex(dataDir: string): KeyIndexEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile(dataDir), 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as KeyIndexEntry[]) : [];
  } catch {
    return [];
  }
}

function writeIndex(dataDir: string, list: KeyIndexEntry[]): void {
  fs.mkdirSync(keysDir(dataDir), { recursive: true });
  fs.writeFileSync(indexFile(dataDir), JSON.stringify(list, null, 2));
}

/** `SHA256:base64` of a public key blob (OpenSSH format, as shown by `ssh-keygen -l`). */
export function fingerprintOfBlob(blob: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

export function fingerprintOfPublicKey(publicKey: string): string {
  const b64 = publicKey.trim().split(/\s+/)[1] ?? '';
  return fingerprintOfBlob(Buffer.from(b64, 'base64'));
}

function describe(id: string, name: string, privateKey: string, passphrase: string | undefined, comment: string): SshKeyInfo {
  const parsed = utils.parseKey(privateKey, passphrase || undefined);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (key instanceof Error) {
    const encrypted = /passphrase|encrypted/i.test(key.message);
    throw new Error(encrypted ? 'The key is protected by a passphrase — enter the right one' : `Not a valid private key: ${key.message}`);
  }
  const publicBlob = key.getPublicSSH();
  const type = key.type;
  const publicKey = `${type} ${publicBlob.toString('base64')}${comment ? ' ' + comment : ''}`;
  return {
    id,
    name,
    type,
    bits: type === 'ssh-rsa' ? rsaBits(publicBlob) : undefined,
    comment,
    fingerprint: fingerprintOfBlob(publicBlob),
    publicKey,
    encrypted: Boolean(passphrase),
    createdAt: Date.now(),
  };
}

/** Modulus size from an ssh-rsa public blob (string "ssh-rsa", mpint e, mpint n). */
function rsaBits(blob: Buffer): number | undefined {
  try {
    let pos = 0;
    const skip = (): void => { const n = blob.readUInt32BE(pos); pos += 4 + n; };
    skip(); // "ssh-rsa"
    skip(); // e
    const nLen = blob.readUInt32BE(pos);
    pos += 4;
    const n = blob.subarray(pos, pos + nLen);
    const lead = n[0] === 0 ? 1 : 0;
    return (n.length - lead) * 8;
  } catch {
    return undefined;
  }
}

export function listKeys(dataDir: string): SshKeyInfo[] {
  return readIndex(dataDir).sort((a, b) => b.createdAt - a.createdAt);
}

function saveKey(dataDir: string, info: SshKeyInfo, privateKey: string): SshKeyInfo {
  const dir = keysDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${info.id}.key`);
  fs.writeFileSync(file, privateKey.endsWith('\n') ? privateKey : privateKey + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, `${info.id}.pub`), info.publicKey + '\n');
  writeIndex(dataDir, [...readIndex(dataDir), info]);
  return info;
}

export function generateKey(
  dataDir: string,
  opts: { name: string; type: KeyType; bits?: number; comment?: string; passphrase?: string },
): SshKeyInfo {
  const name = opts.name.trim() || `key-${new Date().toISOString().slice(0, 10)}`;
  const comment = (opts.comment ?? `${os.userInfo().username}@${os.hostname()}`).trim();
  const passphrase = opts.passphrase ? String(opts.passphrase) : undefined;
  const generated = utils.generateKeyPairSync(
    opts.type === 'rsa' ? 'rsa' : opts.type === 'ecdsa' ? 'ecdsa' : 'ed25519',
    {
      bits: opts.type === 'rsa' ? Math.max(2048, Math.min(8192, opts.bits ?? 4096)) : opts.type === 'ecdsa' ? 256 : undefined,
      comment,
      cipher: passphrase ? 'aes256-ctr' : undefined,
      passphrase,
      rounds: passphrase ? 16 : undefined,
    } as never,
  );
  const id = randomUUID();
  return saveKey(dataDir, describe(id, name, generated.private, passphrase, comment), generated.private);
}

export function importKey(dataDir: string, opts: { name: string; privateKey: string; passphrase?: string }): SshKeyInfo {
  const text = opts.privateKey.replace(/\r\n/g, '\n').trim();
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) throw new Error('This is not a private key (expected "-----BEGIN … PRIVATE KEY-----")');
  const id = randomUUID();
  const info = describe(id, opts.name.trim() || 'imported-key', text, opts.passphrase, '');
  return saveKey(dataDir, info, text);
}

export function deleteKey(dataDir: string, id: string): boolean {
  const list = readIndex(dataDir);
  if (!list.some((k) => k.id === id)) return false;
  for (const ext of ['key', 'pub']) fs.rmSync(path.join(keysDir(dataDir), `${id}.${ext}`), { force: true });
  writeIndex(dataDir, list.filter((k) => k.id !== id));
  return true;
}

export function renameKey(dataDir: string, id: string, name: string): boolean {
  const list = readIndex(dataDir);
  const entry = list.find((k) => k.id === id);
  if (!entry || !name.trim()) return false;
  entry.name = name.trim();
  writeIndex(dataDir, list);
  return true;
}

/** The private key text (only used inside this process to authenticate). */
function readPrivateKey(dataDir: string, id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Unknown key');
  try {
    return fs.readFileSync(path.join(keysDir(dataDir), `${id}.key`), 'utf8');
  } catch {
    throw new Error('Key not found — it may have been deleted');
  }
}

// ----------------------------------------------------------- known hosts --

const knownFile = (dataDir: string): string => path.join(dataDir, 'ssh', 'known_hosts.json');

function readKnown(dataDir: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(knownFile(dataDir), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export function forgetHost(dataDir: string, host: string, port: number): void {
  const known = readKnown(dataDir);
  delete known[`${host}:${port}`];
  fs.mkdirSync(path.dirname(knownFile(dataDir)), { recursive: true });
  fs.writeFileSync(knownFile(dataDir), JSON.stringify(known, null, 2));
}

function rememberHost(dataDir: string, host: string, port: number, fingerprint: string): void {
  const known = readKnown(dataDir);
  known[`${host}:${port}`] = fingerprint;
  fs.mkdirSync(path.dirname(knownFile(dataDir)), { recursive: true });
  fs.writeFileSync(knownFile(dataDir), JSON.stringify(known, null, 2));
}

/** What the UI must do about the server's key: nothing, ask the user, or refuse. */
export type HostCheck = 'known' | 'unknown' | 'changed';

export function checkHost(dataDir: string, host: string, port: number, fingerprint: string): HostCheck {
  const saved = readKnown(dataDir)[`${host}:${port}`];
  if (!saved) return 'unknown';
  return saved === fingerprint ? 'known' : 'changed';
}

// -------------------------------------------------------------- sessions --

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  /** Password, or a saved key (with its passphrase when it has one). */
  password?: string;
  keyId?: string;
  passphrase?: string;
  /** Fingerprint the user agreed to trust for a host that was not known yet. */
  trust?: string;
}

/** Thrown by `connect` when the host key needs the user's decision. */
export class HostKeyError extends Error {
  constructor(public readonly status: 'unknown' | 'changed', public readonly fingerprint: string, public readonly saved?: string) {
    super(status === 'unknown'
      ? `New host: the server key is ${fingerprint}. Check it and confirm to continue.`
      : `WARNING: the key of this server CHANGED (was ${saved}, now ${fingerprint}). This can be an attack; connect only if you know the server was reinstalled.`);
  }
}

interface Session {
  id: string;
  target: Pick<SshTarget, 'host' | 'port' | 'user'>;
  client: Client;
  sftp: SFTPWrapper | null;
  connectedAt: number;
  lastUsed: number;
  serverBanner: string;
}

const sessions = new Map<string, Session>();

export function listSessions(): Array<{ id: string; host: string; port: number; user: string; connectedAt: number }> {
  return Array.from(sessions.values()).map((s) => ({ id: s.id, host: s.target.host, port: s.target.port, user: s.target.user, connectedAt: s.connectedAt }));
}

export async function connect(dataDir: string, target: SshTarget): Promise<{ id: string; fingerprint: string; banner: string }> {
  if (!target.host.trim()) throw new Error('Host is required');
  if (!target.user.trim()) throw new Error('User is required');
  const port = Number(target.port) || 22;
  const config: ConnectConfig = {
    host: target.host.trim(),
    port,
    username: target.user.trim(),
    readyTimeout: 15_000,
    keepaliveInterval: 20_000,
    tryKeyboard: false,
  };
  if (target.keyId) {
    config.privateKey = readPrivateKey(dataDir, target.keyId);
    if (target.passphrase) config.passphrase = target.passphrase;
  } else {
    config.password = target.password ?? '';
  }

  let seen = '';
  let problem: HostKeyError | null = null;
  config.hostVerifier = (key: Buffer): boolean => {
    seen = fingerprintOfBlob(key);
    const state = checkHost(dataDir, config.host!, port, seen);
    if (state === 'known' || (state === 'unknown' && target.trust === seen)) return true;
    problem = new HostKeyError(state, seen, readKnown(dataDir)[`${config.host}:${port}`]);
    return false;
  };

  const client = new Client();
  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', (err: Error) => reject(problem ?? friendly(err)));
    client.once('close', () => reject(problem ?? new Error('Connection closed before it was established')));
    client.connect(config);
  });
  if (checkHost(dataDir, config.host!, port, seen) === 'unknown') rememberHost(dataDir, config.host!, port, seen);

  const id = randomUUID();
  const session: Session = {
    id,
    target: { host: config.host!, port, user: config.username! },
    client,
    sftp: null,
    connectedAt: Date.now(),
    lastUsed: Date.now(),
    serverBanner: '',
  };
  sessions.set(id, session);
  client.on('close', () => sessions.delete(id));
  client.on('error', () => sessions.delete(id));
  return { id, fingerprint: seen, banner: session.serverBanner };
}

function friendly(err: Error): Error {
  const m = err.message;
  if (/All configured authentication methods failed/i.test(m)) return new Error('Authentication failed: wrong password or the key is not authorised on the server');
  if (/ENOTFOUND|getaddrinfo/i.test(m)) return new Error('Host not found — check the address');
  if (/ECONNREFUSED/i.test(m)) return new Error('Connection refused — is an SSH server running on that port?');
  if (/ETIMEDOUT|Timed out while waiting for handshake/i.test(m)) return new Error('Timed out — the server did not answer');
  if (/passphrase/i.test(m)) return new Error('The key needs a passphrase (or it is wrong)');
  return err;
}

function getSession(id: string): Session {
  const s = sessions.get(id);
  if (!s) throw new Error('The session is closed — connect again');
  s.lastUsed = Date.now();
  return s;
}

export function disconnect(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  s.client.end();
  sessions.delete(id);
  return true;
}

export function disconnectAll(): void {
  for (const id of Array.from(sessions.keys())) disconnect(id);
}

// ------------------------------------------------------------- commands --

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  ms: number;
}

const MAX_OUTPUT = 512 * 1024;

export async function exec(id: string, command: string, timeoutMs = 60_000): Promise<ExecResult> {
  const s = getSession(id);
  const started = Date.now();
  return new Promise<ExecResult>((resolve, reject) => {
    s.client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      let code: number | null = null;
      const timer = setTimeout(() => {
        stream.close();
        stderr += '\n[timeout: the command was stopped]';
      }, timeoutMs);
      stream.on('data', (d: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8'); });
      stream.stderr.on('data', (d: Buffer) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8'); });
      stream.on('exit', (c: number | null) => { code = c; });
      stream.on('close', () => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code, ms: Date.now() - started });
      });
    });
  });
}

// ------------------------------------------------------------------ sftp --

async function sftpOf(id: string): Promise<SFTPWrapper> {
  const s = getSession(id);
  if (s.sftp) return s.sftp;
  s.sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    s.client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
  s.sftp.on('close', () => { s.sftp = null; });
  return s.sftp;
}

export interface RemoteEntry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  /** Unix seconds. */
  mtime: number;
  /** e.g. `rwxr-xr-x`. */
  mode: string;
}

const posix = path.posix;

export function joinRemote(dir: string, name: string): string {
  return posix.join(dir || '/', name);
}

export function modeString(mode: number): string {
  const bits = 'rwxrwxrwx';
  let out = '';
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? bits[i] : '-';
  return out;
}

function typeOf(mode: number): RemoteEntry['type'] {
  const kind = mode & 0o170000;
  return kind === 0o040000 ? 'dir' : kind === 0o100000 ? 'file' : kind === 0o120000 ? 'link' : 'other';
}

const call = <T>(fn: (cb: (err: Error | null | undefined, value?: T) => void) => void): Promise<T> =>
  new Promise<T>((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value as T))));

export async function realpath(id: string, target: string): Promise<string> {
  const sftp = await sftpOf(id);
  return call<string>((cb) => sftp.realpath(target || '.', cb));
}

export async function list(id: string, dir: string): Promise<{ path: string; entries: RemoteEntry[] }> {
  const sftp = await sftpOf(id);
  const here = await call<string>((cb) => sftp.realpath(dir || '.', cb));
  const raw = await call<Array<{ filename: string; attrs: { mode: number; size: number; mtime: number } }>>((cb) => sftp.readdir(here, cb as never));
  const entries = raw
    .filter((e) => e.filename !== '.' && e.filename !== '..')
    .map<RemoteEntry>((e) => ({
      name: e.filename,
      path: joinRemote(here, e.filename),
      type: typeOf(e.attrs.mode),
      size: e.attrs.size,
      mtime: e.attrs.mtime,
      mode: modeString(e.attrs.mode),
    }))
    .sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { path: here, entries };
}

export async function mkdir(id: string, dir: string): Promise<void> {
  const sftp = await sftpOf(id);
  await call<void>((cb) => sftp.mkdir(dir, cb as never));
}

export async function rename(id: string, from: string, to: string): Promise<void> {
  const sftp = await sftpOf(id);
  const exists = await call<unknown>((cb) => sftp.stat(to, (err, st) => cb(null, err ? null : st))).catch(() => null);
  if (exists) throw new Error('Already exists');
  await call<void>((cb) => sftp.rename(from, to, cb as never));
}

export async function chmod(id: string, target: string, mode: number): Promise<void> {
  const sftp = await sftpOf(id);
  await call<void>((cb) => sftp.chmod(target, mode, cb as never));
}

/** Delete a file, or a directory with everything in it. Refuses the root. */
export async function remove(id: string, target: string): Promise<void> {
  if (!target || target === '/' || target === '.') throw new Error('Refusing to delete the root');
  const sftp = await sftpOf(id);
  const st = await call<{ mode: number }>((cb) => sftp.lstat(target, cb as never));
  if (typeOf(st.mode) !== 'dir') {
    await call<void>((cb) => sftp.unlink(target, cb as never));
    return;
  }
  const { entries } = await list(id, target);
  for (const e of entries) await remove(id, e.path);
  await call<void>((cb) => sftp.rmdir(target, cb as never));
}

const MAX_TEXT = 2 * 1024 * 1024;

export async function readText(id: string, file: string): Promise<{ content: string; size: number; binary: boolean }> {
  const sftp = await sftpOf(id);
  const st = await call<{ size: number }>((cb) => sftp.stat(file, cb as never));
  if (st.size > MAX_TEXT) throw new Error(`The file is larger than ${MAX_TEXT / 1024 / 1024} MB — download it instead`);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const rs = sftp.createReadStream(file);
    rs.on('data', (c: Buffer) => chunks.push(c));
    rs.on('error', reject);
    rs.on('close', () => resolve());
  });
  const buf = Buffer.concat(chunks);
  const binary = buf.subarray(0, 4096).includes(0);
  return { content: binary ? '' : buf.toString('utf8'), size: st.size, binary };
}

export async function writeText(id: string, file: string, content: string): Promise<void> {
  const sftp = await sftpOf(id);
  await new Promise<void>((resolve, reject) => {
    const ws = sftp.createWriteStream(file);
    ws.on('error', reject);
    ws.on('close', () => resolve());
    ws.end(Buffer.from(content, 'utf8'));
  });
}

export async function writeBytes(id: string, file: string, data: Buffer): Promise<void> {
  const sftp = await sftpOf(id);
  await new Promise<void>((resolve, reject) => {
    const ws = sftp.createWriteStream(file);
    ws.on('error', reject);
    ws.on('close', () => resolve());
    ws.end(data);
  });
}

/** Copy a remote file or folder into a local folder; returns what was created. */
export async function download(id: string, remote: string, localDir: string): Promise<string> {
  const sftp = await sftpOf(id);
  fs.mkdirSync(localDir, { recursive: true });
  const name = posix.basename(remote);
  const target = path.join(localDir, name);
  const st = await call<{ mode: number }>((cb) => sftp.stat(remote, cb as never));
  if (typeOf(st.mode) === 'dir') {
    fs.mkdirSync(target, { recursive: true });
    const { entries } = await list(id, remote);
    for (const e of entries) await download(id, e.path, target);
    return target;
  }
  await call<void>((cb) => sftp.fastGet(remote, target, cb as never));
  return target;
}

/** Copy a local file or folder to a remote folder. */
export async function upload(id: string, localPath: string, remoteDir: string): Promise<string> {
  const sftp = await sftpOf(id);
  const target = joinRemote(remoteDir, path.basename(localPath));
  const st = fs.statSync(localPath);
  if (st.isDirectory()) {
    await call<void>((cb) => sftp.mkdir(target, (err) => cb(err && /exist|failure/i.test(err.message) ? null : err))).catch(() => undefined);
    for (const child of fs.readdirSync(localPath)) await upload(id, path.join(localPath, child), target);
    return target;
  }
  await call<void>((cb) => sftp.fastPut(localPath, target, cb as never));
  return target;
}

export function downloadsDir(): string {
  return path.join(os.homedir(), 'Downloads');
}

// ----------------------------------------------------------- local files --

export interface LocalEntry { name: string; path: string; type: 'dir' | 'file'; size: number; mtime: number }

/** Drives on Windows, `/` elsewhere: the top of the local tree. */
function localRoots(): LocalEntry[] {
  if (process.platform !== 'win32') return [{ name: '/', path: '/', type: 'dir', size: 0, mtime: 0 }];
  const out: LocalEntry[] = [];
  for (let c = 65; c <= 90; c++) {
    const p = String.fromCharCode(c) + ':\\';
    try { fs.accessSync(p); out.push({ name: p, path: p, type: 'dir', size: 0, mtime: 0 }); } catch { /* no such drive */ }
  }
  return out;
}

/** List a folder on this computer (for the left pane of the file manager). An empty path means the home folder. */
export function listLocal(dir: string): { path: string; parent: string | null; home: string; entries: LocalEntry[] } {
  const home = os.homedir();
  const target = dir === '::roots' ? '' : path.resolve(dir || home);
  if (dir === '::roots') return { path: '', parent: null, home, entries: localRoots() };
  const entries: LocalEntry[] = [];
  for (const d of fs.readdirSync(target, { withFileTypes: true })) {
    try {
      const full = path.join(target, d.name);
      const st = fs.statSync(full);
      entries.push({ name: d.name, path: full, type: st.isDirectory() ? 'dir' : 'file', size: st.isDirectory() ? 0 : st.size, mtime: Math.floor(st.mtimeMs / 1000) });
    } catch { /* unreadable entry (locked file, broken link): skip it */ }
  }
  entries.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const up = path.dirname(target);
  return { path: target, parent: up === target ? '::roots' : up, home, entries };
}

export function mkdirLocal(dir: string): void {
  fs.mkdirSync(path.resolve(dir), { recursive: false });
}

// ---------------------------------------------------------------- secrets --

/**
 * Saved passwords and key passphrases. They are encrypted with the operating system's store
 * (DPAPI on Windows, Keychain on macOS) through Electron's safeStorage when it is available;
 * otherwise with a random key kept next to the file (protects from casual reading, not from
 * someone who can read the whole folder). They never go back to the UI.
 */
const secretsFile = (dataDir: string): string => path.join(dataDir, 'ssh', 'secrets.json');

interface OsStore { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string }

function osStore(): OsStore | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { safeStorage?: OsStore };
    return electron.safeStorage?.isEncryptionAvailable() ? electron.safeStorage : null;
  } catch {
    return null;
  }
}

function fallbackKey(dataDir: string): Buffer {
  const file = path.join(dataDir, 'ssh', 'secrets.key');
  try {
    return Buffer.from(fs.readFileSync(file, 'utf8'), 'base64');
  } catch {
    const key = randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 });
    return key;
  }
}

export function seal(dataDir: string, text: string): string {
  const os_ = osStore();
  if (os_) return 'os:' + os_.encryptString(text).toString('base64');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', fallbackKey(dataDir), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return 'aes:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

export function unseal(dataDir: string, stored: string): string | null {
  try {
    if (stored.startsWith('os:')) return osStore()?.decryptString(Buffer.from(stored.slice(3), 'base64')) ?? null;
    const raw = Buffer.from(stored.slice(4), 'base64');
    const d = createDecipheriv('aes-256-gcm', fallbackKey(dataDir), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

type SecretBook = Record<string, { password?: string; passphrase?: string }>;

function readBook(dataDir: string): SecretBook {
  try { return JSON.parse(fs.readFileSync(secretsFile(dataDir), 'utf8')) as SecretBook; } catch { return {}; }
}

export function saveSecret(dataDir: string, profileId: string, secret: { password?: string; passphrase?: string }): void {
  if (!/^[0-9a-f-]{36}$/.test(profileId)) throw new Error('Unknown profile');
  const book = readBook(dataDir);
  book[profileId] = {
    ...(secret.password ? { password: seal(dataDir, secret.password) } : {}),
    ...(secret.passphrase ? { passphrase: seal(dataDir, secret.passphrase) } : {}),
  };
  fs.mkdirSync(path.dirname(secretsFile(dataDir)), { recursive: true });
  fs.writeFileSync(secretsFile(dataDir), JSON.stringify(book), { mode: 0o600 });
}

export function forgetSecret(dataDir: string, profileId: string): void {
  const book = readBook(dataDir);
  if (!(profileId in book)) return;
  delete book[profileId];
  fs.writeFileSync(secretsFile(dataDir), JSON.stringify(book), { mode: 0o600 });
}

/** Which profiles have something saved (ids only). */
export function savedSecretIds(dataDir: string): string[] {
  return Object.keys(readBook(dataDir));
}

export function loadSecret(dataDir: string, profileId: string): { password?: string; passphrase?: string } {
  const entry = readBook(dataDir)[profileId];
  if (!entry) return {};
  return {
    password: entry.password ? unseal(dataDir, entry.password) ?? undefined : undefined,
    passphrase: entry.passphrase ? unseal(dataDir, entry.passphrase) ?? undefined : undefined,
  };
}
