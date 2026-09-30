/**
 * The organization's time zone, for display and for "today".
 *
 * Timestamps arrive from the API as UTC instants and are never converted for storage. This zone
 * only decides which clock time and calendar date a person reads, so the dashboard shows the same
 * times wherever the viewer's laptop happens to be, and server-rendered pages match client-rendered
 * ones. It must equal the backend's APP_TIME_ZONE; deploy/.env sets both from one value.
 *
 * `NEXT_PUBLIC_*` values are inlined into the browser bundle at build time, so changing the zone
 * requires rebuilding the dashboard image.
 */

export const DEFAULT_TIME_ZONE = "UTC";

function resolveTimeZone(configured: string | undefined): string {
  const zone = configured?.trim();
  if (!zone) return DEFAULT_TIME_ZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    // A typo must not take the dashboard down. Fall back and say so once in the server log.
    console.error(
      `NEXT_PUBLIC_APP_TIME_ZONE "${zone}" is not a valid IANA time zone; using ${DEFAULT_TIME_ZONE}`,
    );
    return DEFAULT_TIME_ZONE;
  }
}

export const APP_TIME_ZONE = resolveTimeZone(process.env.NEXT_PUBLIC_APP_TIME_ZONE);

/** `en-CA` renders a date as yyyy-mm-dd, which is exactly the key the range pickers send. */
const dateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `yyyy-MM-dd` of the organization-local calendar day an instant falls on. */
export function localDateKey(date: Date): string {
  return dateKeyFormatter.format(date);
}
