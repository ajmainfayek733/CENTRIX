import type { ReactNode } from 'react';
import { Card, Notice } from '@/components/ui';
import { RetryButton } from '@/components/RetryButton';

/**
 * What the dashboard shows when it cannot reach the monitoring service.
 *
 * Three things it deliberately does:
 *
 *   1. **Says what is actually wrong.** "Could not reach the monitoring service" is a different
 *      problem from "your session expired" and points at a different fix. Presenting an outage as
 *      an auth failure sends an operator to re-enter a password that was never the issue.
 *
 *   2. **States what is still true.** Agents keep collecting and queue locally through an outage;
 *      nothing is lost while this screen is up. That is the first question anyone looks at this
 *      page to answer, and leaving it unanswered invites a panicked call.
 *
 *   3. **Offers a retry that costs nothing.** Outages here are usually a restart or a brief
 *      network blip, so the useful action is to try again, not to reload the whole app.
 */
export function ServiceUnavailable({
  detail,
  children,
}: {
  /** Optional operator-facing hint. Never a stack trace or an internal hostname. */
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <Card title="Monitoring service unavailable">
      <div className="space-y-4">
        <p className="text-sm text-text-primary">
          The dashboard could not reach the monitoring service, so it has nothing current to show.
        </p>

        <Notice>
          <span className="font-medium text-text-primary">No data is being lost.</span> Agents keep
          recording locally while the service is unreachable and upload everything they queued
          once it returns.
        </Notice>

        {detail && <p className="text-xs text-text-tertiary">{detail}</p>}

        <div className="flex items-center gap-3">
          <RetryButton />
          {children}
        </div>
      </div>
    </Card>
  );
}
