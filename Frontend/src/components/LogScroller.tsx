'use client';

import type { ReactNode } from 'react';
import { useLogFeed, type LogFeedName, type LogPage } from '@/lib/use-log-feed';

/**
 * A fixed-height, scrolling log window that loads the next page when the reader reaches the end.
 *
 * WHY FIXED HEIGHT AND WHY PAGED: a log table that renders its whole range grows without bound
 * as history accumulates — an unbounded query on the server, an unbounded payload on the wire,
 * and thousands of DOM nodes for rows nobody scrolls to. This holds a bounded window instead:
 * the first page arrives with the server-rendered page, and each subsequent page is fetched only
 * when the operator actually scrolls to the bottom.
 *
 * The paging itself lives in useLogFeed, which the screenshot gallery shares — this component is
 * the table-shaped presentation of it.
 */

export type { LogPage };

interface LogScrollerProps<T> {
  /** First page, rendered on the server so the table is populated before any JavaScript runs. */
  initial: LogPage<T>;
  /** Feed name, resolved by /api/logs/[feed]. */
  feed: Extract<LogFeedName, 'activity' | 'alerts' | 'usb'>;
  /** Extra query parameters (employeeId, date range, …). */
  params?: Record<string, string | undefined>;
  /** Stable identity for a row, used as the React key and to drop duplicates. */
  rowKey: (row: T) => string;
  children: (rows: T[]) => ReactNode;
  /** Height of the scroll window. A CSS length — the window is fixed, the content scrolls. */
  height?: string;
  emptyMessage?: string;
}

export function LogScroller<T>({
  initial,
  feed,
  params,
  rowKey,
  children,
  height = '28rem',
  emptyMessage = 'Nothing recorded for this period.',
}: LogScrollerProps<T>) {
  const { rows, hasMore, loading, error, loadMore, sentinelRef } = useLogFeed({
    initial,
    feed,
    params,
    rowKey,
  });

  return (
    <div
      className="overflow-y-auto"
      style={{ height }}
      // The window is a scrollable region of its own, so it must be reachable and announced to
      // anyone not using a mouse.
      tabIndex={0}
      role="region"
      aria-label="Log entries"
      aria-busy={loading}
    >
      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-text-secondary">{emptyMessage}</p>
      ) : (
        children(rows)
      )}

      <div ref={sentinelRef} aria-hidden />

      {loading && <p className="py-3 text-center text-xs text-text-secondary">Loading more…</p>}

      {error && (
        <p className="py-3 text-center text-xs text-danger">
          {error}{' '}
          <button type="button" onClick={() => void loadMore()} className="underline">
            Retry
          </button>
        </p>
      )}

      {!hasMore && rows.length > 0 && (
        <p className="py-3 text-center text-xs text-text-secondary">End of log.</p>
      )}
    </div>
  );
}
