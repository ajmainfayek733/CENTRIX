'use client';

import { useCallback, useMemo, useState } from 'react';
import { formatTime } from '@/lib/format';
import { screenshotImageUrl } from '@/lib/screenshots';
import { useLogFeed, type LogPage } from '@/lib/use-log-feed';
import { ScreenshotViewer } from './ScreenshotViewer';
import type { ScreenshotRow } from '@/types/api';

/**
 * Per-employee screenshot gallery: a 3-across grid, two rows deep, that pages in more captures as
 * the operator scrolls, and opens any tile in a zoomable viewer.
 *
 * WHY A BOUNDED WINDOW: screenshots are the fastest-growing record in the system - one every few
 * minutes per device, per employee. Rendering a range would mean an unbounded query, an unbounded
 * payload, and a browser holding hundreds of full JPEGs. Only what is on screen (plus the next
 * page) is ever fetched, and each image is requested individually so the backend can audit-log who
 * looked at what (spec section 3).
 */

/** The grid the brief asks for: three across, two rows visible before scrolling. */
const GRID_COLUMNS = 3;
const VISIBLE_ROWS = 2;

/**
 * Tiles are a fixed height rather than an aspect ratio, so the scroll window can be exactly two
 * rows tall - an aspect-ratio grid's row height depends on the card's width, which is not known
 * here, and the window would show two-and-a-bit rows at some widths and one at others.
 */
const TILE_HEIGHT_REM = 9;
const GRID_GAP_REM = 0.75;

/** Height of the scroll window: the visible rows plus the gaps between them. */
const WINDOW_HEIGHT_REM = VISIBLE_ROWS * TILE_HEIGHT_REM + (VISIBLE_ROWS - 1) * GRID_GAP_REM;

interface ScreenshotGalleryProps {
  /** First page, fetched on the server so the grid is filled before any JavaScript runs. */
  initial: LogPage<ScreenshotRow>;
  employeeId: string;
  startDate?: string;
  endDate?: string;
}

/** Module scope so the identity is stable, which keeps the feed's loadMore stable with it. */
const captureKey = (capture: ScreenshotRow) => capture.id;

export function ScreenshotGallery({ initial, employeeId, startDate, endDate }: ScreenshotGalleryProps) {
  // Memoized for the same reason: an inline object would be a new query on every render, and the
  // viewer's "load the next page as you approach the end" effect depends on loadMore holding
  // still between actual loads.
  const params = useMemo(
    () => ({ employeeId, startDate, endDate }),
    [employeeId, startDate, endDate]
  );

  const { rows, hasMore, loading, error, loadMore, sentinelRef } = useLogFeed<ScreenshotRow>({
    initial,
    feed: 'screenshots',
    params,
    rowKey: captureKey,
    noun: 'screenshots',
  });

  const loadNextPage = useCallback(() => void loadMore(), [loadMore]);

  // The capture's id, not its position. This feed is live - a capture taken while the viewer is
  // open is prepended to the list and shifts every index below it by one. Holding an index meant
  // the viewer silently swapped to the neighbouring image (and reset its zoom) as that happened.
  // An id pins it to the picture the operator actually opened; the position is derived.
  const [openId, setOpenId] = useState<string | null>(null);
  const openIndex = openId === null ? -1 : rows.findIndex((capture) => capture.id === openId);

  return (
    <>
      <div
        className="overflow-y-auto"
        style={{ height: `${WINDOW_HEIGHT_REM}rem` }}
        // A scrollable region of its own, so it must be reachable and announced to anyone not
        // using a mouse.
        tabIndex={0}
        role="region"
        aria-label="Screenshots"
        aria-busy={loading}
      >
        {rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-text-secondary">
            No screenshots for this period. Captures are optional and off by default - check the
            screenshot setting on the Settings screen if you expected some.
          </p>
        ) : (
          <ul
            className="grid"
            style={{
              gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`,
              gridAutoRows: `${TILE_HEIGHT_REM}rem`,
              gap: `${GRID_GAP_REM}rem`,
            }}
          >
            {rows.map((capture) => (
              <li key={capture.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(capture.id)}
                  className="group flex size-full flex-col overflow-hidden rounded-md border border-glass-border bg-surface-strong text-left transition-[transform,box-shadow,border-color] duration-150 hover:-translate-y-0.5 hover:border-brand hover:shadow-glass-sm"
                  aria-label={`Open screenshot from ${formatTime(capture.capturedAt)}${
                    capture.deviceName ? ` on ${capture.deviceName}` : ''
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- the proxy streams an
                      already-stored JPEG behind a session cookie; next/image would only add an
                      optimizer pass over bytes it cannot cache anyway. */}
                  <img
                    src={screenshotImageUrl(capture)}
                    alt=""
                    // Below the fold of a two-row window there may be dozens of tiles; without
                    // this, opening the section downloads every capture already paged in.
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    className="min-h-0 w-full flex-1 bg-surface object-cover"
                  />
                  <span className="flex items-baseline justify-between gap-2 px-2.5 py-2">
                    <span className="tnum text-[11.5px] font-medium text-text-primary">
                      {formatTime(capture.capturedAt)}
                    </span>
                    {capture.deviceName && (
                      <span className="min-w-0 truncate text-[11px] text-text-tertiary">
                        {capture.deviceName}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div ref={sentinelRef} aria-hidden />

        {loading && <p className="py-3 text-center text-xs text-text-tertiary">Loading more...</p>}

        {error && (
          <p className="py-3 text-center text-xs text-danger">
            {error}{' '}
            <button type="button" onClick={() => void loadMore()} className="font-medium underline">
              Retry
            </button>
          </p>
        )}

        {!hasMore && rows.length > 0 && (
          <p className="py-3 text-center text-xs text-text-tertiary">End of screenshots.</p>
        )}
      </div>

      {/* A negative index means the open capture is no longer in the list - it fell out of a
          reset page, or retention removed it. Closing is the honest response; there is nothing
          left to show. */}
      {openIndex >= 0 && (
        <ScreenshotViewer
          screenshots={rows}
          index={openIndex}
          onIndexChange={(next) => setOpenId(rows[next]?.id ?? null)}
          onClose={() => setOpenId(null)}
          hasMore={hasMore}
          onLoadMore={loadNextPage}
        />
      )}
    </>
  );
}
