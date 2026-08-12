'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Retries the current page against the server.
 *
 * `router.refresh()` rather than `location.reload()`: it re-runs the server components and
 * streams the result in, keeping the app shell, the theme and any scroll position intact. A full
 * reload throws all of that away to answer the same question.
 *
 * `onRetry` lets an error boundary pass its own `reset()`, which must be called for React to
 * leave the error state — a refresh alone would fetch new data into a boundary still showing the
 * error.
 */
export function RetryButton({ onRetry }: { onRetry?: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [attempted, setAttempted] = useState(false);

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setAttempted(true);
          startTransition(() => {
            router.refresh();
            onRetry?.();
          });
        }}
        className="rounded-md bg-brand px-3 py-1.5 text-sm font-semibold text-brand-contrast transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending ? 'Retrying…' : 'Try again'}
      </button>

      {/*
        Shown only after a retry has actually been attempted and finished. Saying "still
        unreachable" before anyone has tried would be asserting something we have not checked.
      */}
      {attempted && !pending && (
        <span className="text-xs text-text-secondary">Still unreachable — the service may be restarting.</span>
      )}
    </div>
  );
}
