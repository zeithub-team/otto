'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  AlertTriangle, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, ChevronUp, Copy, File as FileIcon, Folder, FolderPlus, HardDrive,
  Loader2, Pencil, RefreshCw, Save, Server, Trash2, Upload, X,
} from 'lucide-react';
import { useT } from '../../lib/i18n';
import {
  formatSize, localList, localMkdir, parentOf, sftpChmod, sftpDelete, sftpDownloadTo, sftpList, sftpMkdir, sftpRead, sftpRename, sftpUploadFile,
  sftpUploadLocal, sftpWrite, type LocalEntry, type RemoteEntry,
} from '../../lib/sshapi';
import { hasOsFiles } from '../../lib/dropfiles';

const btn = 'inline-flex items-center gap-1 rounded-md border border-[var(--border-color)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40';
const MAX_UPLOAD = 100 * 1024 * 1024;

interface Item { name: string; path: string; type: 'dir' | 'file' | 'link' | 'other'; size: number; mtime: number; mode?: string }
interface LogEntry { id: number; at: number; op: string; text: string; status: 'run' | 'ok' | 'error'; detail?: string; ms?: number }

let logId = 0;

/** Join a local folder and a name with the separator that folder already uses. */
function joinLocal(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

/** Two-pane file manager (this computer ⇄ the server) with a transfer log, like Bitvise / WinSCP. */
export function SftpManager({ session, startPath }: { session: string; startPath?: string }) {
  const { t } = useT();
  const [log, setLog] = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(true);
  const [local, setLocal] = useState<{ path: string; parent: string | null; entries: Item[] }>({ path: '', parent: null, entries: [] });
  const [remote, setRemote] = useState<{ path: string; entries: Item[] }>({ path: '', entries: [] });
  const [localSel, setLocalSel] = useState<Set<string>>(new Set());
  const [remoteSel, setRemoteSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(0);
  const [editor, setEditor] = useState<{ path: string; content: string; saved: string } | null>(null);
  const [dragOver, setDragOver] = useState<'local' | 'remote' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const logEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { logEnd.current?.scrollIntoView({ block: 'end' }); }, [log]);

  /** Runs one operation and records it (start, success with duration, or the exact error) in the log. */
  const track = useCallback(async <T,>(op: string, text: string, fn: () => Promise<T>): Promise<T | undefined> => {
    const id = ++logId;
    const started = Date.now();
    setLog((l) => [...l.slice(-299), { id, at: started, op, text, status: 'run' }]);
    setBusy((b) => b + 1);
    try {
      const out = await fn();
      setLog((l) => l.map((x) => (x.id === id ? { ...x, status: 'ok', ms: Date.now() - started } : x)));
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLog((l) => l.map((x) => (x.id === id ? { ...x, status: 'error', detail: msg, ms: Date.now() - started } : x)));
      return undefined;
    } finally {
      setBusy((b) => b - 1);
    }
  }, []);

  const openLocal = useCallback(async (dir: string) => {
    try {
      const r = await localList(dir);
      setLocal({ path: r.path, parent: r.parent, entries: r.entries as LocalEntry[] });
      setLocalSel(new Set());
    } catch (e) { setLog((l) => [...l, { id: ++logId, at: Date.now(), op: 'list', text: `${t('ssh.local')}: ${dir}`, status: 'error', detail: e instanceof Error ? e.message : String(e) }]); }
  }, [t]);
  const openRemote = useCallback(async (dir: string) => {
    try {
      const r = await sftpList(session, dir);
      setRemote({ path: r.path, entries: r.entries });
      setRemoteSel(new Set());
    } catch (e) { setLog((l) => [...l, { id: ++logId, at: Date.now(), op: 'list', text: `${t('ssh.remote')}: ${dir}`, status: 'error', detail: e instanceof Error ? e.message : String(e) }]); }
  }, [session, t]);
  useEffect(() => { void openLocal(''); void openRemote(startPath || '.'); }, [openLocal, openRemote, startPath]);

  const toRemote = async (items: Item[], dir = remote.path) => {
    for (const it of items) await track('up', `${it.path}  →  ${dir}`, () => sftpUploadLocal(session, it.path, dir));
    await openRemote(dir);
  };
  const toLocal = async (items: Item[], dir = local.path) => {
    for (const it of items) await track('down', `${it.path}  →  ${dir}`, () => sftpDownloadTo(session, it.path, dir));
    await openLocal(dir);
  };
  const uploadFiles = async (files: File[]) => {
    for (const f of files) {
      if (f.size > MAX_UPLOAD) { setLog((l) => [...l, { id: ++logId, at: Date.now(), op: 'up', text: f.name, status: 'error', detail: t('ssh.tooBig', { name: f.name }) }]); continue; }
      await track('up', `${f.name}  →  ${remote.path}`, () => sftpUploadFile(session, remote.path, f));
    }
    await openRemote(remote.path);
  };

  const selected = (items: Item[], sel: Set<string>) => items.filter((i) => sel.has(i.path));
  const rsel = selected(remote.entries, remoteSel);
  const lsel = selected(local.entries, localSel);
  const remoteJoin = (name: string) => (remote.path === '/' ? '' : remote.path) + '/' + name;

  const drop = (target: 'local' | 'remote', e: DragEvent) => {
    e.preventDefault(); setDragOver(null);
    if (hasOsFiles(e.dataTransfer) && target === 'remote') { void uploadFiles(Array.from(e.dataTransfer.files)); return; }
    const from = e.dataTransfer.getData('otto/side');
    if (from === target) return;
    if (from === 'local' && target === 'remote') void toRemote(lsel.length ? lsel : []);
    if (from === 'remote' && target === 'local') void toLocal(rsel.length ? rsel : []);
  };

  const row = (it: Item, side: 'local' | 'remote', sel: Set<string>, setSel: (s: Set<string>) => void, open: (p: string) => void) => (
    <tr key={it.path} draggable
      onDragStart={(e) => { e.dataTransfer.setData('otto/side', side); if (!sel.has(it.path)) setSel(new Set([it.path])); }}
      onClick={(e) => { if (e.ctrlKey || e.metaKey) { const n = new Set(sel); if (n.has(it.path)) n.delete(it.path); else n.add(it.path); setSel(n); } else setSel(new Set([it.path])); }}
      onDoubleClick={() => {
        if (it.type === 'dir') open(it.path);
        else if (side === 'remote') void sftpRead(session, it.path).then((r) => { if (r.binary) setLog((l) => [...l, { id: ++logId, at: Date.now(), op: 'open', text: it.path, status: 'error', detail: t('ssh.binary') }]); else setEditor({ path: it.path, content: r.content, saved: r.content }); }).catch((x) => setLog((l) => [...l, { id: ++logId, at: Date.now(), op: 'open', text: it.path, status: 'error', detail: String(x.message ?? x) }]));
      }}
      className={`cursor-default ${sel.has(it.path) ? 'bg-[var(--bg-active)]' : 'hover:bg-[var(--bg-tertiary)]'}`}>
      <td className="px-2 py-1"><span className="flex items-center gap-1.5">{it.type === 'dir' ? <Folder size={12} className="shrink-0 text-[var(--accent)]" /> : <FileIcon size={12} className="shrink-0 text-[var(--text-muted)]" />}<span className="truncate">{it.name}</span></span></td>
      <td className="whitespace-nowrap px-2 text-right text-[var(--text-muted)]">{it.type === 'dir' ? '' : formatSize(it.size)}</td>
      <td className="hidden whitespace-nowrap px-2 text-[var(--text-muted)] xl:table-cell">{it.mtime ? new Date(it.mtime * 1000).toLocaleDateString() : ''}</td>
    </tr>
  );

  const pathBar = (value: string, go: (p: string) => void, up: () => void, refresh: () => void, extra?: ReactNode) => (
    <div className="flex items-center gap-1 border-b border-[var(--border-color)] px-2 py-1.5">
      <button className={btn} onClick={up} title={t('ssh.up')}><ArrowUp size={12} /></button>
      <PathInput value={value} onGo={go} />
      <button className={btn} onClick={refresh} title={t('ssh.refresh')}><RefreshCw size={12} /></button>
      {extra}
    </div>
  );

  const pane = (side: 'local' | 'remote', rows: ReactNode, bar: ReactNode) => (
    <div className={`relative flex min-w-0 flex-1 flex-col ${dragOver === side ? 'ring-2 ring-inset ring-[var(--accent)]' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(side); }} onDragLeave={() => setDragOver(null)} onDrop={(e) => drop(side, e)}>
      <div className="flex items-center gap-1.5 bg-[var(--bg-secondary)] px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
        {side === 'local' ? <HardDrive size={11} /> : <Server size={11} />} {t(side === 'local' ? 'ssh.local' : 'ssh.remote')}
      </div>
      {bar}
      <div className="min-h-0 flex-1 overflow-auto"><table className="w-full text-xs"><tbody>{rows}</tbody></table></div>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        {pane('local',
          local.entries.map((it) => row(it, 'local', localSel, setLocalSel, (p) => void openLocal(p))),
          pathBar(local.path || t('ssh.drives'), (p) => void openLocal(p), () => void openLocal(local.parent ?? '::roots'), () => void openLocal(local.path),
            <button className={btn} title={t('ssh.newFolder')} disabled={!local.path} onClick={() => { const n = window.prompt(t('ssh.newFolderName')); if (n?.trim()) void track('mkdir', `${t('ssh.local')}: ${n.trim()}`, () => localMkdir(joinLocal(local.path, n.trim()))).then(() => openLocal(local.path)); }}><FolderPlus size={12} /></button>))}

        <div className="flex w-12 shrink-0 flex-col items-center justify-center gap-2 border-x border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <button className={btn} disabled={lsel.length === 0 || busy > 0} title={t('ssh.toRemote')} onClick={() => void toRemote(lsel)}><ArrowRight size={14} /></button>
          <button className={btn} disabled={rsel.length === 0 || busy > 0 || !local.path} title={t('ssh.toLocal')} onClick={() => void toLocal(rsel)}><ArrowLeft size={14} /></button>
          {busy > 0 && <Loader2 size={14} className="animate-spin text-[var(--accent)]" />}
        </div>

        {pane('remote',
          remote.entries.map((it) => row(it, 'remote', remoteSel, setRemoteSel, (p) => void openRemote(p))),
          <>
            {pathBar(remote.path, (p) => void openRemote(p), () => void openRemote(parentOf(remote.path)), () => void openRemote(remote.path),
              <>
                <button className={btn} onClick={() => fileInput.current?.click()} title={t('ssh.upload')}><Upload size={12} /></button>
                <input ref={fileInput} type="file" multiple hidden onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; if (f.length) void uploadFiles(f); }} />
                <button className={btn} title={t('ssh.newFolder')} onClick={() => { const n = window.prompt(t('ssh.newFolderName')); if (n?.trim()) void track('mkdir', remoteJoin(n.trim()), () => sftpMkdir(session, remoteJoin(n.trim()))).then(() => openRemote(remote.path)); }}><FolderPlus size={12} /></button>
              </>)}
            {rsel.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 text-xs">
                <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{rsel.length === 1 ? rsel[0].name : t('ssh.selected', { n: rsel.length })}</span>
                {rsel.length === 1 && <button className={btn} onClick={() => { const it = rsel[0]; const n = window.prompt(t('ssh.renameTo'), it.name); if (n?.trim() && n !== it.name) void track('rename', `${it.path}  →  ${remoteJoin(n.trim())}`, () => sftpRename(session, it.path, remoteJoin(n.trim()))).then(() => openRemote(remote.path)); }}><Pencil size={11} /> {t('ssh.rename')}</button>}
                {rsel.length === 1 && <button className={btn} onClick={() => { const it = rsel[0]; const m = window.prompt(t('ssh.chmodPrompt'), ''); if (m?.trim()) void track('chmod', `${it.path} ${m.trim()}`, () => sftpChmod(session, it.path, m.trim())).then(() => openRemote(remote.path)); }}>chmod</button>}
                <button className={`${btn} hover:!border-[var(--error)] hover:!text-[var(--error)]`} onClick={async () => { if (!window.confirm(t('ssh.deleteConfirm', { name: rsel.length === 1 ? rsel[0].name : String(rsel.length) }))) return; for (const it of rsel) await track('delete', it.path, () => sftpDelete(session, it.path)); await openRemote(remote.path); }}><Trash2 size={11} /> {t('ssh.delete')}</button>
              </div>
            )}
          </>)}
      </div>

      <div className="border-t border-[var(--border-color)] bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-2 px-3 py-1 text-[11px]">
          <button className="flex items-center gap-1 text-[var(--text-secondary)]" onClick={() => setLogOpen((v) => !v)}>{logOpen ? <ChevronDown size={12} /> : <ChevronUp size={12} />} {t('ssh.log')} ({log.length})</button>
          {log.some((x) => x.status === 'error') && <span className="flex items-center gap-1 text-[var(--error)]"><AlertTriangle size={11} /> {log.filter((x) => x.status === 'error').length}</span>}
          <span className="ml-auto flex gap-1.5">
            <button className={btn} onClick={() => void navigator.clipboard?.writeText(log.map((x) => `${new Date(x.at).toLocaleTimeString()} [${x.op}] ${x.text} — ${x.status}${x.detail ? `: ${x.detail}` : ''}`).join('\n'))}><Copy size={11} /> {t('ssh.copyLog')}</button>
            <button className={btn} onClick={() => setLog([])}>{t('ssh.clearLog')}</button>
          </span>
        </div>
        {logOpen && (
          <div className="h-36 overflow-y-auto border-t border-[var(--border-color)] px-3 py-1 font-mono text-[11px]">
            {log.length === 0 && <div className="py-2 text-[var(--text-muted)]">{t('ssh.logEmpty')}</div>}
            {log.map((x) => (
              <div key={x.id} className="py-0.5">
                <span className="text-[var(--text-muted)]">{new Date(x.at).toLocaleTimeString()}</span>{' '}
                <span className="rounded bg-[var(--bg-tertiary)] px-1 text-[10px] uppercase text-[var(--text-secondary)]">{x.op}</span>{' '}
                <span className="text-[var(--text-primary)]">{x.text}</span>{' '}
                {x.status === 'run' && <Loader2 size={10} className="inline animate-spin text-[var(--accent)]" />}
                {x.status === 'ok' && <span className="text-[var(--success)]"><Check size={10} className="inline" /> {x.ms} ms</span>}
                {x.status === 'error' && <span className="text-[var(--error)]">✗ {x.detail}</span>}
              </div>
            ))}
            <div ref={logEnd} />
          </div>
        )}
      </div>

      {editor && (
        <div className="absolute inset-0 z-20 flex flex-col bg-[var(--bg-primary)]">
          <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-3 py-1.5 text-xs">
            <span className="flex-1 truncate font-mono text-[var(--text-primary)]">{editor.path}{editor.content !== editor.saved ? ' •' : ''}</span>
            <button className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-[var(--on-accent)] disabled:opacity-40" disabled={editor.content === editor.saved}
              onClick={() => void track('save', editor.path, () => sftpWrite(session, editor.path, editor.content)).then(() => setEditor((e) => (e ? { ...e, saved: e.content } : e)))}><Save size={12} /> {t('ssh.save')}</button>
            <button className={btn} onClick={() => { if (editor.content === editor.saved || window.confirm(t('ssh.discard'))) setEditor(null); }}><X size={12} /></button>
          </div>
          <textarea className="min-h-0 flex-1 resize-none bg-[var(--bg-primary)] p-3 font-mono text-xs text-[var(--text-primary)] outline-none" spellCheck={false} value={editor.content} onChange={(e) => setEditor({ ...editor, content: e.target.value })}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void track('save', editor.path, () => sftpWrite(session, editor.path, editor.content)).then(() => setEditor((x) => (x ? { ...x, saved: x.content } : x))); } }} />
        </div>
      )}
    </div>
  );
}

/** Path field you can type into: Enter goes there, Escape restores the current path. */
function PathInput({ value, onGo }: { value: string; onGo: (p: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
      onKeyDown={(e) => { if (e.key === 'Enter') onGo(text.trim()); else if (e.key === 'Escape') setText(value); }}
      onFocus={(e) => e.currentTarget.select()}
      className="min-w-0 flex-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 font-mono text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
  );
}
