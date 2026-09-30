import { env } from "../config/env";

/**
 * Organization-local calendar and clock helpers.
 *
 * Every timestamp is stored and sent as UTC. The organization's zone (APP_TIME_ZONE, for example
 * Asia/Dhaka) only decides where a calendar day begins, which clock time a report prints, and what
 * "today" and "late night" mean. Nothing here depends on the server process's own TZ, so a
 * container running in UTC behaves identically to a workstation running in the organization's zone.
 *
 * Every function takes the zone as a trailing argument, defaulting to APP_TIME_ZONE, so the
 * behavior can be tested for a zone other than the one the process was configured with.
 */

const MS_PER_SECOND = 1_000;
const DATE_KEY_LENGTH = "YYYY-MM-DD".length;
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Passes over the offset computation: the second corrects a guess that straddled a DST change. */
const OFFSET_SETTLE_PASSES = 2;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * One formatter per zone, created on first use. The set of zones is tiny and fixed by
 * configuration, so the cache is bounded; building a formatter per call would be the slow part.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      // h23, not hour12:false: the latter renders midnight as "24" in some engines.
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

function zonedParts(date: Date, zone: string): ZonedParts {
  const values: Record<string, number> = {};
  for (const part of partsFormatter(zone).formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** The zone's offset from UTC at an instant, in milliseconds (positive east of Greenwich). */
function offsetMs(instantMs: number, zone: string): number {
  const parts = zonedParts(new Date(instantMs), zone);
  const wallClockAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Whole seconds only: the formatter drops milliseconds, so compare against the same truncation.
  return wallClockAsUtc - Math.floor(instantMs / MS_PER_SECOND) * MS_PER_SECOND;
}

/** `yyyy-MM-dd` of the organization-local calendar day an instant falls on. */
export function localDateKey(date: Date, zone: string = env.APP_TIME_ZONE): string {
  const { year, month, day } = zonedParts(date, zone);
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

/** Organization-local hour of day, 0-23. */
export function localHour(date: Date, zone: string = env.APP_TIME_ZONE): number {
  return zonedParts(date, zone).hour;
}

/** Organization-local wall clock as `HH:mm`, the form Policy.reportSummaryScheduleTimeLocal uses. */
export function localClock(date: Date, zone: string = env.APP_TIME_ZONE): string {
  const { hour, minute } = zonedParts(date, zone);
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** Organization-local wall clock as `HH:mm:ss`, for printed reports. */
export function localClockSeconds(date: Date, zone: string = env.APP_TIME_ZONE): string {
  const { hour, minute, second } = zonedParts(date, zone);
  return `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
}

/** `yyyy-MM-dd HH:mm:ss Zone/Name`: an unambiguous local timestamp for printed reports. */
export function localTimestamp(date: Date, zone: string = env.APP_TIME_ZONE): string {
  return `${localDateKey(date, zone)} ${localClockSeconds(date, zone)} ${zone}`;
}

/**
 * The instant a local calendar day begins, for a `yyyy-MM-dd` key.
 * Dhaka has no daylight saving; the second pass keeps this correct for zones that do.
 */
export function zonedMidnight(dateKey: string, zone: string = env.APP_TIME_ZONE): Date {
  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (!match) throw new Error(`Expected a yyyy-MM-dd date, received "${dateKey}"`);

  const wallClockAsUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let instant = wallClockAsUtc;
  for (let pass = 0; pass < OFFSET_SETTLE_PASSES; pass += 1) {
    instant = wallClockAsUtc - offsetMs(instant, zone);
  }
  return new Date(instant);
}

/** `yyyy-MM-dd` key shifted by whole calendar days. */
export function addDaysToKey(dateKey: string, days: number): string {
  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (!match) throw new Error(`Expected a yyyy-MM-dd date, received "${dateKey}"`);
  const shifted = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days),
  );
  return shifted.toISOString().slice(0, DATE_KEY_LENGTH);
}

/**
 * The value a `@db.Date` column holds for the local day an instant falls on: midnight UTC of the
 * local calendar date. Use it to query `workDate`, which is the agent's own local date.
 */
export function workDateOf(date: Date, zone: string = env.APP_TIME_ZONE): Date {
  return new Date(`${localDateKey(date, zone)}T00:00:00.000Z`);
}

/** Last representable instant of the local day that begins at `dateKey`. */
export function zonedEndOfDay(dateKey: string, zone: string = env.APP_TIME_ZONE): Date {
  return new Date(zonedMidnight(addDaysToKey(dateKey, 1), zone).getTime() - 1);
}

/**
 * `yyyy-MM-dd` of a `@db.Date` value. Prisma returns those as midnight UTC, so the UTC date is
 * the stored date. Do not use this on a real timestamp; use {@link localDateKey}.
 */
export function dateColumnKey(value: Date): string {
  return value.toISOString().slice(0, DATE_KEY_LENGTH);
}
