'use client';

import { useState } from 'react';
import { BellOff } from 'lucide-react';
import { Button } from '@/components/ui';
import { setDismissedBefore } from '@/lib/alert-dismissal';

interface AlertCountResponse {
  count: number;
  latestCreatedAt: string | null;
}

/**
 * Clears the navbar bell so that only alerts arriving from now on are counted.
 *
 * It does not resolve or hide anything: the open alerts stay in the table below. Dismissal only
 * moves this browser's "already seen" watermark, which is why the label says "dismiss" rather
 * than "resolve".
 *
 * The watermark is fetched from the server at click time rather than taken from the clock or the
 * table: the table may be a page behind the live feed, and the browser clock may be skewed. The
 * newest stored alert's own timestamp is the only value that is correct for both.
 */
export function DismissAlertsButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dismiss() {
    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/logs/alerts-count', { cache: 'no-store' });
      if (!response.ok) throw new Error(`count request failed with ${response.status}`);

      const { latestCreatedAt } = (await response.json()) as AlertCountResponse;

      // No open alerts means nothing to dismiss and the bell is already empty.
      if (latestCreatedAt && !setDismissedBefore(latestCreatedAt)) {
        setError('Your browser blocked saving this. The bell will keep counting these alerts.');
      }
    } catch (failure) {
      console.error('dismiss alerts failed:', failure);
      setError('Could not dismiss alerts. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" onClick={dismiss} disabled={pending}>
        <BellOff className="size-4" strokeWidth={1.75} aria-hidden />
        {pending ? 'Dismissing...' : 'Dismiss alerts'}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
