'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useT } from '../../lib/i18n';

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  /** Info mode: single OK button (styled replacement for alert()). */
  alert?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/** Styled confirm/alert dialog, promise-based. Replaces window.confirm/alert. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useT();
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => new Promise<boolean>((resolve) => {
    setState({ ...opts, resolve });
  }), []);

  const close = useCallback((value: boolean) => {
    setState((cur) => { cur?.resolve(value); return null; });
  }, []);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter') close(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => close(false)}>
          <div className="w-full max-w-sm rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl animate-fade-in" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 p-4">
              {state.danger && <span className="mt-0.5 shrink-0 grid place-items-center w-8 h-8 rounded-full bg-[var(--error)]/15 text-[var(--error)]"><AlertTriangle size={16} /></span>}
              <div className="min-w-0 flex-1">
                {state.title && <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">{state.title}</h3>}
                <p className="text-sm text-[var(--text-secondary)] leading-snug">{state.message}</p>
              </div>
              <button onClick={() => close(false)} className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={16} /></button>
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--border-color)]">
              {!state.alert && (
                <button onClick={() => close(false)} className="px-3 py-1.5 rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">
                  {state.cancelText ?? t('common.cancel')}
                </button>
              )}
              <button
                onClick={() => close(true)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  state.danger
                    ? 'bg-[var(--error)] text-white hover:opacity-90'
                    : 'bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-hover)]'
                }`}
              >
                {state.confirmText ?? 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

/** Returns confirm({message,…}) → Promise<boolean>. Falls back to window.confirm if no provider. */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  return ctx ?? ((opts: ConfirmOptions) => Promise.resolve(typeof window !== 'undefined' ? window.confirm(opts.message) : false));
}
