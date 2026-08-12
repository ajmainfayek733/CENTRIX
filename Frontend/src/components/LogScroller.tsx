'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A fixed-height, scrolling log window that loads the next page when the reader reaches the end.
 *
 * WHY FIXED HEIGHT AND WHY PAGED: a log table that renders its whole range grows without bound
 * as history accumulates — an unbounded query on the server, an unbounded payload on the wire,
 * and thousands of DOM nodes for rows nobody scrolls to. This holds a bounded window instead:
 * the first page arrives with the server-rendered page, and each subsequent page is fetched only
 * when the operator actually scrolls to the bottom.
 *
 * The page size is not decided here. The server reads it from policy, so an admin changes it on
 * the settings screen — this component just asks for "the next page".
 */

/** One page of a keyset-paginated feed, matching the backend's `Page<T>`. */
export interface LogPage<T> {
  rows: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface LogScrollerProps<T> {
  /** First page, rendered on the server so the table is populated before any JavaScript runs. */
  initial: LogPage<T>;
  /** Feed name, resolved by /api/logs/[feed]. */
  feed: 'activity' | 'alerts' | 'usb';
  /** Extra query parameters (employeeId, date range, …). */
  params?: Record<string, string | undefined>;
  /** Stable identity for a row, used as the React key and to drop duplicates. */
  rowKey: (row: T) => string;
  children: (rows: T[]) => ReactNode;
  /** Height of the scroll window. A CSS length — the window is fixed, the content scrolls. */
  height?: string;
  emptyMessage?: string;
}

/**
 * How far before the end to start loading, so the next page is usually there by the time the
 * reader arrives. Expressed as a root margin on the sentinel rather than a scroll-offset
 * calculation, which would have to run on every scroll event.
 */
const PREFETCH_MARGIN = '200px';

export function LogScroller<T>({
  initial,
  feed,
  params,
  rowKey,
  children,
  height = '28rem',
  emptyMessage = 'Nothing recorded for this period.',
}: LogScrollerProps<T>) {
  const [rows, setRows] = useState<T[]>(initial.rows);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [hasMore, setHasMore] = useState(initial.hasMore);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sentinel = useRef<HTMLDivElement | null>(null);

  // Guards against two loads racing: the observer can fire again while a fetch is in flight, and
  // both would append the same page. A ref rather than the `loading` state because the observer
  // callback closes over the value at registration time.
  const inFlight = useRef(false);

  // A new first page (date range changed, or the realtime refresh re-ran the server component)
  // replaces everything. Without this the window would keep showing rows from the old query and
  // append the new range underneath them.
  useEffect(() => {
    setRows(initial.rows);
    setCursor(initial.nextCursor);
    setHasMore(initial.hasMore);
    setError(null);
  }, [initial]);

  const loadMore = useCallback(async () => {
    if (inFlight.current || !hasMore || !cursor) return;

    inFlight.current = true;
    setLoading(true);
    setError(null);

    try {
      const query = new URLSearchParams({ cursor });
      for (const [name, value] of Object.entries(params ?? {})) {
        if (value) query.set(name, value);
      }

      const response = await fetch(`/api/logs/${feed}?${query}`);
      if (!response.ok) throw new Error('request failed');

      const page = (await response.json()) as LogPage<T>;

      setRows((current) => {
        // The cursor makes duplicates impossible in a static feed, but this one is live: a row
        // inserted above the cursor between two requests can appear on both pages. Dropping keys
        // already held is cheaper than reasoning about it, and keeps React keys unique.
        const seen = new Set(current.map(rowKey));
        return [...current, ...page.rows.filter((row) => !seen.has(rowKey(row)))];
      });

      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch {
      // Left recoverable on purpose: `hasMore` stays true, so scrolling again retries rather
      // than the window silently deciding the feed ended.
      setError('Could not load more entries.');
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [cursor, feed, hasMore, params, rowKey]);

  useEffect(() => {
    const target = sentinel.current;
    if (!target || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      // Scoped to the scroll container, not the viewport: the window scrolls internally, so the
      // sentinel never enters the viewport and a default-root observer would never fire.
      { root: target.parentElement, rootMargin: PREFETCH_MARGIN }
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

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

      <div ref={sentinel} aria-hidden />

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
