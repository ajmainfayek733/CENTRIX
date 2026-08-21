'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { useRealtime } from '@/components/RealtimeProvider';
import { IconButton } from '@/components/ui';
import { cn } from '@/lib/utils';

/**
 * What has landed since this page was rendered.
 *
 * The blueprint draws a bell with a permanent red dot. A dot that is always lit is not a
 * notification, it is decoration - so this one is driven by the live delta the realtime provider
 * already accumulates, and it is dark when nothing has arrived.
 *
 * Deliberately scoped to "since this page loaded" rather than "unread", because there is no
 * read-state anywhere in the system to be honest about. Claiming a count of unread alerts would
 * mean inventing a per-user marker the backend does not keep, and it would be wrong the moment
 * two people looked at the same alert.
 *
 * Counts come from the socket, so they cost no request. When the socket is down the panel says
 * so instead of showing a stale zero, which would read as "nothing is happening" at exactly the
 * moment this component cannot know.
 */
export function NotificationBell() {
  const { liveDelta, connected } = useRealtime();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const alerts = liveDelta.alertCount;
  const usbEvents = liveDelta.usbEventCount;
  const total = alerts + usbEvents;

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

  const label =
    total > 0
      ? `Notifications, ${total} new since this page loaded`
      : 'Notifications, nothing new since this page loaded';

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
            className="absolute right-1.5 top-1.5 size-2 rounded-full bg-danger ring-[1.5px] ring-surface-strong"
            aria-hidden
          />
        )}
      </IconButton>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="glass absolute right-0 top-[calc(100%+8px)] z-30 w-72 rounded-lg p-3.5"
        >
          <p className="mb-2.5 text-[11px] font-medium uppercase tracking-[0.06em] text-text-tertiary">
            Since this page loaded
          </p>

          {!connected ? (
            <p className="text-[13px] leading-relaxed text-text-secondary">
              Live updates are disconnected, so nothing can be counted right now. Agents are still
              recording - nothing is being lost.
            </p>
          ) : total === 0 ? (
            <p className="text-[13px] text-text-secondary">Nothing new.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              <NotificationRow count={alerts} noun="alert" href="/alerts" onNavigate={() => setOpen(false)} />
              <NotificationRow
                count={usbEvents}
                noun="USB event"
                href="/alerts"
                onNavigate={() => setOpen(false)}
              />
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function NotificationRow({
  count,
  noun,
  href,
  onNavigate,
}: {
  count: number;
  noun: string;
  href: string;
  onNavigate: () => void;
}) {
  if (count === 0) return null;

  return (
    <li>
      <Link
        href={href}
        onClick={onNavigate}
        className={cn(
          'flex items-center justify-between gap-3 rounded-md px-2.5 py-2 text-[13px]',
          'text-text-primary transition-colors hover:bg-brand-soft hover:text-brand'
        )}
      >
        <span>
          {count} new {noun}
          {count === 1 ? '' : 's'}
        </span>
        <span className="tnum text-text-tertiary" aria-hidden>
          {'->'}
        </span>
      </Link>
    </li>
  );
}
