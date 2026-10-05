import type { CSSProperties } from 'react';

interface LogoProps {
  /** Render the tagline (big variant) instead of the compact header form. */
  variant?: 'header' | 'hero';
  className?: string;
  style?: CSSProperties;
}

/**
 * zeithub.otto brand mark.
 *
 * The symbol is two overlapping rings — the "oo" of *otto* — with the second
 * ring carrying the accent colour and a solid core (the accent dot).
 * The wordmark is a tight geometric sans; the tagline is letterspaced in the
 * accent colour, mirroring the reference lockup.
 */

/** Symbol only — used for avatars and compact branding spots. */
export function LogoMark({ size = 18, className, live = false }: { size?: number; className?: string; /** Animate: the two rings slide past each other, the core breathes. */ live?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={`shrink-0 ${live ? 'otto-mark-live' : ''} ${className ?? ''}`}
    >
      <circle className="om-a" cx="9.5" cy="12" r="5.6" stroke="var(--text-primary)" strokeWidth="1.9" />
      <circle className="om-b" cx="16.6" cy="12" r="4.1" stroke="var(--accent)" strokeWidth="1.9" />
      <circle className="om-core" cx="16.6" cy="12" r="1.35" fill="var(--accent)" />
    </svg>
  );
}

export function Logo({ variant = 'header', className, style }: LogoProps) {
  const isHero = variant === 'hero';

  return (
    <span
      className={`inline-flex items-center gap-2.5 select-none ${className ?? ''}`}
      style={style}
      aria-label="zeithub.otto"
    >
      <svg
        width={isHero ? 44 : 22}
        height={isHero ? 44 : 22}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className="shrink-0"
      >
        <circle cx="9.5" cy="12" r="5.6" stroke="var(--text-primary)" strokeWidth="1.9" />
        <circle cx="16.6" cy="12" r="4.1" stroke="var(--accent)" strokeWidth="1.9" />
        <circle cx="16.6" cy="12" r="1.35" fill="var(--accent)" />
      </svg>

      <span className="flex flex-col leading-none">
        <span
          className={`font-semibold tracking-tight text-[var(--text-primary)] ${
            isHero ? 'text-[34px]' : 'text-[17px]'
          }`}
        >
          zeithub<span className="text-[var(--accent)]">.otto</span>
        </span>
        {isHero && (
          <span className="mt-1.5 text-[9px] font-medium uppercase tracking-[0.42em] text-[var(--accent)]">
            ai coding studio
          </span>
        )}
      </span>
    </span>
  );
}
