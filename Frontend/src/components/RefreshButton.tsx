'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { RotateCw } from 'lucide-react';
import { IconButton } from '@/components/ui';
import { cn } from '@/lib/utils';

/**
 * Re-runs the current screen against the server.
 *
 * `router.refresh()` rather than `location.reload()`: it re-renders the server components and
 * streams the result in, keeping the app shell, the socket, the theme and the scroll position.
 * A full reload throws all of that away - including the open realtime connection - to answer the
 * same question.
 *
 * Every screen here is `force-dynamic`, so this always fetches fresh data; there is no cache for
 * it to be defeated by. Distinct from `RetryButton`, which is the same action offered as a
 * recovery step inside an error boundary - this one is the routine control in the topbar.
 */
export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <IconButton
      type="button"
      aria-label="Refresh this screen"
      title="Refresh"
      // Announced rather than only shown: the icon spin is the sole visual cue that anything is
      // happening, and it is invisible to a screen reader and to anyone with reduced motion on.
      aria-busy={pending}
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      <RotateCw
        className={cn('size-[18px]', pending && 'motion-safe:animate-spin')}
        strokeWidth={1.75}
        aria-hidden
      />
    </IconButton>
  );
}
