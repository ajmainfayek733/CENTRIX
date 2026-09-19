import { formatDuration, formatTime } from "@/lib/format";
import { Badge, EmptyState } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { AttendanceDay } from "@/types/api";

/**
 * Weekly attendance for one employee, folded from the same `attendanceDays` rows the attendance
 * table further down renders. No second request: the daily rollup already carries everything a
 * week view needs, and asking the API again for a regrouping of data this page is holding would
 * put a round trip on the critical path to say nothing new.
 *
 * The table answers "what happened on the 14th". This answers the question a manager opens the
 * screen with - "is this person's week normal" - which is a shape question, and shapes are read
 * across a row of days rather than down a column of timestamps.
 *
 * Every date here is handled in UTC. `workDate` is a `@db.Date` the backend keys as UTC midnight
 * (reportService.workDateKey), so bucketing it through a local-timezone Date would shift a day
 * across the week boundary for anyone west of Greenwich - and the Sunday/Monday edge is the one
 * place that error is guaranteed to show.
 */

const DAYS_PER_WEEK = 7;
/** ISO-8601: weeks start on Monday. `Date#getUTCDay` calls Sunday 0, hence the shift below. */
const ISO_WEEK_START_DAY = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Newest week first, capped so a year-long range does not render fifty-two strips. */
const MAX_WEEKS = 12;
/** Floor for a day with any recorded activity, so a short day is still a visible mark. */
const MIN_BAR_PERCENT = 6;
const FULL_BAR_PERCENT = 100;

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

type DayState = "present" | "ended" | "unknown" | "absent" | "outside";

interface DayCell {
  key: string;
  dayOfMonth: number;
  state: DayState;
  day: AttendanceDay | null;
}

interface WeekRow {
  startKey: string;
  endKey: string;
  days: DayCell[];
  attendedDays: number;
  activeSeconds: number;
}

/** `yyyy-MM-dd` for an instant, in UTC - the same key the backend builds `workDate` from. */
function toDayKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Parses a `yyyy-MM-dd` key as UTC midnight. `new Date(key)` happens to do this too; being
 * explicit keeps the pairing with `toDayKey` legible and survives a key that grows a time part.
 */
function fromDayKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * MS_PER_DAY);
}

/** The Monday of the week containing `value`, in UTC. */
function startOfIsoWeek(value: Date): Date {
  const offset = (value.getUTCDay() - ISO_WEEK_START_DAY + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  return addDays(value, -offset);
}

function formatDayLabel(key: string): string {
  return fromDayKey(key).toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
}

const STATE_STYLE: Record<DayState, { cell: string; bar: string }> = {
  present: { cell: "border-success/35 bg-success/10", bar: "bg-success" },
  ended: { cell: "border-border bg-surface-muted", bar: "bg-brand" },
  unknown: { cell: "border-warning/35 bg-warning/10", bar: "bg-warning" },
  absent: { cell: "border-dashed border-border bg-transparent", bar: "bg-transparent" },
  outside: { cell: "border-transparent bg-transparent", bar: "bg-transparent" },
};

const STATE_TITLE: Record<DayState, string> = {
  present: "Signed in now",
  ended: "Attended",
  unknown: "Open session on a device that stopped reporting",
  absent: "No sign-in recorded",
  outside: "Outside the selected period",
};

/**
 * Buckets the daily rows into ISO weeks spanning the selected period.
 *
 * A day with no row is not the same as a day the period never covered, and neither is the same as
 * a day that has not happened yet - reporting a future Friday as an absence would be an accusation
 * the data does not make. `outside` covers both edges: days the range excludes, and days after
 * today.
 */
function buildWeeks(days: AttendanceDay[], periodStart: string, periodEnd: string): WeekRow[] {
  const byDate = new Map(days.map((day) => [day.workDate, day]));

  const firstKey = toDayKey(new Date(periodStart));
  const lastKey = toDayKey(new Date(periodEnd));
  const todayKey = toDayKey(new Date());

  const singleDay = firstKey === lastKey;
  const effectiveStartKey = singleDay ? toDayKey(startOfIsoWeek(fromDayKey(firstKey))) : firstKey;
  const effectiveEndKey = singleDay ? toDayKey(addDays(fromDayKey(effectiveStartKey), 6)) : lastKey;

  // The default range ends at "now" and a picked one can end later still; either way, days nobody
  // has worked yet must not be manufactured into absences.
  const visibleEndKey = effectiveEndKey > todayKey ? todayKey : effectiveEndKey;
  const rangeStartWeek = startOfIsoWeek(fromDayKey(effectiveStartKey));
  const rangeEndWeek = startOfIsoWeek(fromDayKey(visibleEndKey));

  if (rangeEndWeek < rangeStartWeek && visibleEndKey < effectiveStartKey) return [];

  const weeks: WeekRow[] = [];

  for (
    let weekStart = rangeEndWeek;
    weekStart >= rangeStartWeek && weeks.length < MAX_WEEKS;
    weekStart = addDays(weekStart, -DAYS_PER_WEEK)
  ) {
    const cells: DayCell[] = [];
    let attendedDays = 0;
    let activeSeconds = 0;

    for (let offset = 0; offset < DAYS_PER_WEEK; offset += 1) {
      const date = addDays(weekStart, offset);
      const key = toDayKey(date);
      const day = byDate.get(key) ?? null;
      const isFuture = key > todayKey;
      const withinRequestedPeriod = key >= effectiveStartKey && key <= visibleEndKey;
      const state: DayState = isFuture
        ? "outside"
        : day
          ? day.status
          : withinRequestedPeriod
            ? "absent"
            : "outside";

      if (day) {
        attendedDays += 1;
        activeSeconds += day.activeSeconds;
      }

      cells.push({ key, dayOfMonth: date.getUTCDate(), state, day });
    }

    weeks.push({
      startKey: toDayKey(weekStart),
      endKey: toDayKey(addDays(weekStart, DAYS_PER_WEEK - 1)),
      days: cells,
      attendedDays,
      activeSeconds,
    });
  }

  return weeks;
}

export function WeeklyAttendance({
  attendanceDays,
  periodStart,
  periodEnd,
}: {
  attendanceDays: AttendanceDay[];
  periodStart: string;
  periodEnd: string;
}) {
  const weeks = buildWeeks(attendanceDays, periodStart, periodEnd);

  if (weeks.length === 0) {
    return <EmptyState message="No sign-in recorded in this period." />;
  }

  /*
    Bars are scaled against the longest day on screen rather than a fixed working day. A team on
    six-hour shifts would otherwise read as permanently half-empty against an eight-hour constant
    that appears nowhere in the data.
  */
  const peakActiveSeconds = weeks.reduce(
    (peak, week) =>
      week.days.reduce((max, cell) => Math.max(max, cell.day?.activeSeconds ?? 0), peak),
    0,
  );

  return (
    <div className="space-y-3.5">
      {weeks.map((week) => (
        <section key={week.startKey}>
          <header className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 className="text-[13.5px] font-medium text-text-primary">
              {formatDayLabel(week.startKey)} - {formatDayLabel(week.endKey)}
            </h3>
            <p className="tnum text-[12.5px] text-text-secondary">
              {week.attendedDays} of {DAYS_PER_WEEK} days - {formatDuration(week.activeSeconds)}{" "}
              active
            </p>
          </header>

          <ol className="grid grid-cols-7 gap-1.5">
            {week.days.map((cell, index) => {
              const style = STATE_STYLE[cell.state];
              const fillPercent =
                cell.day && peakActiveSeconds > 0
                  ? Math.max(
                      MIN_BAR_PERCENT,
                      Math.round((cell.day.activeSeconds / peakActiveSeconds) * FULL_BAR_PERCENT),
                    )
                  : 0;

              return (
                <li
                  key={cell.key}
                  title={`${formatDayLabel(cell.key)} - ${STATE_TITLE[cell.state]}${
                    cell.day
                      ? ` | Active: ${formatDuration(cell.day.activeSeconds)} | In: ${formatTime(cell.day.firstLogin)}${
                          cell.day.lastLogout ? ` - Out: ${formatTime(cell.day.lastLogout)}` : ""
                        }`
                      : ""
                  }`}
                  className={cn(
                    "flex min-w-0 flex-col items-center gap-1.5 rounded-md border p-2 text-center transition-colors",
                    style.cell,
                  )}
                >
                  <span className="text-[10.5px] font-medium uppercase tracking-[0.4px] text-text-secondary">
                    {WEEKDAY_LABELS[index]}
                  </span>
                  <span
                    className={cn(
                      "tnum text-[13px] font-semibold",
                      cell.state === "outside" ? "text-text-secondary/45" : "text-text-primary",
                    )}
                  >
                    {cell.dayOfMonth}
                  </span>

                  {/* Decoration over the duration underneath it, never the only signal. */}
                  <span className="h-1 w-full overflow-hidden rounded-full bg-border/60" aria-hidden>
                    <span
                      className={cn("block h-full rounded-full", style.bar)}
                      style={{ width: `${fillPercent}%` }}
                    />
                  </span>

                  <span className="tnum w-full truncate text-[11.5px] text-text-secondary">
                    {cell.day
                      ? formatDuration(cell.day.activeSeconds)
                      : cell.state === "absent"
                        ? "Absent"
                        : "-"}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      ))}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Badge tone="success">Signed in</Badge>
        <Badge tone="brand">Attended</Badge>
        <Badge tone="warning">No logout recorded</Badge>
        <Badge>Absent</Badge>
        {weeks.length === MAX_WEEKS && (
          <span className="text-[12px] text-text-secondary">
            Most recent {MAX_WEEKS} weeks of the selected period.
          </span>
        )}
      </div>
    </div>
  );
}
