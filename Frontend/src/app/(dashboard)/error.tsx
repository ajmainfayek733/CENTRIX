'use client';

import { useEffect } from 'react';
import { Card } from '@/components/ui';
import { RetryButton } from '@/components/RetryButton';

/**
 * Error boundary for every dashboard screen.
 *
 * Without one, a single failing API call blanks the page and shows Next's generic error screen -
 * no navigation, no theme, no indication of whether the problem is this screen or the whole
 * system. This keeps the shell (the layout above it still renders) and answers the two questions
 * an operator actually has: is it broken for everyone, and is data being lost?
 *
 * The distinction between an outage and a bug is made from the message rather than the error
 * type: React strips server-side errors before they reach the client, replacing them with a
 * generic Error and a digest, so `instanceof ApiUnavailableError` cannot survive the boundary.
 * The message is matched for the shape our own client produces and anything unrecognized is
 * treated as a bug - the safer way round, since calling a genuine bug an outage would have people
 * waiting for a service to come back that was never down.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The user gets a plain explanation; the console gets the detail needed to diagnose it.
    console.error('Dashboard render failed:', error);
  }, [error]);

  const looksUnavailable =
    error.name === 'ApiUnavailableError' ||
    /could not reach the monitoring service|monitoring service returned 5/i.test(error.message);

  if (looksUnavailable) {
    return (
      <Card title="Monitoring service unavailable">
        <div className="space-y-4">
          <p className="text-sm">
            This screen could not load because the monitoring service did not respond.
          </p>

          <div className="rounded-md border border-border bg-surface-muted px-4 py-3">
            <p className="text-sm text-text-secondary">
              <span className="font-medium text-text-primary">No data is being lost.</span> Agents
              keep recording locally and upload what they queued once the service returns.
            </p>
          </div>

          <RetryButton onRetry={reset} />
        </div>
      </Card>
    );
  }

  return (
    <Card title="Something went wrong on this screen">
      <div className="space-y-4">
        <p className="text-sm">
          The dashboard hit an unexpected error rendering this page. Other screens may still work.
        </p>

        {/*
          The digest is Next's server-side correlation id. It is the one thing that makes a user's
          report traceable to a specific server log line, so it is shown rather than hidden -
          unlike the message, which for a server error is deliberately redacted anyway.
        */}
        {error.digest && (
          <p className="font-mono text-xs text-text-secondary">Reference: {error.digest}</p>
        )}

        <RetryButton onRetry={reset} />
      </div>
    </Card>
  );
}
