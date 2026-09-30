import { APP_TIME_ZONE, localDateKey } from "@/lib/timezone";

/**
 * Shared formatting. Kept in one place so a duration reads identically on every screen.
 *
 * Every clock time and calendar date of an instant is rendered in the organization's zone
 * (APP_TIME_ZONE), never the server's or the viewer's. A `workDate` is different: it is already a
 * calendar date, stored as midnight UTC, so `formatDate` reads it as UTC and must not be shifted.
 */

/** Seconds as "6h 12m", "12m", or "45s". Zero renders as an em dash, not "0s". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "-";
  if (seconds <= 0) return "0m";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(seconds)}s`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

export function formatTime(value: string | Date | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: APP_TIME_ZONE,
  });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: APP_TIME_ZONE,
  });
}

/**
 * '19 Sep 2026' for an instant, read in the organization's zone. For a report period bound, which
 * is an instant, not a bare date. A `workDate` column value goes through `formatDate` instead.
 */
export function formatLocalDate(value: string | Date | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  // Assembled from parts so the order is always "19 Sep 2026", matching formatDate below.
  // A single locale's own ordering would differ ("Sep 19, 2026" in en-US, "19 Sept 2026" in en-GB).
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: APP_TIME_ZONE,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.day} ${parts.month} ${parts.year}`;
}

/** Formats a stored calendar date (midnight UTC) as '19 Sep 2026' */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const day = date.getUTCDate();
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const month = monthNames[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

/** "3 minutes ago" for liveness columns, where the exact timestamp matters less than recency. */
export function formatRelative(value: string | Date | null | undefined): string {
  if (!value) return "never";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "never";

  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function formatBytes(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "-";

  // Capacities arrive as decimal strings because they exceed JSON's safe integer range.
  const bytes = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / Math.pow(1024, exponent);

  return `${size >= 10 || exponent === 0 ? Math.round(size) : size.toFixed(1)} ${units[exponent]}`;
}

/**
 * ISO date (yyyy-mm-dd) for the range pickers: the organization-local day the instant falls on.
 * Reading it in UTC would make "today" still be yesterday for the first hours of every local day.
 */
export function isoDate(date: Date): string {
  return localDateKey(date);
}
