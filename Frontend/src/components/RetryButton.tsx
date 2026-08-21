'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';

/**
 * Retries the current page against the server.
 *
 * `router.refresh()` rather than `location.reload()`: it re-runs the server components and
 * streams the result in, keeping the app shell, the theme and any scroll position intact. A full
 * reload throws all of that away to answer the same question.
 *
 * `onRetry` lets an error boundary pass its own `reset()`, which must be called for React to
 * leave the error state - a refresh alone would fetch new data into a boundary still showing the
 * error.
 */
export function RetryButton({ onRetry }: { onRetry?: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [attempted, setAttempted] = useState(false);

  return (
    <div className="flex items-center gap-3">
      <Button
        type="button"
        variant="primary"
        disabled={pending}
        onClick={() => {
          setAttempted(true);
          startTransition(() => {
            router.refresh();
            onRetry?.();
          });
        }}
      >
        {pending ? 'Retrying...' : 'Try again'}
      </Button>

      {/*
        Shown only after a retry has actually been attempted and finished. Saying "still
        unreachable" before anyone has tried would be asserting something we have not checked.
      */}
      {attempted && !pending && (
        <span className="text-xs text-text-tertiary">Still unreachable - the service may be restarting.</span>
      )}
    </div>
  );
}
