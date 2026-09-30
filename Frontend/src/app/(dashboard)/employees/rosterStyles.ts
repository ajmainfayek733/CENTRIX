/** Solid fills so roster controls stay readable over the page gradient in both themes. */
export const ROSTER_PRIMARY_CLASS =
  'border border-brand-strong bg-brand-strong text-brand-contrast shadow-none hover:bg-brand hover:text-brand-contrast';
export const ROSTER_SECONDARY_CLASS =
  'border border-border-strong bg-surface-strong text-text-primary shadow-none hover:bg-surface-muted hover:text-text-primary';

/** Rows past this are rejected by the server anyway; catching it here gives a better message. */
export const MAX_ROSTER_ROWS = 1000;
