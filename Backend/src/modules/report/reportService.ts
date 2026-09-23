import { ActivityType, LogoutSource, ProductivityTag } from "@prisma/client";
import { prisma } from "../../config/db";
import { currentOrganizationId } from "../../config/tenant";
import {
  decodeCursor,
  newestFirst,
  olderThan,
  resolvePageSize,
  resolveScreenshotPageSize,
  toPage,
} from "./pagination";

/**
 * Dashboard read path (spec section 5).
 *
 * TWO KINDS OF QUERY, AND THEY MUST NOT BE CONFUSED:
 *
 *   Aggregates (overview, roster, employee totals) read daily_activity_rollups - one row per
 *   employee per day, maintained at ingest time. They never touch the log tables. This is the
 *   change that lets the system go from 30 devices to 100+: summing a month of ten-second app
 *   switches on every dashboard load is millions of rows re-scanned per viewer, and it degrades
 *   with history rather than with headcount, so it gets worse forever.
 *
 *   Logs (timeline, alerts, USB) read the raw tables, but only ever one bounded page at a time
 *   through a keyset cursor. No endpoint here returns "everything in the range".
 */

/**
 * A device seen within this window counts as "online now" on the overview screen.
 *
 * Derived from `devices.lastSeen`, which only an authenticated HTTP request updates - never from
 * Socket.IO presence. A socket can stay open through a total backend failure and can be closed
 * while an agent syncs happily over HTTP, so it answers a different question entirely.
 */
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

function dominantProductivityTag(seconds: {
  productiveSeconds: number | null;
  unproductiveSeconds: number | null;
  neutralSeconds: number | null;
  blacklistedSeconds: number | null;
}) {
  const values = [
    ["Productive", seconds.productiveSeconds ?? 0],
    ["Unproductive", seconds.unproductiveSeconds ?? 0],
    ["Blacklisted", seconds.blacklistedSeconds ?? 0],
    ["Neutral", seconds.neutralSeconds ?? 0],
  ] as const;
  return values.reduce((best, current) => (current[1] > best[1] ? current : best))[0] as
    | "Productive"
    | "Unproductive"
    | "Blacklisted"
    | "Neutral";
}

interface BrowserDomainTotals {
  domain: string;
  durationSeconds: number;
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
  blacklistedSeconds: number;
}

interface ApplicationTotals {
  appName: string | null;
  durationSeconds: number;
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
  blacklistedSeconds: number;
}

function emptyBrowserDomain(domain: string): BrowserDomainTotals {
  return {
    domain,
    durationSeconds: 0,
    productiveSeconds: 0,
    unproductiveSeconds: 0,
    neutralSeconds: 0,
    blacklistedSeconds: 0,
  };
}

function addBrowserDomain(
  totals: Map<string, BrowserDomainTotals>,
  domain: string,
  tag: ProductivityTag,
  seconds: number,
) {
  const row = totals.get(domain) ?? emptyBrowserDomain(domain);
  row.durationSeconds += seconds;
  switch (tag) {
    case ProductivityTag.Productive:
      row.productiveSeconds += seconds;
      break;
    case ProductivityTag.Unproductive:
      row.unproductiveSeconds += seconds;
      break;
    case ProductivityTag.Blacklisted:
      row.blacklistedSeconds += seconds;
      break;
    default:
      row.neutralSeconds += seconds;
  }
  totals.set(domain, row);
}

function emptyApplication(appName: string | null): ApplicationTotals {
  return {
    appName,
    durationSeconds: 0,
    productiveSeconds: 0,
    unproductiveSeconds: 0,
    neutralSeconds: 0,
    blacklistedSeconds: 0,
  };
}

function addApplication(
  totals: Map<string, ApplicationTotals>,
  appName: string | null,
  tag: ProductivityTag,
  seconds: number,
) {
  const key = appName ?? "__unknown_application__";
  const row = totals.get(key) ?? emptyApplication(appName);
  row.durationSeconds += seconds;
  switch (tag) {
    case ProductivityTag.Productive:
      row.productiveSeconds += seconds;
      break;
    case ProductivityTag.Unproductive:
      row.unproductiveSeconds += seconds;
      break;
    case ProductivityTag.Blacklisted:
      row.blacklistedSeconds += seconds;
      break;
    default:
      row.neutralSeconds += seconds;
  }
  totals.set(key, row);
}

const BROWSER_IDENTIFIERS = [
  "chrome",
  "msedge",
  "edge",
  "firefox",
  "brave",
  "opera",
  "vivaldi",
  "arc",
  "safari",
  "internet explorer",
  "iexplore",
];

export function isBrowserApplication(appName: string | null | undefined): boolean {
  if (!appName) return false;
  const normalized = appName.toLowerCase();
  return BROWSER_IDENTIFIERS.some((b) => normalized.includes(b));
}

/** How many apps/domains the "top" lists show. Not a page - a fixed leaderboard. */
const TOP_LIST_SIZE = 15;

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** A bare calendar date, as every date input and preset on the dashboard sends. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Last representable instant of a day, so a date-only bound includes the day it names. */
const END_OF_DAY_MS = 24 * 60 * 60 * 1000 - 1;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolves the `?startDate=&endDate=` pair every report screen sends into an instant range.
 * Defaults to today when bounds are not provided.
 *
 * **A date-only `endDate` is inclusive of the day it names.** `new Date('2026-08-15')` is midnight
 * *at the start* of the 15th, so taking it literally makes `startDate=endDate=2026-08-15` a
 * zero-width window - which is exactly what the "Today" preset sends. Totals still rendered,
 * because those read the rollup through `startOfUtcDay` on both bounds, but everything filtering
 * raw timestamps - attendance, sessions, timeline - came back empty on a day full of activity.
 *
 * The snap is guarded on the date-only form rather than applied to every `endDate`, so a caller
 * that passes a full timestamp gets the instant it asked for instead of being silently widened by
 * up to a day. `startDate` needs no equivalent: midnight at the start of a day is already the
 * inclusive lower bound.
 *
 * Exported only so the smoke suite can assert this directly. It is pure, and the bug it encodes
 * empties three tables on a screen that still renders its totals - which is precisely the kind
 * that comes back unnoticed.
 */
export function resolveRange(startDate?: string, endDate?: string) {
  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate ? new Date(startDate) : startOfUtcDay(end);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw { statusCode: 400, message: "startDate/endDate must be valid ISO dates" };
  }

  if (endDate !== undefined && DATE_ONLY.test(endDate)) {
    return {
      start: startDate && DATE_ONLY.test(startDate) ? startOfUtcDay(start) : start,
      end: new Date(end.getTime() + END_OF_DAY_MS),
    };
  }

  return { start: startDate && DATE_ONLY.test(startDate) ? startOfUtcDay(start) : start, end };
}

interface Totals {
  activeSeconds: number;
  idleSeconds: number;
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
  blacklistedSeconds: number;
}

const emptyTotals = (): Totals => ({
  activeSeconds: 0,
  idleSeconds: 0,
  productiveSeconds: 0,
  unproductiveSeconds: 0,
  neutralSeconds: 0,
  blacklistedSeconds: 0,
});

/** Productive share of active time, 0-100. Idle time is excluded from the denominator. */
function productivityPercent(t: Totals): number {
  if (t.activeSeconds <= 0) return 0;
  return Math.round((t.productiveSeconds / t.activeSeconds) * 1000) / 10;
}

function reportDays(start: Date, end: Date): number {
  const firstDay = startOfUtcDay(start).getTime();
  const lastDay = startOfUtcDay(end).getTime();
  return Math.max(1, Math.floor((lastDay - firstDay) / DAY_MS) + 1);
}

/** The later of two instants, either of which may be missing. */
function latest(left: Date | null, right: Date | null): Date | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

/** `yyyy-MM-dd` key for a `@db.Date` column, which Prisma hands back as UTC midnight. */
function workDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Whether an attendance session that is still open belongs to a workstation still reporting.
 *
 * An open row means "the agent had not observed a logout when it last wrote". That is only the
 * same thing as "the employee is at their desk" while the device is still checking in - a machine
 * that lost power mid-session leaves the row open too, and the agent stamps a `Recovered` logout on
 * it at its next start. Without this test the dashboard would show yesterday's crash as somebody
 * still working.
 */
function isLive(lastSeen: Date | null | undefined, now: number): boolean {
  return lastSeen != null && now - lastSeen.getTime() <= ONLINE_WINDOW_MS;
}

/** One row per work date: when the employee arrived, when they left, and what the day held. */
interface AttendanceDay {
  workDate: string;
  firstLogin: Date;
  lastLogout: Date | null;
  /** First login to last logout - or to now while the day is still running. */
  sessionSeconds: number;
  activeSeconds: number;
  idleSeconds: number;
  /** How many stretches of presence made up the day (a lock or a suspend ends one). */
  sessionCount: number;
  status: "present" | "ended" | "unknown";
  /**
   * True when `lastLogout` was inferred by the server rather than observed by the workstation -
   * the session the day ends on was abandoned, and the reaper closed it from the last evidence
   * available. The figure is the best one there is, and it is approximate; a screen that feeds
   * payroll has to be able to say so rather than presenting it as a recorded time.
   */
  logoutEstimated: boolean;
}

export class ReportService {
  private async getApplicationGroups(
    employeeId: string,
    deviceIds: string[],
    start: Date,
    end: Date,
  ): Promise<ApplicationTotals[]> {
    const today = startOfUtcDay(new Date());
    const startDay = startOfUtcDay(start);
    const endDay = startOfUtcDay(end);
    const singleDay = startDay.getTime() === endDay.getTime();
    const totals = new Map<string, ApplicationTotals>();
    const summaryEnd = new Date(Math.min(endDay.getTime(), today.getTime() - DAY_MS));
    const hasSummaryRange = !singleDay && startDay <= summaryEnd;

    const summaryDates = new Set<string>();
    const summaryGroups = hasSummaryRange
      ? await prisma.activitySessionDailySummary.groupBy({
          by: ["workDate", "appName"],
          where: { employeeId, workDate: { gte: startDay, lte: summaryEnd } },
          _sum: {
            durationSeconds: true,
            productiveSeconds: true,
            unproductiveSeconds: true,
            neutralSeconds: true,
            blacklistedSeconds: true,
          },
        })
      : [];

    for (const group of summaryGroups) {
      summaryDates.add(workDateKey(group.workDate));
      const appName = group.appName === "__unknown_application__" ? null : group.appName;
      const row = totals.get(group.appName) ?? emptyApplication(appName);
      row.durationSeconds += group._sum.durationSeconds ?? 0;
      row.productiveSeconds += group._sum.productiveSeconds ?? 0;
      row.unproductiveSeconds += group._sum.unproductiveSeconds ?? 0;
      row.neutralSeconds += group._sum.neutralSeconds ?? 0;
      row.blacklistedSeconds += group._sum.blacklistedSeconds ?? 0;
      totals.set(group.appName, row);
    }

    const rawRows =
      start <= end && deviceIds.length > 0
        ? await prisma.activitySession.findMany({
            where: {
              deviceId: { in: deviceIds },
              type: ActivityType.Application,
              startTime: { gte: start, lte: end },
            },
            select: {
              appName: true,
              productivityTag: true,
              durationSeconds: true,
              startTime: true,
            },
          })
        : [];

    for (const row of rawRows) {
      const rowDay = workDateKey(row.startTime);
      if (summaryDates.has(rowDay)) continue;
      addApplication(totals, row.appName, row.productivityTag, row.durationSeconds);
    }

    // Inherit browser domain productivity for browser applications
    const domainGroups = await this.getBrowserDomainGroups(employeeId, deviceIds, start, end);
    let totalDomainProductive = 0;
    let totalDomainUnproductive = 0;
    let totalDomainBlacklisted = 0;
    let totalDomainNeutral = 0;

    for (const domain of domainGroups) {
      totalDomainProductive += domain.productiveSeconds;
      totalDomainUnproductive += domain.unproductiveSeconds;
      totalDomainBlacklisted += domain.blacklistedSeconds;
      totalDomainNeutral += domain.neutralSeconds;
    }

    const browserApps: ApplicationTotals[] = [];
    let totalBrowserDuration = 0;

    for (const row of totals.values()) {
      if (isBrowserApplication(row.appName)) {
        browserApps.push(row);
        totalBrowserDuration += row.durationSeconds;
      }
    }

    if (browserApps.length > 0 && totalBrowserDuration > 0) {
      for (const browserApp of browserApps) {
        const ratio = browserApp.durationSeconds / totalBrowserDuration;
        const appDomainProd = Math.round(totalDomainProductive * ratio);
        const appDomainUnprod = Math.round(totalDomainUnproductive * ratio);
        const appDomainBlack = Math.round(totalDomainBlacklisted * ratio);
        const appDomainNeut = Math.round(totalDomainNeutral * ratio);
        const appDomainSum = appDomainProd + appDomainUnprod + appDomainBlack + appDomainNeut;
        const unassigned = Math.max(0, browserApp.durationSeconds - appDomainSum);

        const baseTag = dominantProductivityTag(browserApp);
        browserApp.productiveSeconds = appDomainProd + (baseTag === "Productive" ? unassigned : 0);
        browserApp.unproductiveSeconds =
          appDomainUnprod + (baseTag === "Unproductive" ? unassigned : 0);
        browserApp.blacklistedSeconds =
          appDomainBlack + (baseTag === "Blacklisted" ? unassigned : 0);
        browserApp.neutralSeconds =
          appDomainNeut + (baseTag === "Neutral" || baseTag === "Productive" ? 0 : unassigned);
      }
    }

    return [...totals.values()]
      .sort((left, right) => right.durationSeconds - left.durationSeconds)
      .slice(0, TOP_LIST_SIZE);
  }

  private async getBrowserDomainGroups(
    employeeId: string,
    deviceIds: string[],
    start: Date,
    end: Date,
  ): Promise<BrowserDomainTotals[]> {
    const today = startOfUtcDay(new Date());
    const startDay = startOfUtcDay(start);
    const endDay = startOfUtcDay(end);
    const singleDay = startDay.getTime() === endDay.getTime();
    const totals = new Map<string, BrowserDomainTotals>();
    const summaryEnd = new Date(Math.min(endDay.getTime(), today.getTime() - DAY_MS));
    const hasSummaryRange = !singleDay && startDay <= summaryEnd;

    const summaryDates = new Set<string>();
    const summaryGroups = hasSummaryRange
      ? await prisma.browserDailySummary.groupBy({
          by: ["workDate", "domain"],
          where: {
            employeeId,
            workDate: { gte: startDay, lte: summaryEnd },
          },
          _sum: {
            durationSeconds: true,
            productiveSeconds: true,
            unproductiveSeconds: true,
            neutralSeconds: true,
            blacklistedSeconds: true,
          },
        })
      : [];

    for (const group of summaryGroups) {
      summaryDates.add(workDateKey(group.workDate));
      const row = totals.get(group.domain) ?? emptyBrowserDomain(group.domain);
      row.durationSeconds += group._sum.durationSeconds ?? 0;
      row.productiveSeconds += group._sum.productiveSeconds ?? 0;
      row.unproductiveSeconds += group._sum.unproductiveSeconds ?? 0;
      row.neutralSeconds += group._sum.neutralSeconds ?? 0;
      row.blacklistedSeconds += group._sum.blacklistedSeconds ?? 0;
      totals.set(group.domain, row);
    }

    const rawRows =
      start <= end && deviceIds.length > 0
        ? await prisma.browserActivity.findMany({
            where: {
              deviceId: { in: deviceIds },
              startTime: { gte: start, lte: end },
            },
            select: {
              domain: true,
              productivityTag: true,
              durationSeconds: true,
              startTime: true,
            },
          })
        : [];

    for (const row of rawRows) {
      const rowDay = workDateKey(row.startTime);
      if (summaryDates.has(rowDay)) continue;
      addBrowserDomain(totals, row.domain, row.productivityTag, row.durationSeconds);
    }

    return [...totals.values()]
      .sort((left, right) => right.durationSeconds - left.durationSeconds)
      .slice(0, TOP_LIST_SIZE);
  }

  /** Resolves the authenticated screenshot viewer route to its stored object key/path. */
  async getScreenshotPath(deviceId: string, clientEventId: string) {
    const screenshot = await prisma.screenshot.findUnique({ where: { clientEventId } });
    if (!screenshot || screenshot.deviceId !== deviceId) {
      throw { statusCode: 404, message: "Screenshot not found" };
    }
    return screenshot.storagePath;
  }

  /**
   * Per-employee totals for a date range, read from the pre-aggregated daily rollup.
   *
   * One indexed GROUP BY over at most (employees x days) rows - 100 employees over a month is
   * ~3,000 rows, and that ceiling does not move as telemetry accumulates. The old version of
   * this method grouped activity_sessions instead, which is the same answer computed from
   * millions of rows on every page load.
   */
  private async totalsByEmployee(
    start: Date,
    end: Date,
    employeeIds?: string[],
    averagePerDay = false,
  ) {
    const days = reportDays(start, end);
    const divisor = averagePerDay && days >= 2 ? days : 1;
    const startDay = startOfUtcDay(start);
    const endDay = startOfUtcDay(end);
    const today = startOfUtcDay(new Date());
    const singleDay = startDay.getTime() === endDay.getTime();
    const summaryEnd = new Date(Math.min(endDay.getTime(), today.getTime() - DAY_MS));
    const hasSummaryRange = !singleDay && startDay <= summaryEnd;

    const [grouped, domainSummaries, liveBrowserRows] = await Promise.all([
      prisma.dailyActivityRollup.groupBy({
        by: ["employeeId"],
        where: {
          workDate: { gte: startDay, lte: endDay },
          ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
        },
        _sum: {
          activeSeconds: true,
          idleSeconds: true,
          productiveSeconds: true,
          unproductiveSeconds: true,
          neutralSeconds: true,
          blacklistedSeconds: true,
        },
      }),
      hasSummaryRange
        ? prisma.browserDailySummary.groupBy({
            by: ["employeeId"],
            where: {
              workDate: { gte: startDay, lte: summaryEnd },
              ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
            },
            _sum: {
              productiveSeconds: true,
              unproductiveSeconds: true,
              neutralSeconds: true,
              blacklistedSeconds: true,
            },
          })
        : [],
      start <= end && (!hasSummaryRange || startDay >= today || endDay >= today)
        ? prisma.browserActivity.findMany({
            where: {
              device: employeeIds ? { employeeId: { in: employeeIds } } : undefined,
              startTime: { gte: start, lte: end },
            },
            select: {
              device: { select: { employeeId: true } },
              productivityTag: true,
              durationSeconds: true,
              startTime: true,
            },
          })
        : [],
    ]);

    const domainTotalsByEmployee = new Map<
      string,
      { productive: number; unproductive: number; neutral: number; blacklisted: number }
    >();

    for (const group of domainSummaries) {
      domainTotalsByEmployee.set(group.employeeId, {
        productive: group._sum.productiveSeconds ?? 0,
        unproductive: group._sum.unproductiveSeconds ?? 0,
        neutral: group._sum.neutralSeconds ?? 0,
        blacklisted: group._sum.blacklistedSeconds ?? 0,
      });
    }

    const summaryDates = new Set<string>();
    if (hasSummaryRange) {
      for (let d = new Date(startDay); d <= summaryEnd; d = new Date(d.getTime() + DAY_MS)) {
        summaryDates.add(workDateKey(d));
      }
    }

    for (const row of liveBrowserRows) {
      const empId = row.device.employeeId;
      const rowDay = workDateKey(row.startTime);
      if (!singleDay && rowDay < workDateKey(today) && summaryDates.has(rowDay)) continue;

      const current = domainTotalsByEmployee.get(empId) ?? {
        productive: 0,
        unproductive: 0,
        neutral: 0,
        blacklisted: 0,
      };

      switch (row.productivityTag) {
        case ProductivityTag.Productive:
          current.productive += row.durationSeconds;
          break;
        case ProductivityTag.Unproductive:
          current.unproductive += row.durationSeconds;
          break;
        case ProductivityTag.Blacklisted:
          current.blacklisted += row.durationSeconds;
          break;
        default:
          current.neutral += row.durationSeconds;
      }
      domainTotalsByEmployee.set(empId, current);
    }

    const totals = new Map<string, Totals>();

    for (const row of grouped) {
      const domain = domainTotalsByEmployee.get(row.employeeId);
      let productive = row._sum.productiveSeconds ?? 0;
      let unproductive = row._sum.unproductiveSeconds ?? 0;
      let neutral = row._sum.neutralSeconds ?? 0;
      let blacklisted = row._sum.blacklistedSeconds ?? 0;

      if (domain) {
        const domainUnproductive = domain.unproductive;
        const domainBlacklisted = domain.blacklisted;
        const shiftAmount = domainUnproductive + domainBlacklisted;

        if (shiftAmount > 0) {
          const shiftFromProductive = Math.min(productive, shiftAmount);
          productive -= shiftFromProductive;
          const remainingShift = shiftAmount - shiftFromProductive;
          const shiftFromNeutral = Math.min(neutral, remainingShift);
          neutral -= shiftFromNeutral;

          unproductive += domainUnproductive;
          blacklisted += domainBlacklisted;
        }
      }

      totals.set(row.employeeId, {
        activeSeconds: Math.round((row._sum.activeSeconds ?? 0) / divisor),
        idleSeconds: Math.round((row._sum.idleSeconds ?? 0) / divisor),
        productiveSeconds: Math.round(productive / divisor),
        unproductiveSeconds: Math.round(unproductive / divisor),
        neutralSeconds: Math.round(neutral / divisor),
        blacklistedSeconds: Math.round(blacklisted / divisor),
      });
    }

    return totals;
  }

  /**
   * Active and idle seconds per work date, plus the day's last observed activity.
   *
   * Same rollup table as `totalsByEmployee` and for the same reason - one indexed row per employee
   * per day rather than a scan of the log tables. Kept separate because the day-grained answer is
   * what the attendance card needs and the range-grained one is what the header needs; summing the
   * former to get the latter would work, but reading each at its own grain keeps both queries to a
   * single GROUP BY.
   */
  private async dailyTotals(start: Date, end: Date, employeeId: string) {
    const grouped = await prisma.dailyActivityRollup.groupBy({
      by: ["workDate"],
      where: { employeeId, workDate: { gte: startOfUtcDay(start), lte: startOfUtcDay(end) } },
      _sum: { activeSeconds: true, idleSeconds: true },
      _max: { lastActivityAt: true },
    });

    return new Map(
      grouped.map((row) => [
        workDateKey(row.workDate),
        {
          activeSeconds: row._sum.activeSeconds ?? 0,
          idleSeconds: row._sum.idleSeconds ?? 0,
          lastActivityAt: row._max.lastActivityAt ?? null,
        },
      ]),
    );
  }

  /**
   * Folds the attendance sessions of a range into one row per work date - the shape the attendance
   * report is actually asked for: when the employee arrived, when they left, and how the time in
   * between divides into work and idleness.
   *
   * A day is several sessions, because a lock, a suspend or a logoff ends one and coming back
   * starts another. So **first login is the earliest and last logout the latest across them**, and
   * a day is only over once every one of its sessions has closed.
   *
   * The seconds come from the daily rollup rather than from the attendance rows: the rollup counts
   * the activity log, which includes the locked and suspended stretches *between* sessions, and an
   * attendance row deliberately counts only the presence inside itself. Adding the rows up would
   * report a day with a lunch break as shorter than it was.
   */
  private summarizeAttendance(
    sessions: {
      loginTime: Date;
      logoutTime: Date | null;
      logoutSource: LogoutSource | null;
      workDate: Date;
      deviceId: string;
    }[],
    dailyTotals: Map<
      string,
      { activeSeconds: number; idleSeconds: number; lastActivityAt: Date | null }
    >,
    lastSeenByDevice: Map<string, Date | null>,
    now: number,
  ): AttendanceDay[] {
    const byDate = new Map<string, AttendanceDay & { openAndLive: boolean; hasOpen: boolean }>();

    for (const session of sessions) {
      const key = workDateKey(session.workDate);
      const totals = dailyTotals.get(key);

      const day = byDate.get(key) ?? {
        workDate: key,
        firstLogin: session.loginTime,
        lastLogout: null,
        sessionSeconds: 0,
        activeSeconds: totals?.activeSeconds ?? 0,
        idleSeconds: totals?.idleSeconds ?? 0,
        sessionCount: 0,
        status: "ended" as const,
        logoutEstimated: false,
        openAndLive: false,
        hasOpen: false,
      };

      day.sessionCount += 1;
      if (session.loginTime < day.firstLogin) day.firstLogin = session.loginTime;

      if (session.logoutTime === null) {
        day.hasOpen = true;
        day.openAndLive ||= isLive(lastSeenByDevice.get(session.deviceId), now);
      } else if (day.lastLogout === null || session.logoutTime > day.lastLogout) {
        day.lastLogout = session.logoutTime;
        // Tracks the session that *currently* supplies the day's last logout, so a later observed
        // logout clears the flag a server-inferred one set. Assigned rather than OR-ed for exactly
        // that reason: an estimate earlier in the day says nothing about the time the day ended on.
        day.logoutEstimated = session.logoutSource === LogoutSource.Server;
      }

      byDate.set(key, day);
    }

    // Include days with recorded activity that lacked explicit attendance logon records
    for (const [key, totals] of dailyTotals.entries()) {
      if (!byDate.has(key) && (totals.activeSeconds > 0 || totals.idleSeconds > 0)) {
        const midnight = new Date(`${key}T00:00:00.000Z`);
        byDate.set(key, {
          workDate: key,
          firstLogin: midnight,
          lastLogout: totals.lastActivityAt ?? midnight,
          sessionSeconds: totals.activeSeconds + totals.idleSeconds,
          activeSeconds: totals.activeSeconds,
          idleSeconds: totals.idleSeconds,
          sessionCount: 1,
          status: "ended" as const,
          logoutEstimated: true,
          openAndLive: false,
          hasOpen: false,
        });
      }
    }

    return [...byDate.values()]
      .map(({ openAndLive, hasOpen, ...day }) => {
        // Three ways a day can end, and they are not interchangeable. Still at the desk: measure to
        // now. Every session closed: measure to the last logout. An open session on a workstation
        // that has gone quiet: the logout was never observed, so fall back to the last activity the
        // rollup saw rather than inventing one - and say so, instead of showing the employee as
        // present days later.
        const status: AttendanceDay["status"] = openAndLive
          ? "present"
          : hasOpen
            ? "unknown"
            : "ended";
        const lastActivityAt = dailyTotals.get(day.workDate)?.lastActivityAt ?? null;

        // On an `ended` day the last logout is authoritative and activity recorded after it is the
        // machine sitting locked, not presence. On an `unknown` day there is no logout for the
        // session that never closed, so the day ran at least as late as the last thing the rollup
        // saw - taking the logout alone would report a day as ending before work it has already
        // counted.
        const endedAt =
          status === "present"
            ? new Date(now)
            : status === "unknown"
              ? (latest(day.lastLogout, lastActivityAt) ?? day.firstLogin)
              : (day.lastLogout ?? lastActivityAt ?? day.firstLogin);

        const elapsedMs = endedAt.getTime() - day.firstLogin.getTime();

        return {
          ...day,
          status,
          sessionSeconds: Math.max(0, Math.round(elapsedMs / 1000)),
        };
      })
      .sort((a, b) => b.workDate.localeCompare(a.workDate));
  }

  /** Overview screen (spec section 5): team-wide active time, productivity, who's online, attendance. */
  async getOverview(startDate?: string, endDate?: string) {
    const { start, end } = resolveRange(startDate, endDate);
    const onlineSince = new Date(Date.now() - ONLINE_WINDOW_MS);
    const today = startOfUtcDay(new Date());

    const [totals, employees, onlineDevices, todaysAttendance, openAlerts] = await Promise.all([
      this.totalsByEmployee(start, end, undefined, true),
      prisma.employee.findMany({
        where: { status: { not: "placeholder" } },
        select: { id: true, name: true, department: true },
      }),
      prisma.device.count({ where: { isActive: true, lastSeen: { gte: onlineSince } } }),
      prisma.attendanceSession.findMany({
        where: { workDate: today },
        select: { userSid: true, loginTime: true, logoutTime: true, deviceId: true },
      }),
      prisma.alert.count({ where: { resolvedAt: null, severity: { in: ["High", "Critical"] } } }),
    ]);

    const team = emptyTotals();
    for (const t of totals.values()) {
      team.activeSeconds += t.activeSeconds;
      team.idleSeconds += t.idleSeconds;
      team.productiveSeconds += t.productiveSeconds;
      team.unproductiveSeconds += t.unproductiveSeconds;
      team.neutralSeconds += t.neutralSeconds;
      team.blacklistedSeconds += t.blacklistedSeconds;
    }

    return {
      period: { start, end },
      headcount: employees.length,
      employeesTracked: totals.size,
      onlineNow: onlineDevices,
      openHighSeverityAlerts: openAlerts,
      // Counted by person, not by row. An attendance row is one uninterrupted stretch of presence,
      // so a day with a lunch break and a couple of locked screens is several rows for the same
      // employee; counting rows would report a headcount of eleven for a team of three.
      attendanceToday: {
        checkedIn: new Set(todaysAttendance.map((a) => a.userSid)).size,
        stillActive: new Set(
          todaysAttendance.filter((a) => a.logoutTime === null).map((a) => a.userSid),
        ).size,
      },
      totals: { ...team, productivityPercent: productivityPercent(team) },
    };
  }

  /** Employee list (spec section 5): all staff with active/idle/productivity at a glance. */
  async getEmployeeRoster(startDate?: string, endDate?: string) {
    const { start, end } = resolveRange(startDate, endDate);
    const onlineSince = new Date(Date.now() - ONLINE_WINDOW_MS);

    const [totals, employees] = await Promise.all([
      this.totalsByEmployee(start, end, undefined, true),
      prisma.employee.findMany({
        where: { status: { not: "placeholder" } },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          email: true,
          department: true,
          status: true,
          devices: { select: { id: true, deviceName: true, lastSeen: true, isActive: true } },
        },
      }),
    ]);

    return {
      period: { start, end },
      employees: employees.map((e) => {
        const t = totals.get(e.id) ?? emptyTotals();
        const lastSeen = e.devices
          .map((d) => d.lastSeen)
          .filter((d): d is Date => !!d)
          .sort((a, b) => b.getTime() - a.getTime())[0];

        return {
          id: e.id,
          name: e.name,
          email: e.email,
          department: e.department,
          status: e.status,
          deviceCount: e.devices.length,
          lastSeen: lastSeen ?? null,
          isOnline: !!lastSeen && lastSeen >= onlineSince,
          ...t,
          productivityPercent: productivityPercent(t),
        };
      }),
    };
  }

  private async getActivityMetrics(
    employeeId: string,
    deviceIds: string[],
    start: Date,
    end: Date,
  ) {
    const today = startOfUtcDay(new Date());
    const startDay = startOfUtcDay(start);
    const endDay = startOfUtcDay(end);
    const singleDay = startDay.getTime() === endDay.getTime();
    const summaryEnd = new Date(Math.min(endDay.getTime(), today.getTime() - DAY_MS));
    const hasSummaryRange = !singleDay && startDay <= summaryEnd;

    const summaryDates = new Set<string>();
    const summaryGroups = hasSummaryRange
      ? await prisma.activityMetricDailySummary.groupBy({
          by: ["workDate"],
          where: { employeeId, workDate: { gte: startDay, lte: summaryEnd } },
          _sum: {
            keyCount: true,
            mouseCount: true,
            mouseLeftKeyCount: true,
            mouseRightKeyCount: true,
            mouseMiddleKeyCount: true,
            mouseOtherKeyCount: true,
          },
        })
      : [];

    let keyCount = 0;
    let mouseCount = 0;
    let mouseLeftKeyCount = 0;
    let mouseRightKeyCount = 0;
    let mouseMiddleKeyCount = 0;
    let mouseOtherKeyCount = 0;

    for (const group of summaryGroups) {
      summaryDates.add(workDateKey(group.workDate));
      keyCount += group._sum.keyCount ?? 0;
      mouseCount += group._sum.mouseCount ?? 0;
      mouseLeftKeyCount += group._sum.mouseLeftKeyCount ?? 0;
      mouseRightKeyCount += group._sum.mouseRightKeyCount ?? 0;
      mouseMiddleKeyCount += group._sum.mouseMiddleKeyCount ?? 0;
      mouseOtherKeyCount += group._sum.mouseOtherKeyCount ?? 0;
    }

    // Guardrail: query raw metrics for dates without summaries (today + unsummarized past dates)
    const rawMetrics =
      start <= end && deviceIds.length > 0
        ? await prisma.activityMetric.findMany({
            where: {
              deviceId: { in: deviceIds },
              windowEndUtc: { gte: start, lte: end },
            },
            select: {
              keyCount: true,
              mouseCount: true,
              mouseLeftKeyCount: true,
              mouseRightKeyCount: true,
              mouseMiddleKeyCount: true,
              mouseOtherKeyCount: true,
              windowEndUtc: true,
            },
          })
        : [];

    for (const row of rawMetrics) {
      const rowDay = workDateKey(row.windowEndUtc);
      if (summaryDates.has(rowDay)) continue;
      keyCount += row.keyCount;
      mouseCount += row.mouseCount;
      mouseLeftKeyCount += row.mouseLeftKeyCount;
      mouseRightKeyCount += row.mouseRightKeyCount;
      mouseMiddleKeyCount += row.mouseMiddleKeyCount;
      mouseOtherKeyCount += row.mouseOtherKeyCount;
    }

    return {
      keyCount,
      mouseCount,
      mouseLeftKeyCount,
      mouseRightKeyCount,
      mouseMiddleKeyCount,
      mouseOtherKeyCount,
    };
  }

  /**
   * Employee detail (spec section 5): first page of the timeline, active-vs-idle split, top apps and
   * domains for the range. Defaults to today when no range is given.
   *
   * The timeline is one page, not the whole range. It used to `take: 2000` and hand the lot to
   * the browser, which is both an unbounded read as history grows and 2,000 rows rendered into a
   * page nobody scrolls to the end of. The UI now shows a fixed-height window and asks for the
   * next page when the operator reaches the bottom - see getActivityLog.
   */
  async getEmployeeDetail(employeeId: string, startDate?: string, endDate?: string) {
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        name: true,
        email: true,
        department: true,
        devices: { select: { id: true, deviceName: true, lastSeen: true, agentVersion: true } },
      },
    });
    if (!employee) throw { statusCode: 404, message: "Employee not found" };

    const { start, end } = resolveRange(startDate, endDate);

    const deviceIds = employee.devices.map((d) => d.id);
    if (deviceIds.length === 0) {
      return {
        employee,
        period: { start, end },
        totals: { ...emptyTotals(), productivityPercent: 0 },
        timeline: { rows: [], nextCursor: null, hasMore: false },
        topApps: [],
        topDomains: [],
        activityMetrics: {
          keyCount: 0,
          mouseCount: 0,
          mouseLeftKeyCount: 0,
          mouseRightKeyCount: 0,
          mouseMiddleKeyCount: 0,
          mouseOtherKeyCount: 0,
        },
        attendance: [],
        attendanceDays: [],
        weeklyAttendanceDays: [],
      };
    }

    const deviceScope = { deviceId: { in: deviceIds } };

    // Weekly attendance always spans at least the full ISO week(s) containing the period
    const isoWeekStartDay = (start.getUTCDay() - 1 + 7) % 7;
    const attendanceRangeStart = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() - isoWeekStartDay),
    );
    const isoWeekEndDay = (end.getUTCDay() - 1 + 7) % 7;
    const attendanceRangeEnd = new Date(
      Date.UTC(
        end.getUTCFullYear(),
        end.getUTCMonth(),
        end.getUTCDate() + (6 - isoWeekEndDay),
        23,
        59,
        59,
        999,
      ),
    );

    const [
      totalsByEmployee,
      filteredDailyTotals,
      weeklyDailyTotals,
      timeline,
      appGroups,
      domainGroups,
      attendanceSessions,
      allAttendanceSessions,
      activityMetrics,
    ] = await Promise.all([
      // Totals come from the rollup, not from the timeline page. Deriving them from whatever
      // rows happened to be on screen is how a "productivity %" silently becomes "productivity %
      // of the first fifty rows".
      this.totalsByEmployee(start, end, [employeeId]),
      this.dailyTotals(start, end, employeeId),
      this.dailyTotals(attendanceRangeStart, attendanceRangeEnd, employeeId),
      this.getActivityLog(employeeId, { startDate, endDate }),
      this.getApplicationGroups(employeeId, deviceIds, start, end),
      this.getBrowserDomainGroups(employeeId, deviceIds, start, end),
      prisma.attendanceSession.findMany({
        where: {
          ...deviceScope,
          loginTime: { gte: start, lte: end },
        },
        orderBy: { loginTime: "asc" },
        select: {
          sessionId: true,
          loginTime: true,
          logoutTime: true,
          endReason: true,
          // Whether the logout was observed by the workstation or inferred by the server after the
          // machine stopped answering. A payroll figure has to be able to say which it is.
          logoutSource: true,
          workDate: true,
          // Which workstation the session ran on, so an open row can be tested against that
          // device's liveness rather than reported as presence on its own.
          deviceId: true,
        },
      }),
      prisma.attendanceSession.findMany({
        where: {
          ...deviceScope,
          loginTime: { gte: attendanceRangeStart, lte: attendanceRangeEnd },
        },
        orderBy: { loginTime: "asc" },
        select: {
          sessionId: true,
          loginTime: true,
          logoutTime: true,
          endReason: true,
          logoutSource: true,
          workDate: true,
          deviceId: true,
        },
      }),
      this.getActivityMetrics(employeeId, deviceIds, start, end),
    ]);

    const totals = totalsByEmployee.get(employeeId) ?? emptyTotals();
    const lastSeenByDevice = new Map(employee.devices.map((d) => [d.id, d.lastSeen]));

    return {
      employee,
      period: { start, end },
      totals: { ...totals, productivityPercent: productivityPercent(totals) },
      timeline,
      topApps: appGroups.map((g) => ({
        appName: g.appName,
        productivityTag: dominantProductivityTag(g),
        seconds: g.durationSeconds,
        productiveSeconds: g.productiveSeconds,
        unproductiveSeconds: g.unproductiveSeconds,
        neutralSeconds: g.neutralSeconds,
        blacklistedSeconds: g.blacklistedSeconds,
      })),
      topDomains: domainGroups.map((g) => ({
        domain: g.domain,
        productivityTag: dominantProductivityTag(g),
        seconds: g.durationSeconds,
        productiveSeconds: g.productiveSeconds,
        unproductiveSeconds: g.unproductiveSeconds,
        neutralSeconds: g.neutralSeconds,
        blacklistedSeconds: g.blacklistedSeconds,
      })),
      activityMetrics,
      attendance: attendanceSessions,
      attendanceDays: this.summarizeAttendance(
        attendanceSessions,
        filteredDailyTotals,
        lastSeenByDevice,
        Date.now(),
      ),
      weeklyAttendanceDays: this.summarizeAttendance(
        allAttendanceSessions,
        weeklyDailyTotals,
        lastSeenByDevice,
        Date.now(),
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Log feeds.
  //
  // All three follow the same shape: newest first, one page, keyset cursor. The page size comes
  // from policy rather than a constant here, so an admin changes it from the settings screen.
  // A caller may ask for fewer rows than policy allows but never more - otherwise the bound is
  // decorative.
  // -------------------------------------------------------------------------

  /**
   * Activity timeline for one employee, newest first.
   *
   * Browser visits are attached to the app session that contained them, so the UI can expand a
   * "Chrome - 2h" row into the sites that made it up. They are fetched for the rows on *this
   * page* only - the whole point of paging is not to load the range.
   */
  async getActivityLog(
    employeeId: string,
    options: { startDate?: string; endDate?: string; cursor?: string; limit?: number } = {},
  ) {
    const { start, end } =
      options.startDate || options.endDate
        ? resolveRange(options.startDate, options.endDate)
        : { start: startOfUtcDay(new Date()), end: new Date() };

    const organizationId = await currentOrganizationId();
    const pageSize = await resolvePageSize(organizationId, options.limit);
    const cursor = decodeCursor(options.cursor);

    const devices = await prisma.device.findMany({ where: { employeeId }, select: { id: true } });
    if (devices.length === 0) return { rows: [], nextCursor: null, hasMore: false };

    const rows = await prisma.activitySession.findMany({
      where: {
        deviceId: { in: devices.map((d) => d.id) },
        startTime: { gte: start, lte: end },
        ...olderThan("startTime", cursor),
      },
      orderBy: newestFirst("startTime"),
      // One extra row, purely to answer "is there more?" without a second COUNT over the same
      // predicate - which on a log table costs as much as the page itself.
      take: pageSize + 1,
      select: {
        id: true,
        activitySessionId: true,
        appName: true,
        processName: true,
        type: true,
        windowTitle: true,
        startTime: true,
        endTime: true,
        durationSeconds: true,
        reason: true,
        productivityTag: true,
      },
    });

    const page = toPage(rows, pageSize, (r) => r.startTime);

    const visits = await prisma.browserActivity.findMany({
      where: { activitySessionId: { in: page.rows.map((r) => r.activitySessionId) } },
      orderBy: { startTime: "asc" },
      select: {
        id: true,
        activitySessionId: true,
        browser: true,
        domain: true,
        rawUrl: true,
        pageTitle: true,
        startTime: true,
        endTime: true,
        durationSeconds: true,
        productivityTag: true,
      },
    });

    const visitsBySession = new Map<string, typeof visits>();
    for (const visit of visits) {
      if (!visit.activitySessionId) continue;
      const list = visitsBySession.get(visit.activitySessionId);
      if (list) list.push(visit);
      else visitsBySession.set(visit.activitySessionId, [visit]);
    }

    return {
      ...page,
      rows: page.rows.map((r) => ({
        ...r,
        visits: visitsBySession.get(r.activitySessionId) ?? [],
      })),
    };
  }

  /** Alert feed (Features.md "Alert Notification") for the dashboard. */
  async getAlerts(options: { cursor?: string; limit?: number; includeResolved?: boolean } = {}) {
    const organizationId = await currentOrganizationId();
    const pageSize = await resolvePageSize(organizationId, options.limit);
    const cursor = decodeCursor(options.cursor);

    const rows = await prisma.alert.findMany({
      where: {
        ...(options.includeResolved ? {} : { resolvedAt: null }),
        ...olderThan("triggeredAt", cursor),
      },
      orderBy: newestFirst("triggeredAt"),
      take: pageSize + 1,
      include: {
        device: { select: { deviceName: true, employee: { select: { id: true, name: true } } } },
      },
    });

    return toPage(rows, pageSize, (r) => r.triggeredAt);
  }

  /**
   * USB device audit trail (Features.md "USB Logs").
   *
   * `employeeId` narrows the trail to the machines assigned to one person, which is what the
   * employee detail screen asks for. The filter is applied in the query rather than by the
   * caller: paging is keyset over eventTime, so a page filtered after the fact would return
   * between zero and `pageSize` rows and the scroll window would stall on a page that looked
   * empty but was not the end. Filtering here also keeps one employee's screen from being sent
   * every other employee's removable-device history.
   */
  async getUsbEvents(
    options: {
      employeeId?: string;
      startDate?: string;
      endDate?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ) {
    const { start, end } = resolveRange(options.startDate, options.endDate);

    const organizationId = await currentOrganizationId();
    const pageSize = await resolvePageSize(organizationId, options.limit);
    const cursor = decodeCursor(options.cursor);

    const rows = await prisma.usbEvent.findMany({
      where: {
        eventTime: { gte: start, lte: end },
        ...(options.employeeId ? { device: { employeeId: options.employeeId } } : {}),
        ...olderThan("eventTime", cursor),
      },
      orderBy: newestFirst("eventTime"),
      take: pageSize + 1,
      include: {
        device: { select: { deviceName: true, employee: { select: { id: true, name: true } } } },
      },
    });

    const page = toPage(rows, pageSize, (r) => r.eventTime);

    // capacityBytes is a BigInt column; JSON.stringify throws on BigInt, so it is serialized
    // as a decimal string on the way out rather than silently losing precision as a Number.
    return {
      ...page,
      period: { start, end },
      rows: page.rows.map((e) => ({ ...e, capacityBytes: e.capacityBytes?.toString() ?? null })),
    };
  }

  /**
   * Screenshot index for the employee detail screen (spec section 5), newest first, one page at a time.
   *
   * Paged like the other log feeds rather than returning the range. Screenshots accumulate faster
   * than any other record here - one every few minutes per device, for every device the employee
   * has - so a fixed `take: 500` was both an arbitrary ceiling that silently hid older captures
   * and, at the same time, far more than the gallery shows before the operator scrolls. The grid
   * asks for the next page when it reaches the end, exactly as the timeline does.
   *
   * The bytes are not served from here: rows carry the identifiers the viewer route needs, and
   * each image is fetched (and audit-logged) individually when it is actually displayed.
   *
   * Page size comes from Policy.screenshotPageSize, NOT logPageSize. A page here is that many
   * JPEGs the browser downloads and decodes, not that many rows of JSON - see pagination.ts.
   */
  async getScreenshots(
    employeeId: string,
    options: { startDate?: string; endDate?: string; cursor?: string; limit?: number } = {},
  ) {
    const { start, end } = resolveRange(options.startDate, options.endDate);

    const organizationId = await currentOrganizationId();
    const pageSize = await resolveScreenshotPageSize(organizationId, options.limit);
    const cursor = decodeCursor(options.cursor);

    const devices = await prisma.device.findMany({
      where: { employeeId },
      select: { id: true, deviceName: true },
    });
    if (devices.length === 0) {
      return { period: { start, end }, rows: [], nextCursor: null, hasMore: false };
    }

    const rows = await prisma.screenshot.findMany({
      where: {
        deviceId: { in: devices.map((d) => d.id) },
        capturedAt: { gte: start, lte: end },
        ...olderThan("capturedAt", cursor),
      },
      orderBy: newestFirst("capturedAt"),
      take: pageSize + 1,
      select: {
        id: true,
        deviceId: true,
        clientEventId: true,
        capturedAt: true,
        width: true,
        height: true,
        sizeBytes: true,
      },
    });

    const page = toPage(rows, pageSize, (r) => r.capturedAt);

    // An employee with two machines gets two interleaved streams of captures, and "which screen
    // is this?" is unanswerable from a thumbnail. The name is joined from the devices already
    // fetched above rather than an include on every row, which would repeat it per screenshot.
    const deviceNames = new Map(devices.map((d) => [d.id, d.deviceName]));

    return {
      ...page,
      period: { start, end },
      rows: page.rows.map((r) => ({ ...r, deviceName: deviceNames.get(r.deviceId) ?? null })),
    };
  }
}

export const reportService = new ReportService();
