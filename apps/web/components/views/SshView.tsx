'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUp, Copy, Download, File as FileIcon, Folder, FolderPlus, KeyRound, Link2, Loader2, Pencil, Plus, RefreshCw, Save,
  Server, ShieldAlert, Terminal, Trash2, Upload, X,
} from 'lucide-react';
import { useT } from '../../lib/i18n';
import {
  formatSize, loadProfiles, parentOf, saveProfiles, sftpChmod, sftpDelete, sftpDownload, sftpList, sftpMkdir, sftpRead, sftpRename,
  sshSaveSecret, sshForgetSecret, sshSavedSecretIds, sshConnect, sshDeleteKey, sshDisconnect, sshExec, sshForgetHost, sshGenerateKey, sshImportKey, sshKeys,
  type RemoteEntry, type SshKey, type SshProfile,
} from '../../lib/sshapi';
import { SftpManager } from './SftpManager';
import { useCommandHistory } from '../../lib/cmdHistory';

const input = 'w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]/60';
const btn = 'inline-flex items-center gap-1.5 rounded-md border border-[var(--border-color)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40';
const btnPrimary = 'inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--on-accent)] disabled:opacity-40';
const MAX_UPLOAD = 100 * 1024 * 1024;

const blankProfile = (): SshProfile => ({ id: crypto.randomUUID(), name: '', host: '', port: 22, user: '', auth: 'key' });

interface Live { id: string; profile: SshProfile; fingerprint: string }

export function SshView() {
  const { t } = useT();
  const [profiles, setProfiles] = useState<SshProfile[]>([]);
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [editing, setEditing] = useState<SshProfile | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const reloadSaved = useCallback(() => { void sshSavedSecretIds().then(setSavedIds).catch(() => setSavedIds([])); }, []);

  const reloadKeys = useCallback(() => { void sshKeys().then(setKeys).catch(() => setKeys([])); }, []);
  useEffect(() => { setProfiles(loadProfiles()); reloadKeys(); reloadSaved(); }, [reloadKeys, reloadSaved]);

  const persist = (next: SshProfile[]) => { setProfiles(next); saveProfiles(next); };
  const saveProfile = (p: SshProfile) => {
    const clean = { ...p, name: p.name.trim() || `${p.user}@${p.host}` };
    persist(profiles.some((x) => x.id === clean.id) ? profiles.map((x) => (x.id === clean.id ? clean : x)) : [...profiles, clean]);
    setEditing(clean);
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--border-color)] bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-3 py-2.5">
          <Server size={14} className="text-[var(--accent)]" />
          <span className="flex-1 text-sm font-medium text-[var(--text-primary)]">{t('ssh.title')}</span>
          <button className={btn} onClick={() => { setLive(null); setEditing(blankProfile()); setShowKeys(false); }} title={t('ssh.newProfile')}><Plus size={12} /></button>
        </div>
        <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {profiles.length === 0 && <div className="p-3 text-center text-[11px] text-[var(--text-muted)]">{t('ssh.noProfiles')}</div>}
          {profiles.map((p) => (
            <div key={p.id} className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-xs ${editing?.id === p.id || live?.profile.id === p.id ? 'bg-[var(--bg-active)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}>
              <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => { if (live?.profile.id !== p.id) setLive(null); setEditing(p); setShowKeys(false); }}>
                <Server size={12} className={live?.profile.id === p.id ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'} />
                <span className="min-w-0 flex-1"><span className="block truncate">{p.name}</span><span className="block truncate text-[10px] text-[var(--text-muted)]">{p.user}@{p.host}:{p.port}</span></span>
              </button>
              <button className="opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-[var(--error)]" title={t('ssh.delete')} onClick={() => { if (live?.profile.id === p.id) return; persist(profiles.filter((x) => x.id !== p.id)); if (editing?.id === p.id) setEditing(null); }}><Trash2 size={11} /></button>
            </div>
          ))}
        </div>
        <button className="flex items-center gap-2 border-t border-[var(--border-color)] px-3 py-2.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]" onClick={() => { setShowKeys(true); setEditing(null); }}>
          <KeyRound size={13} className="text-[var(--accent)]" /> {t('ssh.keys')} <span className="ml-auto text-[10px] text-[var(--text-muted)]">{keys.length}</span>
        </button>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {showKeys ? (
          <KeysPanel keys={keys} onChanged={reloadKeys} />
        ) : live ? (
          <Connected live={live} onClose={() => { void sshDisconnect(live.id).catch(() => undefined); setLive(null); }} />
        ) : editing ? (
          <ProfileEditor profile={editing} keys={keys} hasSaved={savedIds.includes(editing.id)} onSave={saveProfile} onConnected={(l) => { saveProfile(l.profile); setLive(l); reloadSaved(); }} onOpenKeys={() => setShowKeys(true)} />
        ) : (
          <div className="grid flex-1 place-items-center p-8 text-center text-sm text-[var(--text-muted)]">
            <div><Server size={28} className="mx-auto mb-3 opacity-40" />{t('ssh.empty')}</div>
          </div>
        )}
      </main>
    </div>
  );
}

// ------------------------------------------------------------ profile --

function ProfileEditor({ profile, keys, hasSaved, onSave, onConnected, onOpenKeys }: {
  profile: SshProfile; keys: SshKey[]; hasSaved: boolean; onSave: (p: SshProfile) => void; onConnected: (l: Live) => void; onOpenKeys: () => void;
}) {
  const { t } = useT();
  const [p, setP] = useState(profile);
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [remember, setRemember] = useState(hasSaved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hostAsk, setHostAsk] = useState<{ status: 'unknown' | 'changed'; fingerprint: string; saved?: string } | null>(null);
  useEffect(() => { setP(profile); setError(''); setHostAsk(null); setPassword(''); setPassphrase(''); setRemember(hasSaved); }, [profile, hasSaved]);
  const key = keys.find((k) => k.id === p.keyId);
  const ready = p.host.trim() && p.user.trim() && (p.auth === 'password' ? Boolean(password || hasSaved) : Boolean(p.keyId) && (!key?.encrypted || Boolean(passphrase || hasSaved)));

  const go = async (trust?: string) => {
    setBusy(true); setError('');
    try {
      const typedPassword = p.auth === 'password' ? password : '';
      const typedPassphrase = p.auth === 'key' && key?.encrypted ? passphrase : '';
      const a = await sshConnect(p, { password: typedPassword || undefined, passphrase: typedPassphrase || undefined, trust, useSaved: hasSaved && !typedPassword && !typedPassphrase });
      if (a.status === 'connected') {
        setHostAsk(null);
        // remember (or forget) what was typed; an empty field with "remember" on keeps the old saved value
        if (!remember) await sshForgetSecret(p.id).catch(() => undefined);
        else if (typedPassword || typedPassphrase) await sshSaveSecret(p.id, { password: typedPassword || undefined, passphrase: typedPassphrase || undefined }).catch(() => undefined);
        onConnected({ id: a.id, profile: p, fingerprint: a.fingerprint });
      }
      else setHostAsk({ status: a.status, fingerprint: a.fingerprint, saved: a.saved });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const set = <K extends keyof SshProfile>(k: K, v: SshProfile[K]) => setP((x) => ({ ...x, [k]: v }));
  return (
    <div className="mx-auto w-full max-w-xl space-y-3 overflow-y-auto p-6">
      <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t('ssh.connection')}</h2>
      <label className="block text-[11px] text-[var(--text-muted)]">{t('ssh.name')}<input className={input} value={p.name} onChange={(e) => set('name', e.target.value)} placeholder="production" /></label>
      <div className="grid grid-cols-[1fr_90px] gap-2">
        <label className="block text-[11px] text-[var(--text-muted)]">{t('ssh.host')}<input className={input} value={p.host} onChange={(e) => set('host', e.target.value)} placeholder="example.com" /></label>
        <label className="block text-[11px] text-[var(--text-muted)]">{t('ssh.port')}<input className={input} type="number" value={p.port} onChange={(e) => set('port', Number(e.target.value) || 22)} /></label>
      </div>
      <label className="block text-[11px] text-[var(--text-muted)]">{t('ssh.user')}<input className={input} value={p.user} onChange={(e) => set('user', e.target.value)} placeholder="root" /></label>
      <div className="flex gap-1.5 text-xs">
        {(['key', 'password'] as const).map((a) => (
          <button key={a} onClick={() => set('auth', a)} className={`rounded-md border px-3 py-1.5 ${p.auth === a ? 'border-[var(--accent)] bg-[var(--accent-glow)] text-[var(--accent)]' : 'border-[var(--border-color)] text-[var(--text-secondary)]'}`}>{t(a === 'key' ? 'ssh.authKey' : 'ssh.authPassword')}</button>
        ))}
      </div>
      {p.auth === 'password' ? (
        <label className="block text-[11px] text-[var(--text-muted)]">{t('ssh.password')}<input className={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" placeholder={hasSaved ? t('ssh.savedPlaceholder') : ''} /></label>
      ) : (
        <div className="space-y-2">
          <label className="block text-[11px] text-[var(--text-muted)]">{t('ssh.key')}
            <select className={input} value={p.keyId ?? ''} onChange={(e) => set('keyId', e.target.value || undefined)}>
              <option value="">{t('ssh.pickKey')}</option>
              {keys.map((k) => <option key={k.id} value={k.id}>{k.name} · {k.type.replace('ssh-', '')}{k.encrypted ? ' 🔒' : ''}</option>)}
            </select>
          </label>
          {keys.length === 0 && <button className={btn} onClick={onOpenKeys}><KeyRound size={12} /> {t('ssh.createFirstKey')}</button>}
          {key?.encrypted && <label className="block text-[11px] text-[var(--text-muted)]">{t('ssh.passphrase')}<input className={input} type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" placeholder={hasSaved ? t('ssh.savedPlaceholder') : ''} /></label>}
          {key && <p className="break-all rounded-md bg-[var(--bg-tertiary)] p-2 font-mono text-[10px] text-[var(--text-muted)]">{key.fingerprint}</p>}
        </div>
      )}
      {(p.auth === 'password' || key?.encrypted) && (
        <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> {t('ssh.remember')}<span className="text-[10px] text-[var(--text-muted)]">— {t('ssh.rememberNote')}</span></label>
      )}
      <label className="block text-[11px] text-[var(--text-muted)]">{t('ssh.startPath')}<input className={input} value={p.startPath ?? ''} onChange={(e) => set('startPath', e.target.value || undefined)} placeholder="/var/www" /></label>

      {hostAsk && (
        <div className={`rounded-lg border p-3 text-xs ${hostAsk.status === 'changed' ? 'border-[var(--error)]/50 bg-[var(--error)]/10' : 'border-[var(--warning)]/50 bg-[var(--warning)]/10'}`}>
          <div className="mb-1 flex items-center gap-1.5 font-medium text-[var(--text-primary)]"><ShieldAlert size={14} /> {t(hostAsk.status === 'changed' ? 'ssh.hostChanged' : 'ssh.hostNew')}</div>
          <p className="mb-1 text-[var(--text-secondary)]">{t(hostAsk.status === 'changed' ? 'ssh.hostChangedHint' : 'ssh.hostNewHint')}</p>
          <p className="break-all font-mono text-[10px] text-[var(--text-primary)]">{hostAsk.fingerprint}</p>
          {hostAsk.saved && <p className="break-all font-mono text-[10px] text-[var(--text-muted)]">{t('ssh.hostWas')}: {hostAsk.saved}</p>}
          <div className="mt-2 flex gap-2">
            <button className={btnPrimary} disabled={busy} onClick={async () => { if (hostAsk.status === 'changed') await sshForgetHost(p.host, p.port); void go(hostAsk.fingerprint); }}>{t(hostAsk.status === 'changed' ? 'ssh.trustNew' : 'ssh.trust')}</button>
            <button className={btn} onClick={() => setHostAsk(null)}>{t('ssh.cancel')}</button>
          </div>
        </div>
      )}
      {error && <div className="rounded-md border border-[var(--error)]/40 bg-[var(--error)]/10 p-2 text-xs text-[var(--error)]">{error}</div>}
      <div className="flex gap-2">
        <button className={btnPrimary} disabled={!ready || busy} onClick={() => void go()}>{busy ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />} {t('ssh.connect')}</button>
        <button className={btn} disabled={!p.host.trim() || !p.user.trim()} onClick={() => onSave(p)}><Save size={12} /> {t('ssh.save')}</button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- keys --

function KeysPanel({ keys, onChanged }: { keys: SshKey[]; onChanged: () => void }) {
  const { t } = useT();
  const [mode, setMode] = useState<'list' | 'generate' | 'import'>('list');
  const [name, setName] = useState('');
  const [type, setType] = useState<'ed25519' | 'rsa' | 'ecdsa'>('ed25519');
  const [bits, setBits] = useState(4096);
  const [comment, setComment] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); onChanged(); setMode('list'); setName(''); setPassphrase(''); setPrivateKey(''); setComment(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const copy = (k: SshKey) => { void navigator.clipboard?.writeText(k.publicKey); setCopied(k.id); window.setTimeout(() => setCopied(''), 1500); };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-3 overflow-y-auto p-6">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold text-[var(--text-primary)]">{t('ssh.keys')}</h2>
        <button className={btn} onClick={() => { setMode('generate'); setError(''); }}><Plus size={12} /> {t('ssh.generate')}</button>
        <button className={btn} onClick={() => { setMode('import'); setError(''); }}><Upload size={12} /> {t('ssh.import')}</button>
      </div>
      <p className="text-[11px] text-[var(--text-muted)]">{t('ssh.keysHint')}</p>

      {mode !== 'list' && (
        <div className="space-y-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('ssh.keyName')} />
          {mode === 'generate' ? (
            <>
              <div className="flex gap-2">
                <select className={input} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                  <option value="ed25519">Ed25519 ({t('ssh.recommended')})</option>
                  <option value="rsa">RSA</option>
                  <option value="ecdsa">ECDSA</option>
                </select>
                {type === 'rsa' && <select className={input} value={bits} onChange={(e) => setBits(Number(e.target.value))}>{[2048, 3072, 4096].map((b) => <option key={b} value={b}>{b}</option>)}</select>}
              </div>
              <input className={input} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('ssh.comment')} />
            </>
          ) : (
            <textarea className={`${input} h-32 font-mono`} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
          )}
          <input className={input} type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder={t(mode === 'generate' ? 'ssh.passphraseNew' : 'ssh.passphraseImport')} autoComplete="off" />
          {error && <div className="text-xs text-[var(--error)]">{error}</div>}
          <div className="flex gap-2">
            <button className={btnPrimary} disabled={busy || (mode === 'import' && !privateKey.trim())} onClick={() => void run(() => (mode === 'generate'
              ? sshGenerateKey({ name, type, bits, comment: comment || undefined, passphrase: passphrase || undefined })
              : sshImportKey({ name, privateKey, passphrase: passphrase || undefined })))}>{busy && <Loader2 size={12} className="animate-spin" />} {t(mode === 'generate' ? 'ssh.generate' : 'ssh.import')}</button>
            <button className={btn} onClick={() => setMode('list')}>{t('ssh.cancel')}</button>
          </div>
        </div>
      )}

      {keys.length === 0 && mode === 'list' && <div className="rounded-lg border border-dashed border-[var(--border-color)] p-6 text-center text-xs text-[var(--text-muted)]">{t('ssh.noKeys')}</div>}
      {keys.map((k) => (
        <div key={k.id} className="space-y-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
          <div className="flex items-center gap-2">
            <KeyRound size={13} className="text-[var(--accent)]" />
            <span className="flex-1 truncate text-xs font-medium text-[var(--text-primary)]">{k.name}</span>
            <span className="text-[10px] text-[var(--text-muted)]">{k.type.replace('ssh-', '')}{k.bits ? ` ${k.bits}` : ''}{k.encrypted ? ' · 🔒' : ''}</span>
            <button className={btn} onClick={() => copy(k)}>{copied === k.id ? t('ssh.copied') : <><Copy size={11} /> {t('ssh.copyPublic')}</>}</button>
            <button className="text-[var(--text-muted)] hover:text-[var(--error)]" title={t('ssh.delete')} onClick={() => { if (window.confirm(t('ssh.deleteKeyConfirm', { name: k.name }))) void sshDeleteKey(k.id).then(onChanged); }}><Trash2 size={13} /></button>
          </div>
          <p className="break-all font-mono text-[10px] text-[var(--text-muted)]">{k.fingerprint}</p>
          <p className="break-all rounded bg-[var(--bg-tertiary)] p-1.5 font-mono text-[10px] text-[var(--text-secondary)] select-all">{k.publicKey}</p>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------- connected --

function Connected({ live, onClose }: { live: Live; onClose: () => void }) {
  const { t } = useT();
  const [tab, setTab] = useState<'files' | 'terminal'>('files');
  const p = live.profile;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-[var(--border-color)] px-4 py-2">
        <span className="h-2 w-2 rounded-full bg-[var(--success)]" />
        <span className="text-xs font-medium text-[var(--text-primary)]">{p.user}@{p.host}:{p.port}</span>
        <span className="hidden truncate font-mono text-[10px] text-[var(--text-muted)] md:inline" title={live.fingerprint}>{live.fingerprint}</span>
        <div className="ml-auto flex gap-1">
          {(['files', 'terminal'] as const).map((k) => (
            <button key={k} onClick={() => setTab(k)} className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${tab === k ? 'bg-[var(--accent-glow)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}>
              {k === 'files' ? <Folder size={12} /> : <Terminal size={12} />} {t(k === 'files' ? 'ssh.files' : 'ssh.terminal')}
            </button>
          ))}
          <button className={btn} onClick={onClose}><X size={12} /> {t('ssh.disconnect')}</button>
        </div>
      </div>
      {tab === 'files' ? <SftpManager session={live.id} startPath={p.startPath} /> : <ExecPane session={live.id} startPath={p.startPath} />}
    </div>
  );
}

// ----------------------------------------------------------- terminal --

interface Line { cmd: string; out: string; err: string; code: number | null; cwd: string }

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const MARK = '__OTTO_PWD__';

function ExecPane({ session, startPath }: { session: string; startPath?: string }) {
  const { t } = useT();
  const [cwd, setCwd] = useState(startPath || '~');
  const [lines, setLines] = useState<Line[]>([]);
  const [cmd, setCmd] = useState('');
  const [busy, setBusy] = useState(false);
  const hist = useCommandHistory('otto-ssh-history');
  const endRef = useRef<HTMLDivElement>(null);
  const inputEl = useRef<HTMLInputElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [lines, busy]);
  useEffect(() => { if (!busy) inputEl.current?.focus(); }, [busy]);

  /** Tab: complete the last word with the server's own file (or command) names. */
  const complete = async () => {
    if (busy) return;
    const m = /(\S*)$/.exec(cmd);
    const word = m?.[1] ?? '';
    const first = cmd.trim() === word.trim() && !word.includes('/');
    const script = `cd ${cwd === '~' ? '"$HOME"' : shq(cwd)} 2>/dev/null; ${first ? 'compgen -c' : 'compgen -f'} -- ${shq(word.replace(/^~\//, '$HOME/'))} | head -50 | while IFS= read -r f; do if [ -d "$f" ]; then echo "$f/"; else echo "$f"; fi; done`;
    try {
      const r = await sshExec(session, script, 10);
      const found = r.stdout.split('\n').filter(Boolean);
      if (found.length === 0) return;
      let common = found[0];
      for (const f of found) while (!f.startsWith(common)) common = common.slice(0, -1);
      const base = word.startsWith('~/') ? '~/' : '';
      const replaced = base && common.startsWith('$HOME/') ? base + common.slice(6) : common;
      if (replaced.length > word.length) setCmd(cmd.slice(0, cmd.length - word.length) + replaced);
      if (found.length > 1) setLines((l) => [...l, { cmd: '', out: found.join('  '), err: '', code: null, cwd }]);
    } catch { /* completion is a convenience: ignore failures */ }
  };

  const run = async () => {
    const text = cmd.trim();
    if (!text || busy) return;
    setBusy(true); setCmd(''); hist.add(text);
    try {
      // every command is a separate exec: keep the folder by cd-ing into it and reading $PWD afterwards
      const wrapped = `cd ${cwd === '~' ? '"$HOME"' : shq(cwd)} 2>/dev/null; ${text}\n__c=$?; printf '\\n${MARK}%s' "$PWD"; exit $__c`;
      const r = await sshExec(session, wrapped, 120);
      let out = r.stdout;
      let next = cwd;
      const i = out.lastIndexOf(`\n${MARK}`);
      if (i >= 0) { next = out.slice(i + 1 + MARK.length).trim() || cwd; out = out.slice(0, i); }
      setLines((l) => [...l, { cmd: text, out, err: r.stderr, code: r.code, cwd }]);
      setCwd(next);
    } catch (e) { setLines((l) => [...l, { cmd: text, out: '', err: e instanceof Error ? e.message : String(e), code: null, cwd }]); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--bg-primary)] font-mono text-xs">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {lines.length === 0 && <div className="text-[var(--text-muted)]">{t('ssh.terminalHint')}</div>}
        {lines.map((l, i) => (
          <div key={i} className="mb-2">
            {l.cmd && <div className="text-[var(--accent)]">{l.cwd} $ <span className="text-[var(--text-primary)]">{l.cmd}</span></div>}
            {l.out && <pre className="whitespace-pre-wrap break-words text-[var(--text-secondary)]">{l.out}</pre>}
            {l.err && <pre className="whitespace-pre-wrap break-words text-[var(--error)]">{l.err}</pre>}
            {l.code !== null && l.code !== 0 && <div className="text-[10px] text-[var(--text-muted)]">exit {l.code}</div>}
          </div>
        ))}
        {busy && <Loader2 size={12} className="animate-spin text-[var(--accent)]" />}
        <div ref={endRef} />
      </div>
      <div className="flex items-center gap-2 border-t border-[var(--border-color)] px-3 py-2">
        <span className="shrink-0 text-[var(--accent)]">{cwd} $</span>
        <input className="min-w-0 flex-1 bg-transparent text-[var(--text-primary)] outline-none" ref={inputEl} value={cmd} autoFocus spellCheck={false} readOnly={busy}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Tab') { e.preventDefault(); void complete(); }
            else if (e.key === 'Enter') void run();
            else if (e.key === 'ArrowUp') { e.preventDefault(); const v = hist.older(cmd); if (v !== null) setCmd(v); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); const v = hist.newer(); if (v !== null) setCmd(v); }
          }} />
      </div>
    </div>
  );
}
