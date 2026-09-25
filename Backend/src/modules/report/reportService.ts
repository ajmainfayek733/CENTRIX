import { ActivityType, LogoutSource, ProductivityTag } from "@prisma/client";
import { prisma } from "../../config/db";
import { currentOrganizationId } from "../../config/tenant";
import { categoryService } from "./categoryService";
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

export interface WorkplaceIntelligence {
  deepWork: {
    totalSeconds: number;
    sessionCount: number;
    scorePercent: number;
    averageSessionMinutes: number;
  };
  contextSwitching: {
    totalSwitches: number;
    switchesPerHour: number;
    state: "Low Friction" | "Moderate Switching" | "High Fragmentation";
    description: string;
  };
  collaborationVsMaker: {
    collaborationSeconds: number;
    makerSeconds: number;
    collaborationPercent: number;
    makerPercent: number;
    ratio: string;
  };
  burnoutRisk: {
    score: number;
    level: "Low Risk" | "Moderate Risk" | "High Risk";
    overtimeDays: number;
    lateNightSessionsCount: number;
    consecutiveOvertimeStreak: number;
    narrative: string;
  };
  executiveInsights: string[];
}

const COMM_KEYWORDS = [
  "teams",
  "slack",
  "zoom",
  "meet",
  "webex",
  "discord",
  "skype",
  "outlook",
  "thunderbird",
  "gmail",
  "mail",
  "telegram",
  "whatsapp",
  "dialpad",
  "ringcentral",
  "chime",
];

const MAKER_KEYWORDS = [
  "code",
  "visual studio",
  "cursor",
  "pycharm",
  "intellij",
  "webstorm",
  "clion",
  "sublime",
  "github",
  "gitlab",
  "jira",
  "confluence",
  "notion",
  "figma",
  "photoshop",
  "illustrator",
  "blender",
  "autocad",
  "excel",
  "sheets",
  "word",
  "docs",
  "powerpoint",
  "slides",
  "terminal",
  "powershell",
  "cmd",
  "bash",
  "postman",
  "dbeaver",
  "datagrip",
  "eclipse",
  "android studio",
  "xcode",
  "linear",
  "asana",
  "trello",
  "canva",
  "tableau",
  "powerbi",
];

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
    employeeId: string | string[] | null,
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

    const empFilter = Array.isArray(employeeId)
      ? { employeeId: { in: employeeId } }
      : employeeId
        ? { employeeId }
        : {};

    const summaryDates = new Set<string>();
    const summaryGroups = hasSummaryRange
      ? await prisma.activitySessionDailySummary.groupBy({
          by: ["workDate", "appName"],
          where: { ...empFilter, workDate: { gte: startDay, lte: summaryEnd } },
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

    // Map browser domain productivity specifically to the browser application that ran it
    const rawBrowserRows =
      start <= end && deviceIds.length > 0
        ? await prisma.browserActivity.findMany({
            where: {
              deviceId: { in: deviceIds },
              startTime: { gte: start, lte: end },
            },
            select: {
              activitySessionId: true,
              browser: true,
              productivityTag: true,
              durationSeconds: true,
              activitySession: {
                select: { appName: true },
              },
            },
          })
        : [];

    const matchBrowserApp = (appName: string | null | undefined, browserKind: string): boolean => {
      if (!appName) return false;
      const normApp = appName.toLowerCase();
      const normKind = browserKind.toLowerCase();
      if (normKind === "edge") return normApp.includes("edge") || normApp.includes("msedge");
      return normApp.includes(normKind);
    };

    for (const app of totals.values()) {
      if (!isBrowserApplication(app.appName)) continue;

      let appProd = 0;
      let appUnprod = 0;
      let appBlack = 0;
      let appNeut = 0;

      for (const bRow of rawBrowserRows) {
        const sessionAppName = bRow.activitySession?.appName;
        const isMatch =
          (sessionAppName && sessionAppName.toLowerCase() === app.appName?.toLowerCase()) ||
          matchBrowserApp(app.appName, bRow.browser);

        if (isMatch) {
          switch (bRow.productivityTag) {
            case ProductivityTag.Productive:
              appProd += bRow.durationSeconds;
              break;
            case ProductivityTag.Unproductive:
              appUnprod += bRow.durationSeconds;
              break;
            case ProductivityTag.Blacklisted:
              appBlack += bRow.durationSeconds;
              break;
            default:
              appNeut += bRow.durationSeconds;
          }
        }
      }

      const domainSum = appProd + appUnprod + appBlack + appNeut;
      const unassigned = Math.max(0, app.durationSeconds - domainSum);

      const baseTag = dominantProductivityTag(app);
      app.productiveSeconds = appProd + (baseTag === "Productive" ? unassigned : 0);
      app.unproductiveSeconds = appUnprod + (baseTag === "Unproductive" ? unassigned : 0);
      app.blacklistedSeconds = appBlack + (baseTag === "Blacklisted" ? unassigned : 0);
      app.neutralSeconds =
        appNeut +
        (baseTag === "Neutral" ||
        !baseTag ||
        (baseTag !== "Unproductive" && baseTag !== "Blacklisted" && baseTag !== "Productive")
          ? unassigned
          : 0);
    }

    return [...totals.values()]
      .sort((left, right) => right.durationSeconds - left.durationSeconds)
      .slice(0, TOP_LIST_SIZE);
  }

  private async getBrowserDomainGroups(
    employeeId: string | string[] | null,
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

    const empFilter = Array.isArray(employeeId)
      ? { employeeId: { in: employeeId } }
      : employeeId
        ? { employeeId }
        : {};

    const summaryDates = new Set<string>();
    const summaryGroups = hasSummaryRange
      ? await prisma.browserDailySummary.groupBy({
          by: ["workDate", "domain"],
          where: {
            ...empFilter,
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
        // Shift blacklisted domain time (from neutral first, then productive)
        const shiftBlacklisted = Math.min(neutral, domain.blacklisted);
        neutral -= shiftBlacklisted;
        blacklisted += domain.blacklisted;
        const remBlacklisted = domain.blacklisted - shiftBlacklisted;
        if (remBlacklisted > 0) {
          productive = Math.max(0, productive - remBlacklisted);
        }

        // Shift unproductive domain time (from neutral first, then productive)
        const shiftUnproductive = Math.min(neutral, domain.unproductive);
        neutral -= shiftUnproductive;
        unproductive += domain.unproductive;
        const remUnproductive = domain.unproductive - shiftUnproductive;
        if (remUnproductive > 0) {
          productive = Math.max(0, productive - remUnproductive);
        }

        // Shift productive domain time (credit productive browsing from neutral)
        const shiftProductive = Math.min(neutral, domain.productive);
        neutral -= shiftProductive;
        productive += domain.productive;
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
    employeeId: string | string[] | null,
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

    const empFilter = Array.isArray(employeeId)
      ? { employeeId: { in: employeeId } }
      : employeeId
        ? { employeeId }
        : {};

    const summaryDates = new Set<string>();
    const summaryGroups = hasSummaryRange
      ? await prisma.activityMetricDailySummary.groupBy({
          by: ["workDate"],
          where: { ...empFilter, workDate: { gte: startDay, lte: summaryEnd } },
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

  private async calculateWorkplaceIntelligence(
    deviceIds: string[],
    employeeIds: string[],
    start: Date,
    end: Date,
    totals: Totals,
    appGroups: ApplicationTotals[],
    domainGroups: BrowserDomainTotals[] = [],
  ): Promise<WorkplaceIntelligence> {
    const startDay = startOfUtcDay(start);
    const endDay = startOfUtcDay(end);

    const [dailyRollups, rawSessions] = await Promise.all([
      prisma.dailyActivityRollup.findMany({
        where: {
          employeeId: { in: employeeIds },
          workDate: { gte: startDay, lte: endDay },
        },
        select: {
          workDate: true,
          employeeId: true,
          activeSeconds: true,
          lastActivityAt: true,
        },
      }),
      deviceIds.length > 0 && start <= end
        ? prisma.activitySession.findMany({
            where: {
              deviceId: { in: deviceIds },
              startTime: { gte: start, lte: end },
            },
            select: {
              appName: true,
              type: true,
              productivityTag: true,
              durationSeconds: true,
              startTime: true,
            },
            orderBy: { startTime: "asc" },
          })
        : [],
    ]);

    // 1. Deep Work / Focus Blocks (continuous sessions >= 45 min = 2700 sec in productive applications)
    let deepWorkSeconds = 0;
    let deepWorkSessionCount = 0;
    const FOCUS_BLOCK_MIN_SECONDS = 45 * 60; // 45 minutes

    for (const session of rawSessions) {
      if (
        session.type === ActivityType.Application &&
        session.productivityTag === ProductivityTag.Productive &&
        session.durationSeconds >= FOCUS_BLOCK_MIN_SECONDS
      ) {
        deepWorkSeconds += session.durationSeconds;
        deepWorkSessionCount += 1;
      }
    }

    // Deep work score: share of productive time spent in deep work blocks
    const deepWorkScore =
      totals.productiveSeconds > 0
        ? Math.min(100, Math.round((deepWorkSeconds / totals.productiveSeconds) * 1000) / 10)
        : totals.activeSeconds > 0 && deepWorkSeconds > 0
          ? Math.min(100, Math.round((deepWorkSeconds / totals.activeSeconds) * 1000) / 10)
          : 0;

    const avgFocusMinutes =
      deepWorkSessionCount > 0 ? Math.round(deepWorkSeconds / deepWorkSessionCount / 60) : 0;

    // 2. Context Switching Rate
    const totalSwitches = rawSessions.filter((s) => s.type === ActivityType.Application).length;
    const activeHours = Math.max(0.1, totals.activeSeconds / 3600);
    const switchesPerHour = Math.round((totalSwitches / activeHours) * 10) / 10;

    let switchState: "Low Friction" | "Moderate Switching" | "High Fragmentation" = "Low Friction";
    let switchDescription = "Low cognitive thrashing with strong flow state sustained.";
    if (switchesPerHour > 25) {
      switchState = "High Fragmentation";
      switchDescription = "Elevated multitasking and frequent context shifts impacting deep focus.";
    } else if (switchesPerHour >= 12) {
      switchState = "Moderate Switching";
      switchDescription = "Balanced multidisciplinary workflow with standard task transitions.";
    }

    // 3. Meeting / Collaboration vs Maker Ratio
    let collaborationSeconds = 0;
    let makerSeconds = 0;

    for (const app of appGroups) {
      const name = (app.appName || "").toLowerCase();
      if (COMM_KEYWORDS.some((kw) => name.includes(kw))) {
        collaborationSeconds += app.durationSeconds;
      } else if (MAKER_KEYWORDS.some((kw) => name.includes(kw))) {
        makerSeconds += app.durationSeconds;
      }
    }

    for (const dom of domainGroups) {
      const name = dom.domain.toLowerCase();
      if (COMM_KEYWORDS.some((kw) => name.includes(kw))) {
        collaborationSeconds += dom.durationSeconds;
      } else if (MAKER_KEYWORDS.some((kw) => name.includes(kw))) {
        makerSeconds += dom.durationSeconds;
      }
    }

    const identifiedSecs = collaborationSeconds + makerSeconds;
    const collaborationPercent =
      identifiedSecs > 0 ? Math.round((collaborationSeconds / identifiedSecs) * 100) : 0;
    const makerPercent =
      identifiedSecs > 0 ? Math.round((makerSeconds / identifiedSecs) * 100) : 0;

    const makerRatioStr =
      collaborationSeconds > 0
        ? `1 : ${(makerSeconds / collaborationSeconds).toFixed(1)} Maker`
        : makerSeconds > 0
          ? "100% Execution"
          : "Balanced";

    // 4. Work-Life Balance & Burnout Risk
    let overtimeDays = 0;
    let lateNightSessionsCount = 0;
    const dailyActiveByEmployeeDate = new Map<string, number>();

    for (const rollup of dailyRollups) {
      const key = `${rollup.employeeId}_${workDateKey(rollup.workDate)}`;
      const cur = dailyActiveByEmployeeDate.get(key) ?? 0;
      dailyActiveByEmployeeDate.set(key, cur + rollup.activeSeconds);

      if (rollup.lastActivityAt) {
        const utcHour = rollup.lastActivityAt.getUTCHours();
        if (utcHour >= 20 || utcHour < 5) {
          lateNightSessionsCount += 1;
        }
      }
    }

    for (const activeSecs of dailyActiveByEmployeeDate.values()) {
      if (activeSecs >= 36000) {
        overtimeDays += 1;
      }
    }

    for (const s of rawSessions) {
      const h = s.startTime.getUTCHours();
      if (h >= 20 || h < 5) {
        lateNightSessionsCount += 1;
      }
    }

    // Consecutive overtime calculation
    let maxOvertimeStreak = 0;
    let currentStreak = 0;
    const sortedDates = [...new Set(dailyRollups.map((r) => workDateKey(r.workDate)))].sort();
    for (const d of sortedDates) {
      let isDayOvertime = false;
      for (const empId of employeeIds) {
        if ((dailyActiveByEmployeeDate.get(`${empId}_${d}`) ?? 0) >= 36000) {
          isDayOvertime = true;
          break;
        }
      }
      if (isDayOvertime) {
        currentStreak += 1;
        if (currentStreak > maxOvertimeStreak) maxOvertimeStreak = currentStreak;
      } else {
        currentStreak = 0;
      }
    }

    // Risk score 0 - 100
    let riskScore = 10;
    riskScore += overtimeDays * 15;
    riskScore += Math.min(30, Math.round(lateNightSessionsCount * 3));
    if (switchesPerHour > 25) riskScore += 15;
    if (maxOvertimeStreak >= 3) riskScore += 20;
    riskScore = Math.min(100, Math.max(0, riskScore));

    let burnoutLevel: "Low Risk" | "Moderate Risk" | "High Risk" = "Low Risk";
    let burnoutNarrative = "Healthy work rhythms with minimal after-hours activity detected.";
    if (riskScore >= 65) {
      burnoutLevel = "High Risk";
      burnoutNarrative = `High strain signal: ${overtimeDays} overtime days (>10h) and recurring after-hours activity past 8 PM.`;
    } else if (riskScore >= 35) {
      burnoutLevel = "Moderate Risk";
      burnoutNarrative = `Moderate workload strain: ${overtimeDays} overtime days detected with intermittent late-night activity.`;
    }

    // 5. Executive Insights
    const executiveInsights: string[] = [];

    // Focus / Deep Work insight
    if (deepWorkSessionCount > 0) {
      executiveInsights.push(
        `Focus Index: ${deepWorkScore}% of productive time spent in uninterrupted deep work blocks (avg ${avgFocusMinutes}m per focus session).`,
      );
    } else {
      executiveInsights.push(
        `Focus Index: No uninterrupted 45m+ focus sessions recorded (${switchesPerHour} app switches/hr indicate frequent interruptions).`,
      );
    }

    // Maker vs Collaboration dynamic insight
    if (identifiedSecs > 0) {
      executiveInsights.push(
        `Collaboration Ratio: ${collaborationPercent}% synchronous communication vs ${makerPercent}% deep execution & builder tooling (${makerRatioStr}).`,
      );
    } else {
      executiveInsights.push(
        `Workflow Balance: Average context switching rate is ${switchesPerHour} switches/hr (${switchState}).`,
      );
    }

    // Wellbeing & Burnout signal insight
    executiveInsights.push(
      `Workplace Wellbeing: Evaluated at ${burnoutLevel} (${riskScore}/100) with ${overtimeDays} extended 10h+ days and ${burnoutNarrative.toLowerCase()}`,
    );

    return {
      deepWork: {
        totalSeconds: deepWorkSeconds,
        sessionCount: deepWorkSessionCount,
        scorePercent: deepWorkScore,
        averageSessionMinutes: avgFocusMinutes,
      },
      contextSwitching: {
        totalSwitches,
        switchesPerHour,
        state: switchState,
        description: switchDescription,
      },
      collaborationVsMaker: {
        collaborationSeconds,
        makerSeconds,
        collaborationPercent,
        makerPercent,
        ratio: makerRatioStr,
      },
      burnoutRisk: {
        score: riskScore,
        level: burnoutLevel,
        overtimeDays,
        lateNightSessionsCount,
        consecutiveOvertimeStreak: maxOvertimeStreak,
        narrative: burnoutNarrative,
      },
      executiveInsights,
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
        departmentId: true,
        organizationId: true,
        devices: { select: { id: true, deviceName: true, lastSeen: true, agentVersion: true } },
      },
    });
    if (!employee) throw { statusCode: 404, message: "Employee not found" };

    // Resolve departmentId if not explicitly linked on employee row
    let resolvedDepartmentId = employee.departmentId;
    if (!resolvedDepartmentId && employee.department) {
      const dept = await prisma.department.findFirst({
        where: {
          organizationId: employee.organizationId,
          name: { equals: employee.department.trim(), mode: "insensitive" },
        },
        select: { id: true },
      });
      if (dept) resolvedDepartmentId = dept.id;
    }

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

    // Resolve top application tags against this employee's department rules (with fallback to dominant historical tag)
    const topApps = await Promise.all(
      appGroups.map(async (g) => {
        const ruleMatch = await categoryService.categorizeApp(
          employee.organizationId,
          g.appName,
          null,
          null,
          resolvedDepartmentId,
        );
        return {
          appName: g.appName,
          productivityTag: ruleMatch?.tag ?? dominantProductivityTag(g),
          seconds: g.durationSeconds,
          productiveSeconds: g.productiveSeconds,
          unproductiveSeconds: g.unproductiveSeconds,
          neutralSeconds: g.neutralSeconds,
          blacklistedSeconds: g.blacklistedSeconds,
        };
      }),
    );

    // Resolve top domain tags against this employee's department rules (with fallback to dominant historical tag)
    const topDomains = await Promise.all(
      domainGroups.map(async (g) => {
        const ruleMatch = await categoryService.categorizeDomain(
          employee.organizationId,
          g.domain,
          resolvedDepartmentId,
        );
        return {
          domain: g.domain,
          productivityTag: ruleMatch?.tag ?? dominantProductivityTag(g),
          seconds: g.durationSeconds,
          productiveSeconds: g.productiveSeconds,
          unproductiveSeconds: g.unproductiveSeconds,
          neutralSeconds: g.neutralSeconds,
          blacklistedSeconds: g.blacklistedSeconds,
        };
      }),
    );

    // Calculate workplace intelligence metrics (Deep Work, Context-Switching, Burnout Signal)
    const workplaceIntelligence = await this.calculateWorkplaceIntelligence(
      deviceIds,
      [employeeId],
      start,
      end,
      totals,
      appGroups,
      domainGroups,
    );

    return {
      employee,
      period: { start, end },
      totals: { ...totals, productivityPercent: productivityPercent(totals) },
      timeline,
      topApps,
      topDomains,
      activityMetrics,
      workplaceIntelligence,
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

  /**
   * Department performance aggregate: summary metrics, productivity mix, top apps/domains,
   * and member breakdown across all employees in a department.
   */
  async getDepartmentDetail(departmentId: string, startDate?: string, endDate?: string) {
    const dept = await prisma.department.findUnique({
      where: { id: departmentId },
      include: {
        organization: { select: { id: true, name: true } },
        employees: {
          select: {
            id: true,
            name: true,
            email: true,
            status: true,
            department: true,
            devices: { select: { id: true, deviceName: true, lastSeen: true, agentVersion: true } },
          },
          orderBy: { name: "asc" },
        },
      },
    });

    if (!dept) throw { statusCode: 404, message: "Department not found" };

    const { start, end } = resolveRange(startDate, endDate);
    const allDeviceIds = dept.employees.flatMap((e) => e.devices.map((d) => d.id));
    const employeeIds = dept.employees.map((e) => e.id);

    if (allDeviceIds.length === 0 || employeeIds.length === 0) {
      return {
        department: { id: dept.id, name: dept.name, description: dept.description },
        organization: dept.organization,
        period: { start, end },
        headcount: dept.employees.length,
        totals: { ...emptyTotals(), productivityPercent: 0 },
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
        workplaceIntelligence: {
          deepWork: { totalSeconds: 0, sessionCount: 0, scorePercent: 0, averageSessionMinutes: 0 },
          contextSwitching: {
            totalSwitches: 0,
            switchesPerHour: 0,
            state: "Low Friction" as const,
            description: "No activity recorded.",
          },
          collaborationVsMaker: {
            collaborationSeconds: 0,
            makerSeconds: 0,
            collaborationPercent: 0,
            makerPercent: 0,
            ratio: "N/A",
          },
          burnoutRisk: {
            score: 0,
            level: "Low Risk" as const,
            overtimeDays: 0,
            lateNightSessionsCount: 0,
            consecutiveOvertimeStreak: 0,
            narrative: "No activity recorded.",
          },
          executiveInsights: ["No activity data recorded in this period for the department."],
        },
        members: dept.employees.map((e) => ({
          employee: e,
          deviceCount: e.devices.length,
          totals: { ...emptyTotals(), productivityPercent: 0 },
        })),
      };
    }

    const [totalsByEmployee, appGroups, domainGroups, activityMetrics] = await Promise.all([
      this.totalsByEmployee(start, end, employeeIds),
      this.getApplicationGroups(employeeIds, allDeviceIds, start, end),
      this.getBrowserDomainGroups(employeeIds, allDeviceIds, start, end),
      this.getActivityMetrics(employeeIds, allDeviceIds, start, end),
    ]);

    let totalActive = 0;
    let totalIdle = 0;
    let totalProd = 0;
    let totalUnprod = 0;
    let totalNeut = 0;
    let totalBlack = 0;

    const members = dept.employees.map((e) => {
      const empTotals = totalsByEmployee.get(e.id) ?? emptyTotals();
      totalActive += empTotals.activeSeconds;
      totalIdle += empTotals.idleSeconds;
      totalProd += empTotals.productiveSeconds;
      totalUnprod += empTotals.unproductiveSeconds;
      totalNeut += empTotals.neutralSeconds;
      totalBlack += empTotals.blacklistedSeconds;

      return {
        employee: e,
        deviceCount: e.devices.length,
        totals: { ...empTotals, productivityPercent: productivityPercent(empTotals) },
      };
    });

    const deptTotals = {
      activeSeconds: totalActive,
      idleSeconds: totalIdle,
      productiveSeconds: totalProd,
      unproductiveSeconds: totalUnprod,
      neutralSeconds: totalNeut,
      blacklistedSeconds: totalBlack,
      productivityPercent: productivityPercent({
        activeSeconds: totalActive,
        idleSeconds: totalIdle,
        productiveSeconds: totalProd,
        unproductiveSeconds: totalUnprod,
        neutralSeconds: totalNeut,
        blacklistedSeconds: totalBlack,
      }),
    };

    const topApps = await Promise.all(
      appGroups.slice(0, 10).map(async (g) => {
        const ruleMatch = await categoryService.categorizeApp(
          dept.organizationId,
          g.appName,
          null,
          null,
          dept.id,
        );
        return {
          appName: g.appName,
          productivityTag: ruleMatch?.tag ?? dominantProductivityTag(g),
          seconds: g.durationSeconds,
          productiveSeconds: g.productiveSeconds,
          unproductiveSeconds: g.unproductiveSeconds,
          neutralSeconds: g.neutralSeconds,
          blacklistedSeconds: g.blacklistedSeconds,
        };
      }),
    );

    const topDomains = await Promise.all(
      domainGroups.slice(0, 10).map(async (g) => {
        const ruleMatch = await categoryService.categorizeDomain(
          dept.organizationId,
          g.domain,
          dept.id,
        );
        return {
          domain: g.domain,
          productivityTag: ruleMatch?.tag ?? dominantProductivityTag(g),
          seconds: g.durationSeconds,
          productiveSeconds: g.productiveSeconds,
          unproductiveSeconds: g.unproductiveSeconds,
          neutralSeconds: g.neutralSeconds,
          blacklistedSeconds: g.blacklistedSeconds,
        };
      }),
    );

    const workplaceIntelligence = await this.calculateWorkplaceIntelligence(
      allDeviceIds,
      employeeIds,
      start,
      end,
      deptTotals,
      appGroups,
      domainGroups,
    );

    return {
      department: { id: dept.id, name: dept.name, description: dept.description },
      organization: dept.organization,
      period: { start, end },
      headcount: dept.employees.length,
      totals: deptTotals,
      topApps,
      topDomains,
      activityMetrics,
      workplaceIntelligence,
      members,
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
