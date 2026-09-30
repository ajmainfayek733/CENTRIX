'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { useRealtime } from '@/components/RealtimeProvider';
import { IconButton } from '@/components/ui';
import { useDismissedBefore } from '@/lib/alert-dismissal';
import { playAlertTone } from '@/lib/alert-tone';
import { cn } from '@/lib/utils';

/** Counts above this render as "99+", so the badge never outgrows the button. */
const MAX_BADGE_COUNT = 99;
const BADGE_OVERFLOW_LABEL = `${MAX_BADGE_COUNT}+`;

const ALERT_COUNT_URL = '/api/logs/alerts-count';

interface AlertCountResponse {
  count: number;
}

/**
 * Open alerts that arrived after the operator last pressed "Dismiss alerts".
 *
 * The count is authoritative from the server (`/alerts/count?since=watermark`), not accumulated
 * from socket deltas: deltas reset on every page refresh and miss anything that landed while the
 * socket was down, which would leave the badge silently wrong. The socket is only the trigger -
 * an alert event, a reconnect or a dismissal re-reads the count.
 *
 * The tone rings when the count rises above what this tab last saw. The first read after mount
 * never rings: alerts that were already waiting are not "new", and a tone on every page load
 * would train people to ignore it.
 */
function useNewAlertCount(): number {
  const { liveDelta, connected } = useRealtime();
  const dismissedBefore = useDismissedBefore();
  const [count, setCount] = useState(0);
  const previousCount = useRef<number | null>(null);

  const liveAlertCount = liveDelta.alertCount;

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        const query = dismissedBefore ? `?since=${encodeURIComponent(dismissedBefore)}` : '';
        const response = await fetch(`${ALERT_COUNT_URL}${query}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) return;

        const { count: next } = (await response.json()) as AlertCountResponse;

        const previous = previousCount.current;
        previousCount.current = next;
        setCount(next);

        if (previous !== null && next > previous) void playAlertTone();
      } catch (error) {
        // Aborted on unmount or on a newer request superseding this one; not a failure.
        if (error instanceof DOMException && error.name === 'AbortError') return;
        // Anything else leaves the last known count on screen rather than flashing to zero.
        console.warn('alert count could not be loaded:', error);
      }
    }

    void load();
    return () => controller.abort();
    // liveAlertCount and connected are triggers, not inputs: each change means the server may
    // hold alerts this tab has not counted.
  }, [dismissedBefore, connected, liveAlertCount]);

  return count;
}

export function NotificationBell() {
  const { connected } = useRealtime();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const total = useNewAlertCount();

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const badge = total > MAX_BADGE_COUNT ? BADGE_OVERFLOW_LABEL : String(total);

  const label =
    total > 0
      ? `Notifications, ${badge} new alert${total === 1 ? '' : 's'}`
      : 'Notifications, no new alerts';

  return (
    <div ref={containerRef} className="relative">
      <IconButton
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <Bell className="size-[18px]" strokeWidth={1.75} aria-hidden />
        {total > 0 && (
          <span
            className="tnum absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-white ring-[1.5px] ring-surface-strong"
            aria-hidden
          >
            {badge}
          </span>
        )}
      </IconButton>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="glass absolute right-0 top-[calc(100%+8px)] z-30 w-72 rounded-lg p-3.5"
        >
          <p className="mb-2.5 text-[11px] font-medium uppercase tracking-[0.06em] text-text-tertiary">
            New alerts
          </p>

          {total === 0 ? (
            <p className="text-[13px] text-text-secondary">Nothing new.</p>
          ) : (
            <Link
              href="/alerts"
              onClick={() => setOpen(false)}
              className={cn(
                'flex items-center justify-between gap-3 rounded-md px-2.5 py-2 text-[13px]',
                'text-text-primary transition-colors hover:bg-brand-soft hover:text-brand'
              )}
            >
              <span>
                {badge} new alert{total === 1 ? '' : 's'}
              </span>
              <span className="tnum text-text-tertiary" aria-hidden>
                {'->'}
              </span>
            </Link>
          )}

          {!connected && (
            <p className="mt-2.5 text-xs leading-relaxed text-text-tertiary">
              Live updates are disconnected, so new alerts will not appear until it reconnects.
              Agents are still recording - nothing is being lost.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
