"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * Keyset paging for a scroll window, shared by every feed the dashboard renders.
 *
 * WHY A HOOK AND NOT A COMPONENT: the paging behaviour (cursor, de-duplication, in-flight guard,
 * sentinel observer) is identical for a log table and a screenshot grid, but the markup is not -
 * one is rows in a <table>, the other is cells in a grid, and the grid also has to hand the loaded
 * rows to a full-screen viewer. Keeping the behaviour here means both render whatever they like
 * over one implementation, instead of the second surface re-deriving the tricky parts.
 *
 * The page size is not decided here. The server reads it from policy, so an admin changes it on
 * the settings screen - the client only ever asks for "the next page".
 */

/** One page of a keyset-paginated feed, matching the backend's `Page<T>`. */
export interface LogPage<T> {
  rows: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Feed names resolved by /api/logs/[feed]. Must stay in step with that route's allowlist. */
export type LogFeedName = "activity" | "alerts" | "usb" | "employee-usb" | "screenshots";

interface UseLogFeedOptions<T> {
  /** First page, fetched on the server so the window is populated before any JavaScript runs. */
  initial: LogPage<T>;
  feed: LogFeedName;
  /** Extra query parameters (employeeId, date range, ...). */
  params?: Record<string, string | undefined>;
  /** Stable identity for a row, used as the React key and to drop duplicates. */
  rowKey: (row: T) => string;
  /** What the feed holds, for the failure messages. Plural. */
  noun?: string;
}

/**
 * How far before the end to start loading, so the next page is usually there by the time the
 * reader arrives. Expressed as a root margin on the sentinel rather than a scroll-offset
 * calculation, which would have to run on every scroll event.
 */
const PREFETCH_MARGIN = "200px";

/** The proxy answers with this when the monitoring service itself is unreachable. */
const SERVICE_UNAVAILABLE = 503;

/** A failure with a message fit to show the operator, as opposed to an unexpected throw. */
class LoadError extends Error {}

export interface LogFeedState<T> {
  rows: T[];
  hasMore: boolean;
  loading: boolean;
  /** Operator-facing message, or null. Recoverable: `hasMore` stays true so a retry is possible. */
  error: string | null;
  loadMore: () => Promise<void>;
  /**
   * Attach to an empty element at the end of the scroll container's content. Its *parent* is used
   * as the observer root, so it must be a direct child of the element that scrolls.
   */
  sentinelRef: RefObject<HTMLDivElement | null>;
}

export function useLogFeed<T>({
  initial,
  feed,
  params,
  rowKey,
  noun = "entries",
}: UseLogFeedOptions<T>): LogFeedState<T> {
  const [rows, setRows] = useState<T[]>(initial.rows);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [hasMore, setHasMore] = useState(initial.hasMore);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Guards against two loads racing: the observer can fire again while a fetch is in flight, and
  // both would append the same page. A ref rather than the `loading` state because the observer
  // callback closes over the value at registration time.
  const inFlight = useRef(false);

  // A genuinely new first page (the date range changed, or telemetry landed at the top of the
  // feed) replaces everything. Without this the window would keep showing rows from the old query
  // and append the new range underneath them.
  //
  // Compared by content, NOT by object identity. RealtimeProvider calls router.refresh() on every
  // ingest event, and each refresh hands down a new object even when the first page is byte for
  // byte what is already on screen. Resetting on identity therefore threw away every page the
  // operator had scrolled in and returned them to the top roughly once a minute - infinite scroll
  // that cannot outlive a live dashboard's own refresh cycle. Comparing the content resets when
  // something actually changed and leaves the reader alone when nothing did.
  //
  // Adjusted during render rather than in an effect: React discards the in-progress render and
  // restarts with the new state, so the stale page is never painted. The same reset in an effect
  // paints the old rows first and then replaces them - a visible flash of the previous range.
  // Only the three fields the window actually renders. An endpoint may wrap its page in extra
  // metadata - the screenshot and USB feeds return the resolved period alongside it - and
  // `period.end` is "now", so hashing the whole object would report a change on every single
  // refresh and put us straight back to resetting the reader's scroll position.
  const signature = JSON.stringify([initial.rows, initial.nextCursor, initial.hasMore]);
  const [renderedSignature, setRenderedSignature] = useState(signature);
  if (renderedSignature !== signature) {
    setRenderedSignature(signature);
    setRows(initial.rows);
    setCursor(initial.nextCursor);
    setHasMore(initial.hasMore);
    setError(null);
  }

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

      // 503 is the monitoring service being unreachable, which is worth saying plainly - the
      // page itself is fine and retrying shortly will work. Anything else is reported generically.
      if (response.status === SERVICE_UNAVAILABLE) {
        throw new LoadError(
          `The monitoring service is unavailable. ${noun[0]?.toUpperCase()}${noun.slice(1)} already loaded are still accurate.`,
        );
      }
      if (!response.ok) throw new LoadError(`Could not load more ${noun}.`);

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
    } catch (failure) {
      // Left recoverable on purpose: `hasMore` stays true, so scrolling again retries rather
      // than the window silently deciding the feed ended.
      setError(failure instanceof LoadError ? failure.message : `Could not load more ${noun}.`);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [cursor, feed, hasMore, noun, params, rowKey]);

  useEffect(() => {
    const target = sentinelRef.current;
    if (!target || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      // Scoped to the scroll container, not the viewport: the window scrolls internally, so the
      // sentinel never enters the viewport and a default-root observer would never fire.
      { root: target.parentElement, rootMargin: PREFETCH_MARGIN },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  return { rows, hasMore, loading, error, loadMore, sentinelRef };
}
