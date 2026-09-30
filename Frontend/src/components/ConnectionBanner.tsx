'use client';

import { useEffect, useState } from 'react';
import { useRealtime } from '@/components/RealtimeProvider';

/**
 * Tells the operator when what they are looking at has stopped updating.
 *
 * The dashboard's figures move because ingest events push aggregates in. When that channel is
 * down the numbers simply stop - they do not blank, go stale-looking, or announce themselves.
 * A screen that quietly freezes is the failure mode worth guarding against here: it looks
 * identical to a quiet afternoon, and someone will read it as "nobody is working".
 *
 * Deliberately not shown the instant the socket drops. A reconnect usually takes a second or two,
 * and a banner that flickers on every blip teaches people to ignore it - which costs exactly the
 * time it matters.
 */

/** How long the channel must stay down before this is worth interrupting anyone about. */
const GRACE_PERIOD_MS = 10_000;

export function ConnectionBanner() {
  const { connected } = useRealtime();
  const [gracePeriodElapsed, setGracePeriodElapsed] = useState(false);

  useEffect(() => {
    if (connected) {
      const resetTimer = setTimeout(() => setGracePeriodElapsed(false), 0);
      return () => clearTimeout(resetTimer);
    }

    const timer = setTimeout(() => setGracePeriodElapsed(true), GRACE_PERIOD_MS);
    return () => clearTimeout(timer);
  }, [connected]);

  if (connected || !gracePeriodElapsed) return null;

  return (
    <div
      className="mb-3.5 rounded-lg border border-warning/40 bg-warning/10 px-[18px] py-3.5"
      // Polite rather than assertive: this is a status change, not something demanding an
      // immediate response, and it must not interrupt whatever a screen reader is mid-sentence on.
      role="status"
      aria-live="polite"
    >
      <p className="text-sm font-medium text-text-primary">Live updates are disconnected</p>
      <p className="mt-0.5 text-sm text-text-secondary">
        The figures on this page are frozen as of the last update and will not move until the
        connection returns. Agents are still recording - nothing is being lost. Reconnection is
        being retried automatically.
      </p>
    </div>
  );
}
