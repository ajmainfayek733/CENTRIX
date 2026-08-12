import { prisma } from '../../config/db';

/**
 * Keyset ("cursor") pagination for the dashboard's log tables.
 *
 * OFFSET pagination is what this deliberately is not. `OFFSET 5000` makes Postgres walk and
 * discard five thousand rows to return fifty, so the cost of a page grows with how far the
 * operator has scrolled - exactly backwards for a log where the interesting rows are at the end.
 * It is also unstable: rows arriving while someone reads shift the window, so page 2 repeats or
 * skips entries.
 *
 * A keyset cursor carries the sort key of the last row instead, and the next page is "everything
 * strictly after this key". Every page costs the same indexed seek, and a live feed cannot
 * duplicate or drop rows underneath the reader.
 *
 * The sort key is (timestamp, id) rather than the timestamp alone. Timestamps collide - an agent
 * can close several app sessions in the same millisecond - and a cursor on a non-unique key
 * either loses the tied rows or repeats them forever.
 */

/** Separator between the two halves of a cursor. Not valid in an ISO timestamp or a uuid. */
const CURSOR_SEPARATOR = '|';

export interface Cursor {
  timestamp: Date;
  id: string;
}

export function encodeCursor(timestamp: Date, id: string): string {
  return `${timestamp.toISOString()}${CURSOR_SEPARATOR}${id}`;
}

/**
 * Parses a cursor supplied by the client.
 *
 * Returns null for anything malformed rather than throwing: a bad cursor should serve the first
 * page, not a 500. Cursors are opaque to the UI, so the only way to get an invalid one is a
 * truncated URL or a stale bookmark.
 */
export function decodeCursor(raw?: string | null): Cursor | null {
  if (!raw) return null;

  const separatorAt = raw.indexOf(CURSOR_SEPARATOR);
  if (separatorAt <= 0) return null;

  const timestamp = new Date(raw.slice(0, separatorAt));
  const id = raw.slice(separatorAt + 1);

  if (Number.isNaN(timestamp.getTime()) || id.length === 0) return null;
  return { timestamp, id };
}

/**
 * The "strictly older than this cursor" predicate, for a feed sorted newest-first.
 *
 * Expressed as an OR because Prisma has no row-value comparison. Postgres still uses the
 * (timestamp) index for the first branch, and the second only ever matches within one timestamp.
 */
export function olderThan(field: string, cursor: Cursor | null): Record<string, unknown> {
  if (!cursor) return {};

  return {
    OR: [
      { [field]: { lt: cursor.timestamp } },
      { [field]: cursor.timestamp, id: { lt: cursor.id } },
    ],
  };
}

/** Newest-first ordering that matches `olderThan`. The two must always be changed together. */
export function newestFirst(field: string): Array<Record<string, 'desc'>> {
  return [{ [field]: 'desc' }, { id: 'desc' }];
}

export interface Page<T> {
  rows: T[];
  /** Cursor to pass back for the following page, or null when the feed is exhausted. */
  nextCursor: string | null;
  /** Whether another page exists, so the UI knows to keep its scroll sentinel armed. */
  hasMore: boolean;
}

/**
 * Turns an over-fetched result into a page.
 *
 * Callers ask for `limit + 1` rows. The extra row is never returned - its only job is to answer
 * "is there more?" without a second COUNT query over the same predicate, which on a log table is
 * as expensive as the page itself.
 */
export function toPage<T extends { id: string }>(
  rows: T[],
  limit: number,
  timestampOf: (row: T) => Date
): Page<T> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    rows: page,
    nextCursor: hasMore && last ? encodeCursor(timestampOf(last), last.id) : null,
    hasMore,
  };
}

/**
 * Page size for the dashboard's log tables.
 *
 * Read from policy so an admin can change it from the settings screen without a redeploy, and
 * clamped so a bad value cannot turn one scroll into an unbounded read. The caller may request
 * fewer, never more.
 */
const PAGE_SIZE_HARD_CEILING = 500;

export async function resolvePageSize(organizationId: string, requested?: number): Promise<number> {
  const policy = await prisma.policy.findUnique({
    where: { organizationId },
    select: { logPageSize: true },
  });

  return clampPageSize(policy?.logPageSize ?? PAGE_SIZE_DEFAULT, requested, PAGE_SIZE_HARD_CEILING);
}

/**
 * Page size for the screenshot gallery - its own setting, not logPageSize.
 *
 * A page of log rows is a few kilobytes of JSON; a page of screenshots is that many full-size
 * JPEGs the browser actually downloads and decodes. At roughly half a megabyte a capture, serving
 * them 50 at a time is tens of megabytes of image traffic for one flick of the scroll wheel, on a
 * screen that shows six at once. The ceiling is correspondingly lower: an admin who wants more per
 * page is asking for more bytes in flight, not just more rows.
 */
const SCREENSHOT_PAGE_SIZE_HARD_CEILING = 60;

export async function resolveScreenshotPageSize(
  organizationId: string,
  requested?: number
): Promise<number> {
  const policy = await prisma.policy.findUnique({
    where: { organizationId },
    select: { screenshotPageSize: true },
  });

  return clampPageSize(
    policy?.screenshotPageSize ?? SCREENSHOT_PAGE_SIZE_DEFAULT,
    requested,
    SCREENSHOT_PAGE_SIZE_HARD_CEILING
  );
}

/** A caller may ask for fewer rows than policy allows, never more, and never fewer than one. */
function clampPageSize(configured: number, requested: number | undefined, ceiling: number): number {
  const wanted = requested && requested > 0 ? Math.min(requested, configured) : configured;
  return Math.max(1, Math.min(wanted, ceiling));
}

/**
 * Fallbacks when an organization has no policy row yet. These match the schema defaults so the two
 * cannot drift into disagreeing about what "a page" means.
 */
export const PAGE_SIZE_DEFAULT = 50;
export const SCREENSHOT_PAGE_SIZE_DEFAULT = 12;
