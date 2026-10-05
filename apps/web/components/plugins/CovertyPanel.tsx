'use client';

/* zeithub.coverty inside otto: the extension popup (same markup, classes and styles — see coverty.css),
   with the vault stored in the app data folder instead of chrome.storage. */

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import './coverty.css';
import { loadPluginData, savePluginData } from '../../lib/plugins';
import { generatePassword, keyFromSalt, newVaultKey, seal, unseal, type SealedVault } from '../../lib/vaultCrypto';

type EntryType = 'password' | 'login' | 'link';
interface Entry { id: string; type: EntryType; title: string; login: string; password: string; url: string; notes: string }

const TYPES: Record<EntryType, { name: string; fields: Array<keyof Entry>; req: Array<keyof Entry> }> = {
  password: { name: 'Password', fields: ['title', 'password', 'notes'], req: ['title', 'password'] },
  login: { name: 'Login', fields: ['login', 'password', 'url', 'notes'], req: ['login', 'password'] },
  link: { name: 'Link', fields: ['title', 'url', 'notes'], req: ['title', 'url'] },
};
const IDLE_LOCK_MS = 15 * 60 * 1000;

// the unlocked key lives only in memory: closing the panel keeps it open, restarting the app locks it
let sessionKey: CryptoKey | null = null;
let sessionSalt = '';
let lastActive = 0;

const svg = (d: ReactNode, cls = 'ic') => <svg viewBox="0 0 24 24" className={cls}>{d}</svg>;
const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 } as const;
const IC = {
  key: svg(<><circle cx="8" cy="15" r="4.2" {...S} /><path d="M11 12l8-8M16.5 6.5L19 9M14 9l2 2" {...S} strokeLinecap="round" /></>),
  user: svg(<><circle cx="12" cy="8" r="3.6" {...S} /><path d="M5 20c0-3.5 3.1-6 7-6s7 2.5 7 6" {...S} strokeLinecap="round" /></>),
  link: svg(<path d="M9.5 14.5l5-5M8 12l-2.5 2.5a3.5 3.5 0 005 5L18 16M16 12l2.5-2.5a3.5 3.5 0 00-5-5L11 8" {...S} strokeLinecap="round" />),
  grid: svg(<>{[[3.5, 3.5], [13.5, 3.5], [3.5, 13.5], [13.5, 13.5]].map(([x, y]) => <rect key={`${x}${y}`} x={x} y={y} width="7" height="7" rx="1.6" {...S} />)}</>),
  bolt: svg(<path d="M13 2L4.5 13.5H11l-1 8.5 8.5-11.5H12z" {...S} strokeLinejoin="round" />),
  lock: svg(<><rect x="5" y="10.5" width="14" height="10" rx="2.2" {...S} /><path d="M8 10.5V7.5a4 4 0 018 0v3" {...S} /></>),
  plus: svg(<path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />),
  search: svg(<path d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />, 'search-icon'),
  edit: svg(<path d="M4 20h4L18.5 9.5a2 2 0 00-3-3L5 17v3z" {...S} strokeLinejoin="round" />),
  trash: svg(<path d="M5 7h14M10 7V5h4v2M6 7l1 13h10l1-13" {...S} strokeLinecap="round" strokeLinejoin="round" />),
  copy: svg(<><rect x="8" y="8" width="12" height="12" rx="2" {...S} /><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" {...S} /></>),
  eye: svg(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" {...S} /><circle cx="12" cy="12" r="2.6" {...S} /></>),
  eyeOff: svg(<path d="M4 4l16 16M9.5 9.6A2.6 2.6 0 0012 14.6M6.5 6.7C3.9 8.2 2 12 2 12s3.5 7 10 7c1.8 0 3.3-.5 4.6-1.2M10 5.2A9.6 9.6 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-2.2 3" {...S} strokeLinecap="round" />),
  more: svg(<><circle cx="12" cy="5" r="1.7" fill="currentColor" /><circle cx="12" cy="12" r="1.7" fill="currentColor" /><circle cx="12" cy="19" r="1.7" fill="currentColor" /></>),
  down: svg(<path d="M12 3v12M8 11l4 4 4-4M4 20h16" {...S} strokeLinecap="round" strokeLinejoin="round" />),
  up: svg(<path d="M12 15V3M8 7l4-4 4 4M4 20h16" {...S} strokeLinecap="round" strokeLinejoin="round" />),
  refresh: svg(<path d="M4 12a8 8 0 0113.5-5.5L20 9M20 4v5h-5M20 12a8 8 0 01-13.5 5.5L4 15M4 20v-5h5" {...S} strokeLinecap="round" strokeLinejoin="round" />),
};
const TYPE_IC: Record<EntryType, ReactNode> = { password: IC.key, login: IC.user, link: IC.link };

function faviconFor(url: string): string | null {
  try { return `https://www.google.com/s2/favicons?domain=${new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname}&sz=64`; } catch { return null; }
}
const href = (url: string) => (/^https?:/i.test(url) ? url : `https://${url}`);

export function CovertyPanel() {
  const [state, setState] = useState<'loading' | 'setup' | 'locked' | 'open'>('loading');
  const [vault, setVault] = useState<SealedVault | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | EntryType>('all');
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<null | { step: 'type' } | { step: 'form'; entry: Entry; isNew: boolean }>(null);
  const [confirmDel, setConfirmDel] = useState<Entry | null>(null);
  const [gen, setGen] = useState<null | { len: number; upper: boolean; lower: boolean; num: boolean; sym: boolean; value: string }>(null);
  const [menu, setMenu] = useState(false);
  const [toastText, setToastText] = useState('');
  const importRef = useRef<HTMLInputElement>(null);

  const toast = (text: string) => { setToastText(text); window.setTimeout(() => setToastText(''), 1600); };

  const persist = useCallback(async (next: Entry[]) => {
    if (!sessionKey) return;
    const sealed = await seal(sessionKey, sessionSalt, { entries: next });
    await savePluginData('coverty', sealed);
    setVault(sealed); setEntries(next); lastActive = Date.now();
  }, []);

  const lock = useCallback(() => { sessionKey = null; sessionSalt = ''; setEntries([]); setShown(new Set()); setPw1(''); setModal(null); setState('locked'); }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const stored = await loadPluginData<SealedVault>('coverty');
        if (!alive) return;
        setVault(stored);
        if (!stored) { setState('setup'); return; }
        if (sessionKey && Date.now() - lastActive < IDLE_LOCK_MS) {
          const data = await unseal<{ entries: Entry[] }>(sessionKey, stored);
          if (alive) { setEntries(data.entries ?? []); setState('open'); lastActive = Date.now(); }
        } else { sessionKey = null; setState('locked'); }
      } catch { if (alive) { sessionKey = null; setState('locked'); } }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (state !== 'open') return;
    const timer = window.setInterval(() => { if (Date.now() - lastActive > IDLE_LOCK_MS) lock(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [state, lock]);

  const setup = async () => {
    setErr('');
    if (pw1.length < 8) { setErr('At least 8 characters'); return; }
    if (pw1 !== pw2) { setErr("Passwords don't match"); return; }
    const { salt, key } = await newVaultKey(pw1);
    sessionKey = key; sessionSalt = salt; lastActive = Date.now();
    const sealed = await seal(key, salt, { entries: [] });
    await savePluginData('coverty', sealed);
    setVault(sealed); setEntries([]); setPw1(''); setPw2(''); setState('open');
  };
  const unlock = async () => {
    if (!vault) return;
    setErr('');
    try {
      const key = await keyFromSalt(pw1, vault.salt);
      const data = await unseal<{ entries: Entry[] }>(key, vault);
      sessionKey = key; sessionSalt = vault.salt; lastActive = Date.now();
      setEntries(data.entries ?? []); setPw1(''); setState('open');
    } catch { setErr('Wrong master password'); }
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    toast('Copied');
    window.setTimeout(() => void navigator.clipboard?.writeText('').catch(() => undefined), 30_000);
  };

  const saveForm = async (e: FormEvent) => {
    e.preventDefault();
    if (modal?.step !== 'form') return;
    const { entry, isNew } = modal;
    if (TYPES[entry.type].req.some((k) => !String(entry[k] ?? '').trim())) { toast('Fill in the required fields'); return; }
    await persist(isNew ? [entry, ...entries] : entries.map((x) => (x.id === entry.id ? entry : x)));
    setModal(null);
    toast('Saved');
  };

  const importFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const list = (Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown }).entries) as Partial<Entry>[] | undefined;
      if (!Array.isArray(list)) throw new Error();
      const fresh = list.filter((x) => x && (x.type === 'password' || x.type === 'login' || x.type === 'link')).map((x) => ({
        id: crypto.randomUUID(), type: x.type as EntryType, title: String(x.title ?? ''), login: String(x.login ?? ''), password: String(x.password ?? ''), url: String(x.url ?? ''), notes: String(x.notes ?? ''),
      }));
      await persist([...fresh, ...entries]);
      toast(`Imported: ${fresh.length}`);
    } catch { toast('Not a vault export'); }
  };
  const exportAll = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ entries }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'zeithub-vault.json'; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const regen = (g: NonNullable<typeof gen>) => ({ ...g, value: generatePassword(g.len, { upper: g.upper, lower: g.lower, digits: g.num, symbols: g.sym }) });

  if (state === 'loading') return <div className="zh-cv" />;

  if (state !== 'open') {
    return (
      <div className="zh-cv">
        <section className="lock">
          <div className="lock-logo">{svg(<><circle cx="8" cy="15" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M11 12l8-8M16.5 6.5L19 9M14 9l2 2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></>, '')}</div>
          <h1 className="lock-title">zeithub<span>.coverty</span></h1>
          <div className="lock-box">
            <p className="lock-desc">{state === 'setup' ? <>Create a <b>master password</b>. It encrypts your whole vault. It can&apos;t be recovered — remember it.</> : 'Enter your master password to open the vault.'}</p>
            <input type="password" autoFocus placeholder="Master password" value={pw1} onChange={(e) => setPw1(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void (state === 'setup' ? setup() : unlock()); }} />
            {state === 'setup' && <input type="password" placeholder="Repeat password" value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void setup(); }} />}
            <button className="btn-primary wide" onClick={() => void (state === 'setup' ? setup() : unlock())}>{state === 'setup' ? 'Create vault' : 'Unlock'}</button>
            <p className="lock-err">{err}</p>
          </div>
        </section>
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const filtered = entries.filter((e) => (filter === 'all' || e.type === filter) && (!q || [e.title, e.url, e.login, e.notes].some((v) => (v || '').toLowerCase().includes(q))));
  const counts = { all: entries.length, password: 0, login: 0, link: 0 };
  for (const e of entries) counts[e.type]++;

  return (
    <div className="zh-cv" onMouseDown={() => { lastActive = Date.now(); }}>
      <div className="app">
        <header className="header">
          <div className="brand">
            <div className="logo">{IC.key}</div>
            <div className="brand-text"><h1>zeithub<span>.coverty</span></h1><p>{entries.length} {entries.length === 1 ? 'item' : 'items'}</p></div>
          </div>
          <div className="head-actions">
            <button className="icon-btn" title="Password generator" onClick={() => setGen(regen({ len: 16, upper: true, lower: true, num: true, sym: true, value: '' }))}>{IC.bolt}</button>
            <button className="icon-btn" title="Lock" onClick={lock}>{IC.lock}</button>
            <button className="btn-primary icon-primary" title="Add entry" onClick={() => setModal({ step: 'type' })}>{IC.plus}</button>
          </div>
        </header>

        <div className="toolbar">
          <div className="search">{IC.search}<input type="text" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          <div className="seg">
            {(['all', 'password', 'login', 'link'] as const).map((f) => (
              <button key={f} className={`seg-btn${filter === f ? ' active' : ''}`} title={f === 'all' ? 'All' : `${TYPES[f].name}s`} onClick={() => setFilter(f)}>
                {f === 'all' ? IC.grid : TYPE_IC[f]}<span className="cnt">{counts[f]}</span>
              </button>
            ))}
          </div>
        </div>

        {filtered.length > 0 ? (
          <ul className="list">
            {filtered.map((e) => {
              const fav = e.url ? faviconFor(e.url) : null;
              const open = shown.has(e.id);
              return (
                <li key={e.id} className="card">
                  <div className="card-top">
                    <div className="favicon">{fav ? <img src={fav} alt="" /> : TYPE_IC[e.type]}</div>
                    <div className="card-main">
                      <div className="card-title">{e.title || e.login || e.url || 'Untitled'}<span className="type-tag">{TYPE_IC[e.type]}</span></div>
                      <div className="card-url">{e.url ? <a href={href(e.url)} target="_blank" rel="noopener noreferrer">{e.url}</a> : '—'}</div>
                    </div>
                    <div className="card-actions">
                      <button className="icon-btn" title="Edit" onClick={() => setModal({ step: 'form', entry: { ...e }, isNew: false })}>{IC.edit}</button>
                      <button className="icon-btn danger" title="Delete" onClick={() => setConfirmDel(e)}>{IC.trash}</button>
                    </div>
                  </div>
                  {e.login && (
                    <div className="field-row"><span className="label">Login</span><span className="value">{e.login}</span>
                      <span className="mini-actions"><button className="icon-btn" title="Copy" onClick={() => copy(e.login)}>{IC.copy}</button></span></div>
                  )}
                  {e.password && (
                    <div className="field-row"><span className="label">Password</span><span className="value">{open ? e.password : '••••••••'}</span>
                      <span className="mini-actions">
                        <button className="icon-btn" title="Show" onClick={() => setShown((s) => { const n = new Set(s); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n; })}>{open ? IC.eyeOff : IC.eye}</button>
                        <button className="icon-btn" title="Copy" onClick={() => copy(e.password)}>{IC.copy}</button>
                      </span></div>
                  )}
                  {e.notes && <div className="notes">{e.notes}</div>}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="empty show">
            <div className="empty-ic">{svg(<><circle cx="8" cy="15" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M11 12l8-8M16.5 6.5L19 9M14 9l2 2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>, '')}</div>
            <p>{entries.length ? 'No matches.' : 'Nothing here yet. Tap + to add your first entry.'}</p>
          </div>
        )}

        <footer className="footbar">
          <span className="copyright">© 2024 zeithub</span>
          <div className="menu-wrap">
            <button className="icon-btn" title="More" onClick={() => setMenu((v) => !v)}>{IC.more}</button>
            {menu && (
              <div className="menu">
                <button onClick={() => { setMenu(false); exportAll(); }}>{IC.down} Export to JSON</button>
                <button onClick={() => { setMenu(false); importRef.current?.click(); }}>{IC.up} Import from JSON</button>
              </div>
            )}
          </div>
          <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
        </footer>
      </div>

      {modal && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null); }}>
          <div className="modal">
            <h2>{modal.step === 'form' && !modal.isNew ? 'Edit entry' : 'New entry'}</h2>
            {modal.step === 'type' ? (
              <div className="type-picker">
                {([['password', 'name + password'], ['login', 'login + password + link'], ['link', 'name + link']] as const).map(([k, hint]) => (
                  <button key={k} type="button" className="type-card" onClick={() => setModal({ step: 'form', isNew: true, entry: { id: crypto.randomUUID(), type: k, title: '', login: '', password: '', url: '', notes: '' } })}>
                    <span className="type-ic">{TYPE_IC[k]}</span><span>{TYPES[k].name}</span><small>{hint}</small>
                  </button>
                ))}
              </div>
            ) : (
              <form id="form" onSubmit={(e) => void saveForm(e)}>
                {TYPES[modal.entry.type].fields.map((f) => {
                  const set = (v: string) => setModal({ ...modal, entry: { ...modal.entry, [f]: v } });
                  if (f === 'notes') return <label key={f}>Notes<textarea rows={2} placeholder="Optional…" value={modal.entry.notes} onChange={(e) => set(e.target.value)} /></label>;
                  if (f === 'password') return (
                    <label key={f}>Password<div className="pw-field"><input type="password" placeholder="••••••••" value={modal.entry.password} onChange={(e) => set(e.target.value)} />
                      <button type="button" className="btn-mini" title="Generate" onClick={() => set(generatePassword(16, { upper: true, lower: true, digits: true, symbols: true }))}>⚡</button></div></label>
                  );
                  const label = f === 'title' ? 'Name' : f === 'login' ? 'Login / e-mail' : 'Link';
                  const ph = f === 'title' ? 'e.g. GitHub' : f === 'login' ? 'user@mail.com' : 'https://…';
                  return <label key={f}>{label}{f === 'url' && modal.entry.type === 'login' && <span className="opt"> (optional)</span>}<input type="text" placeholder={ph} value={modal.entry[f]} onChange={(e) => set(e.target.value)} autoFocus={f === TYPES[modal.entry.type].fields[0]} /></label>;
                })}
                <div className="modal-actions">
                  <button type="button" className="btn-ghost" onClick={() => setModal(null)}>Cancel</button>
                  <button type="submit" className="btn-primary">Save</button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {gen && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setGen(null); }}>
          <div className="modal">
            <h2>Password generator</h2>
            <div className="gen-out">
              <span className="gen-value">{gen.value || '••••••••••••'}</span>
              <button className="icon-btn" title="Copy" onClick={() => copy(gen.value)}>{IC.copy}</button>
              <button className="icon-btn" title="Regenerate" onClick={() => setGen(regen(gen))}>{IC.refresh}</button>
            </div>
            <div className="gen-len"><span>Length</span><input type="range" min={6} max={40} value={gen.len} onChange={(e) => setGen(regen({ ...gen, len: Number(e.target.value) }))} /><span className="gen-len-val">{gen.len}</span></div>
            <div className="gen-opts">
              {([['upper', 'A-Z'], ['lower', 'a-z'], ['num', '0-9'], ['sym', '!@#']] as const).map(([k, l]) => (
                <label key={k}><input type="checkbox" checked={gen[k]} onChange={(e) => setGen(regen({ ...gen, [k]: e.target.checked }))} /> {l}</label>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={() => setGen(null)}>Close</button>
              <button type="button" className="btn-primary" onClick={() => { const value = gen.value; setGen(null); setModal({ step: 'form', isNew: true, entry: { id: crypto.randomUUID(), type: 'password', title: '', login: '', password: value, url: '', notes: '' } }); }}>Save as…</button>
            </div>
          </div>
        </div>
      )}

      {confirmDel && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmDel(null); }}>
          <div className="modal confirm-modal">
            <div className="confirm-ic">{IC.trash}</div>
            <h2>Delete entry?</h2>
            <p className="confirm-text">“<span>{confirmDel.title || confirmDel.login || confirmDel.url}</span>” will be permanently deleted. This can&apos;t be undone.</p>
            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={() => setConfirmDel(null)}>Cancel</button>
              <button type="button" className="btn-danger" onClick={() => { const id = confirmDel.id; setConfirmDel(null); void persist(entries.filter((x) => x.id !== id)).then(() => toast('Deleted')); }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {toastText && <div className="toast">{toastText}</div>}
    </div>
  );
}
