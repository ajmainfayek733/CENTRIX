'use client';

import { useEffect } from 'react';

/**
 * Last-resort boundary for anything outside the dashboard shell — the login screen, the root
 * redirect, and any failure in the dashboard layout itself (which sits above
 * `(dashboard)/error.tsx` and so cannot be caught by it).
 *
 * Intentionally plain: this renders when the app shell may not have loaded, so it depends on
 * nothing but the theme tokens already in the stylesheet.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Unhandled application error:', error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
      <h1 className="text-lg font-semibold">Employee Monitor is temporarily unavailable</h1>

      <p className="mt-2 text-sm text-text-secondary">
        The dashboard could not finish loading. This is usually the monitoring service restarting;
        agents keep recording throughout, so no data is lost.
      </p>

      {error.digest && (
        <p className="mt-3 font-mono text-xs text-text-secondary">Reference: {error.digest}</p>
      )}

      <button
        type="button"
        onClick={reset}
        className="mt-5 self-start rounded-md bg-brand px-4 py-2 text-sm font-semibold text-brand-contrast transition-opacity hover:opacity-90"
      >
        Try again
      </button>
    </div>
  );
}
