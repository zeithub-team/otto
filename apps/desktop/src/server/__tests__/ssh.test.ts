import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Server, utils } from 'ssh2';
import {
  HostKeyError, checkHost, connect, deleteKey, disconnect, exec, fingerprintOfPublicKey, forgetHost, generateKey, importKey,
  joinRemote, listKeys, modeString,
} from '../sshclient';
import { handleSshRoute } from '../sshroutes';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'otto-ssh-'));

test('generated keys (ed25519 / rsa / with passphrase) are stored, listed and have a matching fingerprint', () => {
  const dir = tmp();
  const a = generateKey(dir, { name: 'laptop', type: 'ed25519', comment: 'me@pc' });
  assert.match(a.publicKey, /^ssh-ed25519 \S+ me@pc$/);
  assert.equal(a.fingerprint, fingerprintOfPublicKey(a.publicKey));
  assert.match(a.fingerprint, /^SHA256:/);
  const b = generateKey(dir, { name: 'server', type: 'rsa', bits: 2048, passphrase: 'secret' });
  assert.equal(b.type, 'ssh-rsa');
  assert.equal(b.bits, 2048);
  assert.equal(b.encrypted, true);
  assert.equal(listKeys(dir).length, 2);
  assert.ok(!JSON.stringify(listKeys(dir)).includes('PRIVATE KEY'), 'the UI never gets private key text');
  assert.equal(deleteKey(dir, a.id), true);
  assert.equal(listKeys(dir).length, 1);
  assert.equal(deleteKey(dir, a.id), false);
});

test('importing: junk is refused, a real key is accepted, a wrong passphrase is explained', () => {
  const dir = tmp();
  assert.throws(() => importKey(dir, { name: 'x', privateKey: 'hello' }), /not a private key/i);
  const pair = utils.generateKeyPairSync('ed25519', { passphrase: 'pw', cipher: 'aes256-ctr', rounds: 16 } as never);
  assert.throws(() => importKey(dir, { name: 'locked', privateKey: pair.private }), /passphrase/i);
  assert.throws(() => importKey(dir, { name: 'locked', privateKey: pair.private, passphrase: 'wrong' }), /passphrase|valid/i);
  const ok = importKey(dir, { name: 'locked', privateKey: pair.private, passphrase: 'pw' });
  assert.equal(ok.fingerprint, fingerprintOfPublicKey(pair.public));
});

test('host keys: unknown until remembered; forgetting resets', () => {
  const dir = tmp();
  assert.equal(checkHost(dir, 'h', 22, 'SHA256:aaa'), 'unknown');
  forgetHost(dir, 'h', 22);
  assert.equal(checkHost(dir, 'h', 22, 'SHA256:aaa'), 'unknown');
});

test('helpers: permission string and remote path joining', () => {
  assert.equal(modeString(0o755), 'rwxr-xr-x');
  assert.equal(modeString(0o640), 'rw-r-----');
  assert.equal(joinRemote('/var/www', 'index.php'), '/var/www/index.php');
  assert.equal(joinRemote('/', 'etc'), '/etc');
});

test('a real (in-process) SSH server: ask on first contact, key login, exec, a changed host key is refused', async () => {
  const dataDir = tmp();
  const clientKey = generateKey(dataDir, { name: 'me', type: 'ed25519' });
  const clientBlob = Buffer.from(clientKey.publicKey.split(' ')[1], 'base64');
  const serverKey = utils.generateKeyPairSync('ed25519');
  const server = new Server({ hostKeys: [serverKey.private] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'publickey' && ctx.key.data.equals(clientBlob)) return ctx.accept();
      if (ctx.method === 'password' && ctx.password === 'pw') return ctx.accept();
      return ctx.reject();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        accept().on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          stream.write(`ran: ${info.command}`);
          stream.exit(0);
          stream.end();
        });
      });
    });
    client.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const base = { host: '127.0.0.1', port, user: 'root', keyId: clientKey.id };

    // first contact: the server key is unknown, so nothing is sent until the user confirms
    const asked = await connect(dataDir, base).then(() => null, (e: unknown) => e);
    assert.ok(asked instanceof HostKeyError);
    assert.equal(asked.status, 'unknown');

    const fp = asked.fingerprint;
    const session = await connect(dataDir, { ...base, trust: fp });
    assert.equal(session.fingerprint, fp);
    const out = await exec(session.id, 'whoami');
    assert.equal(out.stdout, 'ran: whoami');
    assert.equal(out.code, 0);
    assert.equal(disconnect(session.id), true);
    await assert.rejects(exec(session.id, 'x'), /closed/);

    // remembered now: no question, and a wrong password is explained
    assert.equal(checkHost(dataDir, '127.0.0.1', port, fp), 'known');
    await assert.rejects(connect(dataDir, { host: '127.0.0.1', port, user: 'root', password: 'nope' }), /Authentication failed/);
    const viaPassword = await connect(dataDir, { host: '127.0.0.1', port, user: 'root', password: 'pw' });
    disconnect(viaPassword.id);

    // a different key for the same address is a warning, never a silent connect
    const other = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => { c.on('error', () => undefined); });
    await new Promise<void>((resolve) => other.listen(port + 1, '127.0.0.1', () => resolve()));
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'ssh', 'known_hosts.json'), 'utf8')) as Record<string, string>;
      saved[`127.0.0.1:${port + 1}`] = fp; // pretend we met a host here before with the first key
      fs.writeFileSync(path.join(dataDir, 'ssh', 'known_hosts.json'), JSON.stringify(saved));
      const changed = await connect(dataDir, { host: '127.0.0.1', port: port + 1, user: 'root', password: 'pw' }).then(() => null, (e: unknown) => e);
      assert.ok(changed instanceof HostKeyError);
      assert.equal(changed.status, 'changed');
    } finally {
      other.close();
    }
  } finally {
    server.close();
  }
});

test('route layer: unknown paths are ignored, bad input gives clear errors', async () => {
  const dir = tmp();
  assert.equal(await handleSshRoute('/api/other', {}, dir), undefined);
  await assert.rejects(handleSshRoute('/api/ssh/sftp/chmod', { session: 'nope', path: '/x', mode: '999' }, dir), /octal/);
  await assert.rejects(handleSshRoute('/api/ssh/exec', { session: 'nope', command: 'ls' }, dir), /closed/);
  const made = await handleSshRoute('/api/ssh/keys/generate', { name: 'k', type: 'ed25519' }, dir);
  assert.ok((made!.payload as { fingerprint: string }).fingerprint);
  const listed = await handleSshRoute('/api/ssh/keys', {}, dir);
  assert.equal((listed!.payload as { keys: unknown[] }).keys.length, 1);
});

test('saved passwords: stored encrypted, read back, forgotten; local folder listing works', async () => {
  const { saveSecret, loadSecret, savedSecretIds, forgetSecret, listLocal } = await import('../sshclient');
  const dir = tmp();
  const id = '11111111-2222-3333-4444-555555555555';
  saveSecret(dir, id, { password: 'hunter2', passphrase: 'pp' });
  assert.deepEqual(loadSecret(dir, id), { password: 'hunter2', passphrase: 'pp' });
  assert.deepEqual(savedSecretIds(dir), [id]);
  assert.ok(!fs.readFileSync(path.join(dir, 'ssh', 'secrets.json'), 'utf8').includes('hunter2'), 'never stored in plain text');
  forgetSecret(dir, id);
  assert.deepEqual(loadSecret(dir, id), {});
  assert.throws(() => saveSecret(dir, 'not-a-uuid', { password: 'x' }), /Unknown profile/);

  const folder = tmp();
  fs.mkdirSync(path.join(folder, 'sub'));
  fs.writeFileSync(path.join(folder, 'a.txt'), 'hi');
  const listing = listLocal(folder);
  assert.deepEqual(listing.entries.map((e) => `${e.type}:${e.name}`), ['dir:sub', 'file:a.txt']);
  assert.equal(listing.entries[1].size, 2);
});
