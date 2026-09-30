import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Shared 404 presentation. Two call sites render it differently on purpose:
 *
 *   - `(dashboard)/not-found.tsx` sits inside the shell, so this is just the card body.
 *   - `app/not-found.tsx` wraps it in a full-page frame for URLs that never hit the dashboard.
 *
 * The large code is decorative; the headline and copy carry the meaning for screen readers.
 */
export function NotFoundPanel({
  title,
  description,
  hint,
  actions,
}: {
  title: string;
  description: string;
  /** Optional extra context shown in the muted callout box. */
  hint?: string;
  actions: ReactNode;
}) {
  return (
    <div className="relative overflow-hidden">
      <p
        className="pointer-events-none absolute -top-6 right-0 font-mono text-[7rem] font-semibold leading-none tracking-tighter text-brand/10 select-none sm:text-[9rem]"
        aria-hidden
      >
        404
      </p>

      <div className="relative space-y-5">
        <div className="flex items-center gap-2">
          <span
            className="inline-block size-2 shrink-0 rounded-full bg-text-secondary/40"
            aria-hidden
          />
          <p className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
            Page not found
          </p>
        </div>

        <div className="max-w-lg space-y-2">
          <h1 className="text-lg font-semibold text-text-primary">{title}</h1>
          <p className="text-sm text-text-secondary">{description}</p>
        </div>

        {hint && (
          <div className="max-w-lg rounded-md border border-border bg-surface-muted px-4 py-3">
            <p className="text-sm text-text-secondary">{hint}</p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">{actions}</div>
      </div>
    </div>
  );
}

export function NotFoundLink({
  href,
  children,
  primary = false,
}: {
  href: string;
  children: ReactNode;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={
        primary
          ? 'rounded-md bg-brand px-4 py-2 text-sm font-semibold text-brand-contrast transition-opacity hover:opacity-90'
          : 'rounded-md border border-border bg-surface px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-muted'
      }
    >
      {children}
    </Link>
  );
}
