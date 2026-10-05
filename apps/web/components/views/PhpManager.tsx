'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Download, FileCog, Loader2, Trash2, X } from 'lucide-react';
import type { Project } from '../../types';
import {
  activatePhpBranch, fetchPhp, fetchPhpIni, installPhpBranch, removePhpBranch, saveProjectPhp, savePhpIni,
  type PhpState,
} from '../../lib/api';
import { useConfirm } from '../ui/Confirm';
import { useT } from '../../lib/i18n';

type IniTarget = { version: string } | { projectId: number };

/** Several PHP versions side by side; the global one, one per project and a php.ini per version or project. */
export function PhpManager({ project }: { project: Project | null }) {
  const { t } = useT();
  const confirm = useConfirm();
  const [state, setState] = useState<PhpState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState('');
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [ini, setIni] = useState<{ target: IniTarget; path: string; content: string; saved: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await fetchPhp(project?.id));
      setError(null);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    }
  }, [project?.id]);
  useEffect(() => { void load(); }, [load]);

  const installedBranches = new Set(state?.installed.map((p) => p.branch));
  const offer = (state?.available ?? []).filter((b) => !installedBranches.has(b.branch));
  useEffect(() => { if (!pick || installedBranches.has(pick)) setPick(offer[0]?.branch ?? ''); }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); await load(); } catch (exc) { setError(exc instanceof Error ? exc.message : String(exc)); }
  };

  const install = async () => {
    if (!pick) return;
    setInstalling(true);
    setLog([]);
    try {
      await installPhpBranch(pick, (line) => setLog((prev) => [...prev.slice(-100), line]));
    } catch (exc) {
      setLog((prev) => [...prev, exc instanceof Error ? exc.message : String(exc)]);
    }
    setInstalling(false);
    await load();
  };

  const remove = async (branch: string) => {
    const ok = await confirm({ title: t('php.remove'), message: t('php.removeMsg', { version: branch }), danger: true, confirmText: t('php.remove') });
    if (ok) await run(() => removePhpBranch(branch));
  };

  const openIni = async (target: IniTarget) => {
    try {
      const file = await fetchPhpIni(target);
      setIni({ target, path: file.path, content: file.content, saved: false });
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    }
  };

  const projectChoice = state?.project ?? null;
  const btn = 'rounded-md border border-[var(--border-color)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40';

  return (
    <section className="space-y-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('php.title')}</h3>
        <p className="text-[11px] text-[var(--text-muted)]">{t('php.hint')}</p>
      </div>

      {error && <div className="rounded border border-[var(--error)]/40 bg-[var(--error)]/10 px-2 py-1.5 text-xs text-[var(--error)]">{error}</div>}

      {/* Installed versions */}
      {state && state.installed.length === 0 && <p className="text-xs text-[var(--text-muted)]">{t('php.none')}</p>}
      <div className="space-y-1.5">
        {state?.installed.map((p) => {
          const isActive = state.active === p.branch;
          const isProject = projectChoice?.version === p.branch;
          return (
            <div key={p.branch} className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border-color)] px-2.5 py-1.5">
              <span className="font-mono text-sm text-[var(--text-primary)]">PHP {p.version}</span>
              {isActive && <span className="rounded bg-[var(--success)]/15 px-1.5 py-0.5 text-[10px] text-[var(--success)]">{t('php.active')}</span>}
              {isProject && <span className="rounded bg-[var(--accent-glow)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]">{t('php.forProject')}</span>}
              <span className="ml-auto flex flex-wrap items-center gap-1.5">
                {!isActive && <button className={btn} onClick={() => void run(() => activatePhpBranch(p.branch))}>{t('php.makeGlobal')}</button>}
                {project && !isProject && <button className={btn} onClick={() => void run(() => saveProjectPhp(project.id, p.branch, projectChoice?.customIni ?? false))}>{t('php.useHere')}</button>}
                <button className={btn} onClick={() => void openIni({ version: p.branch })}><FileCog size={11} className="mr-1 inline" />php.ini</button>
                <button className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--error)]/10 hover:text-[var(--error)]" title={t('php.remove')} aria-label={t('php.remove')} onClick={() => void remove(p.branch)}><Trash2 size={13} /></button>
              </span>
            </div>
          );
        })}
      </div>

      {/* Install another version */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={installing || offer.length === 0} aria-label={t('php.pick')} className="rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-xs">
          {offer.length === 0 && <option value="">—</option>}
          {offer.map((b) => <option key={b.branch} value={b.branch}>PHP {b.branch} · {b.version}{b.archived ? ` · ${t('php.archived')}` : ''}</option>)}
        </select>
        <button onClick={() => void install()} disabled={installing || !pick} className="flex items-center gap-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50">
          {installing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} {installing ? t('php.installing') : t('php.install')}
        </button>
      </div>
      {log.length > 0 && <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-[var(--bg-tertiary)] p-2 font-mono text-[10px] text-[var(--text-muted)]">{log.join('\n')}</pre>}

      {/* This project's choice */}
      {project && state && state.installed.length > 0 && (
        <div className="space-y-2 border-t border-[var(--border-color)] pt-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{t('php.projectTitle', { name: project.name })}</div>
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={projectChoice?.version ?? ''}
              onChange={(e) => void run(() => saveProjectPhp(project.id, e.target.value || null, projectChoice?.customIni ?? false))}
              aria-label={t('php.projectVersion')}
              className="rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-xs"
            >
              <option value="">{t('php.projectGlobal')}</option>
              {state.installed.map((p) => <option key={p.branch} value={p.branch}>PHP {p.version}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={projectChoice?.customIni ?? false}
                disabled={!projectChoice?.version}
                onChange={(e) => void run(() => saveProjectPhp(project.id, projectChoice?.version ?? null, e.target.checked))}
              />
              {t('php.customIni')}
            </label>
            {projectChoice?.customIni && <button className={btn} onClick={() => void openIni({ projectId: project.id })}><FileCog size={11} className="mr-1 inline" />{t('php.editProjectIni')}</button>}
          </div>
          <p className="text-[11px] text-[var(--text-muted)]">{t('php.projectHint')}</p>
        </div>
      )}

      {/* php.ini editor */}
      {ini && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) setIni(null); }}>
          <div role="dialog" aria-modal="true" className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl">
            <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-4 py-2.5">
              <FileCog size={15} className="text-[var(--accent)]" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-[var(--text-primary)]">php.ini</div>
                <div className="truncate font-mono text-[10px] text-[var(--text-muted)]">{ini.path}</div>
              </div>
              <button onClick={() => setIni(null)} aria-label={t('common.close')} className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"><X size={15} /></button>
            </div>
            <textarea
              value={ini.content}
              onChange={(e) => setIni({ ...ini, content: e.target.value, saved: false })}
              spellCheck={false}
              aria-label="php.ini"
              className="min-h-[300px] flex-1 resize-none bg-[var(--bg-primary)] p-3 font-mono text-xs text-[var(--text-primary)] outline-none"
            />
            <div className="flex items-center gap-3 border-t border-[var(--border-color)] px-4 py-2.5">
              <button
                onClick={async () => {
                  try { await savePhpIni(ini.target, ini.content); setIni({ ...ini, saved: true }); } catch (exc) { setError(exc instanceof Error ? exc.message : String(exc)); }
                }}
                className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--bg-primary)] hover:opacity-90"
              >{t('php.save')}</button>
              {ini.saved && <span className="flex items-center gap-1 text-xs text-[var(--success)]"><Check size={13} /> {t('php.saved')}</span>}
              <span className="ml-auto text-[11px] text-[var(--text-muted)]">{t('php.iniHint')}</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
