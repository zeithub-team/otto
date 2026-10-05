/** `/api/ssh/*` endpoints: one handler per action, all POST with a JSON body. */

import path from 'node:path';
import {
  HostKeyError, chmod, forgetSecret, loadSecret, saveSecret, savedSecretIds, connect, deleteKey, disconnect, download, downloadsDir, exec, forgetHost, generateKey, importKey,
  list, listKeys, listLocal, mkdirLocal, listSessions, mkdir, readText, remove, rename, renameKey, upload, writeBytes, writeText, type KeyType,
} from './sshclient';

export const SSH_ROUTES: ReadonlyArray<{ path: string; methods: string[] }> = [
  'keys', 'keys/generate', 'keys/import', 'keys/delete', 'keys/rename', 'sessions', 'connect', 'disconnect', 'forget-host',
  'exec', 'sftp/list', 'sftp/mkdir', 'sftp/rename', 'sftp/chmod', 'sftp/delete', 'sftp/read', 'sftp/write', 'sftp/upload',
  'sftp/upload-bytes', 'sftp/download', 'local/list', 'local/mkdir', 'secret/set', 'secret/forget', 'secret/ids',
].map((p) => ({ path: `/api/ssh/${p}`, methods: ['POST'] }));

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Returns the JSON payload, or undefined when the path is not an SSH route. */
export async function handleSshRoute(
  pathname: string,
  body: Record<string, unknown>,
  dataDir: string,
): Promise<{ payload: unknown } | undefined> {
  if (!pathname.startsWith('/api/ssh/')) return undefined;
  const action = pathname.slice('/api/ssh/'.length);
  const id = str(body.session);
  const reply = (payload: unknown) => ({ payload });

  switch (action) {
    case 'keys':
      return reply({ keys: listKeys(dataDir) });
    case 'keys/generate':
      return reply(generateKey(dataDir, {
        name: str(body.name),
        type: (['ed25519', 'rsa', 'ecdsa'].includes(str(body.type)) ? str(body.type) : 'ed25519') as KeyType,
        bits: Number(body.bits) || undefined,
        comment: typeof body.comment === 'string' ? body.comment : undefined,
        passphrase: str(body.passphrase) || undefined,
      }));
    case 'keys/import':
      return reply(importKey(dataDir, { name: str(body.name), privateKey: str(body.privateKey), passphrase: str(body.passphrase) || undefined }));
    case 'keys/delete':
      return reply({ deleted: deleteKey(dataDir, str(body.id)) });
    case 'keys/rename':
      return reply({ renamed: renameKey(dataDir, str(body.id), str(body.name)) });
    case 'sessions':
      return reply({ sessions: listSessions() });
    case 'connect': {
      try {
        const saved = body.useSaved === true ? loadSecret(dataDir, str(body.profileId)) : {};
        const target = {
          host: str(body.host), port: Number(body.port) || 22, user: str(body.user),
          password: str(body.password) || saved.password || '', keyId: str(body.keyId) || undefined, passphrase: str(body.passphrase) || saved.passphrase || undefined,
          trust: str(body.trust) || undefined,
        };
        return reply({ status: 'connected', ...(await connect(dataDir, target)) });
      } catch (exc) {
        // a host key that needs the user's decision is a normal answer, not a failure
        if (exc instanceof HostKeyError) return reply({ status: exc.status, fingerprint: exc.fingerprint, saved: exc.saved, message: exc.message });
        throw exc;
      }
    }
    case 'disconnect':
      return reply({ closed: disconnect(id) });
    case 'forget-host':
      forgetHost(dataDir, str(body.host), Number(body.port) || 22);
      return reply({ ok: true });
    case 'exec':
      return reply(await exec(id, str(body.command), Math.min(300, Math.max(1, Number(body.timeout) || 60)) * 1000));
    case 'sftp/list':
      return reply(await list(id, str(body.path)));
    case 'sftp/mkdir':
      await mkdir(id, str(body.path));
      return reply({ ok: true });
    case 'sftp/rename':
      await rename(id, str(body.from), str(body.to));
      return reply({ ok: true });
    case 'sftp/chmod': {
      const mode = parseInt(str(body.mode), 8);
      if (!Number.isFinite(mode) || mode < 0 || mode > 0o7777) throw new Error('Mode must be octal, e.g. 644 or 755');
      await chmod(id, str(body.path), mode);
      return reply({ ok: true });
    }
    case 'sftp/delete':
      await remove(id, str(body.path));
      return reply({ ok: true });
    case 'sftp/read':
      return reply(await readText(id, str(body.path)));
    case 'sftp/write':
      await writeText(id, str(body.path), str(body.content));
      return reply({ ok: true });
    case 'sftp/upload':
      return reply({ path: await upload(id, path.resolve(str(body.local)), str(body.remoteDir)) });
    case 'sftp/upload-bytes': {
      // a file picked in the browser: its bytes come base64-encoded
      const name = path.posix.basename(str(body.name).replace(/\\/g, '/'));
      if (!name) throw new Error('File name is required');
      await writeBytes(id, path.posix.join(str(body.remoteDir) || '/', name), Buffer.from(str(body.data), 'base64'));
      return reply({ ok: true });
    }
    case 'sftp/download':
      return reply({ path: await download(id, str(body.path), str(body.localDir) ? path.resolve(str(body.localDir)) : downloadsDir()) });
    case 'secret/set':
      saveSecret(dataDir, str(body.profileId), { password: str(body.password) || undefined, passphrase: str(body.passphrase) || undefined });
      return reply({ ok: true });
    case 'secret/forget':
      forgetSecret(dataDir, str(body.profileId));
      return reply({ ok: true });
    case 'secret/ids':
      return reply({ ids: savedSecretIds(dataDir) });
    case 'local/list':
      return reply(listLocal(str(body.path)));
    case 'local/mkdir':
      mkdirLocal(str(body.path));
      return reply({ ok: true });
    default:
      return undefined;
  }
}
