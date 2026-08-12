import { ActivityType } from '@prisma/client';
import { prisma } from '../../config/db';
import { currentOrganizationId } from '../../config/tenant';
import {
  decodeCursor,
  newestFirst,
  olderThan,
  resolvePageSize,
  resolveScreenshotPageSize,
  toPage,
} from './pagination';

/**
 * Dashboard read path (spec §5).
 *
 * TWO KINDS OF QUERY, AND THEY MUST NOT BE CONFUSED:
 *
 *   Aggregates (overview, roster, employee totals) read daily_activity_rollups — one row per
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
 * Derived from `devices.lastSeen`, which only an authenticated HTTP request updates — never from
 * Socket.IO presence. A socket can stay open through a total backend failure and can be closed
 * while an agent syncs happily over HTTP, so it answers a different question entirely.
 */
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

/** How many apps/domains the "top" lists show. Not a page — a fixed leaderboard. */
const TOP_LIST_SIZE = 15;

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function resolveRange(startDate?: string, endDate?: string) {
  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate ? new Date(startDate) : new Date(end.getTime() - 7 * 86400_000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw { statusCode: 400, message: 'startDate/endDate must be valid ISO dates' };
  }
  return { start, end };
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

export class ReportService {
  /** Backs the authenticated screenshot viewer route. */
  async getScreenshotPath(deviceId: string, clientEventId: string) {
    const screenshot = await prisma.screenshot.findUnique({ where: { clientEventId } });
    if (!screenshot || screenshot.deviceId !== deviceId) {
      throw { statusCode: 404, message: 'Screenshot not found' };
    }
    return screenshot.storagePath;
  }

  /**
   * Per-employee totals for a date range, read from the pre-aggregated daily rollup.
   *
   * One indexed GROUP BY over at most (employees × days) rows — 100 employees over a month is
   * ~3,000 rows, and that ceiling does not move as telemetry accumulates. The old version of
   * this method grouped activity_sessions instead, which is the same answer computed from
   * millions of rows on every page load.
   */
  private async totalsByEmployee(start: Date, end: Date, employeeIds?: string[]) {
    const grouped = await prisma.dailyActivityRollup.groupBy({
      by: ['employeeId'],
      where: {
        workDate: { gte: startOfUtcDay(start), lte: startOfUtcDay(end) },
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
    });

    const totals = new Map<string, Totals>();

    for (const row of grouped) {
      totals.set(row.employeeId, {
        activeSeconds: row._sum.activeSeconds ?? 0,
        idleSeconds: row._sum.idleSeconds ?? 0,
        productiveSeconds: row._sum.productiveSeconds ?? 0,
        unproductiveSeconds: row._sum.unproductiveSeconds ?? 0,
        neutralSeconds: row._sum.neutralSeconds ?? 0,
        blacklistedSeconds: row._sum.blacklistedSeconds ?? 0,
      });
    }

    return totals;
  }

  /** Overview screen (spec §5): team-wide active time, productivity, who's online, attendance. */
  async getOverview(startDate?: string, endDate?: string) {
    const { start, end } = resolveRange(startDate, endDate);
    const onlineSince = new Date(Date.now() - ONLINE_WINDOW_MS);
    const today = startOfUtcDay(new Date());

    const [totals, employees, onlineDevices, todaysAttendance, openAlerts] = await Promise.all([
      this.totalsByEmployee(start, end),
      prisma.employee.findMany({
        where: { status: { not: 'placeholder' } },
        select: { id: true, name: true, department: true },
      }),
      prisma.device.count({ where: { isActive: true, lastSeen: { gte: onlineSince } } }),
      prisma.attendanceSession.findMany({
        where: { workDate: today },
        select: { userSid: true, loginTime: true, logoutTime: true, deviceId: true },
      }),
      prisma.alert.count({ where: { resolvedAt: null, severity: { in: ['High', 'Critical'] } } }),
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
      attendanceToday: {
        checkedIn: todaysAttendance.length,
        stillActive: todaysAttendance.filter((a) => a.logoutTime === null).length,
      },
      totals: { ...team, productivityPercent: productivityPercent(team) },
    };
  }

  /** Employee list (spec §5): all staff with active/idle/productivity at a glance. */
  async getEmployeeRoster(startDate?: string, endDate?: string) {
    const { start, end } = resolveRange(startDate, endDate);
    const onlineSince = new Date(Date.now() - ONLINE_WINDOW_MS);

    const [totals, employees] = await Promise.all([
      this.totalsByEmployee(start, end),
      prisma.employee.findMany({
        where: { status: { not: 'placeholder' } },
        orderBy: { name: 'asc' },
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

  /**
   * Employee detail (spec §5): first page of the timeline, active-vs-idle split, top apps and
   * domains for the range. Defaults to today when no range is given.
   *
   * The timeline is one page, not the whole range. It used to `take: 2000` and hand the lot to
   * the browser, which is both an unbounded read as history grows and 2,000 rows rendered into a
   * page nobody scrolls to the end of. The UI now shows a fixed-height window and asks for the
   * next page when the operator reaches the bottom — see getActivityLog.
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
    if (!employee) throw { statusCode: 404, message: 'Employee not found' };

    const { start, end } = startDate || endDate
      ? resolveRange(startDate, endDate)
      : { start: startOfUtcDay(new Date()), end: new Date() };

    const deviceIds = employee.devices.map((d) => d.id);
    if (deviceIds.length === 0) {
      return {
        employee,
        period: { start, end },
        totals: { ...emptyTotals(), productivityPercent: 0 },
        timeline: { rows: [], nextCursor: null, hasMore: false },
        topApps: [],
        topDomains: [],
        attendance: [],
      };
    }

    const deviceScope = { deviceId: { in: deviceIds } };
    const inRange = { ...deviceScope, startTime: { gte: start, lte: end } };

    const [totalsByEmployee, timeline, appGroups, domainGroups, attendance] = await Promise.all([
      // Totals come from the rollup, not from the timeline page. Deriving them from whatever
      // rows happened to be on screen is how a "productivity %" silently becomes "productivity %
      // of the first fifty rows".
      this.totalsByEmployee(start, end, [employeeId]),
      this.getActivityLog(employeeId, { startDate, endDate }),
      prisma.activitySession.groupBy({
        by: ['appName', 'productivityTag'],
        where: { ...inRange, type: ActivityType.Application },
        _sum: { durationSeconds: true },
        orderBy: { _sum: { durationSeconds: 'desc' } },
        take: TOP_LIST_SIZE,
      }),
      prisma.browserActivity.groupBy({
        by: ['domain', 'productivityTag'],
        where: inRange,
        _sum: { durationSeconds: true },
        orderBy: { _sum: { durationSeconds: 'desc' } },
        take: TOP_LIST_SIZE,
      }),
      prisma.attendanceSession.findMany({
        where: { ...deviceScope, loginTime: { gte: start, lte: end } },
        orderBy: { loginTime: 'asc' },
        select: { sessionId: true, loginTime: true, logoutTime: true, endReason: true, workDate: true },
      }),
    ]);

    const totals = totalsByEmployee.get(employeeId) ?? emptyTotals();

    return {
      employee,
      period: { start, end },
      totals: { ...totals, productivityPercent: productivityPercent(totals) },
      timeline,
      topApps: appGroups.map((g) => ({
        appName: g.appName,
        productivityTag: g.productivityTag,
        seconds: g._sum.durationSeconds ?? 0,
      })),
      topDomains: domainGroups.map((g) => ({
        domain: g.domain,
        productivityTag: g.productivityTag,
        seconds: g._sum.durationSeconds ?? 0,
      })),
      attendance,
    };
  }

  // -------------------------------------------------------------------------
  // Log feeds.
  //
  // All three follow the same shape: newest first, one page, keyset cursor. The page size comes
  // from policy rather than a constant here, so an admin changes it from the settings screen.
  // A caller may ask for fewer rows than policy allows but never more — otherwise the bound is
  // decorative.
  // -------------------------------------------------------------------------

  /**
   * Activity timeline for one employee, newest first.
   *
   * Browser visits are attached to the app session that contained them, so the UI can expand a
   * "Chrome — 2h" row into the sites that made it up. They are fetched for the rows on *this
   * page* only — the whole point of paging is not to load the range.
   */
  async getActivityLog(
    employeeId: string,
    options: { startDate?: string; endDate?: string; cursor?: string; limit?: number } = {}
  ) {
    const { start, end } = options.startDate || options.endDate
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
        ...olderThan('startTime', cursor),
      },
      orderBy: newestFirst('startTime'),
      // One extra row, purely to answer "is there more?" without a second COUNT over the same
      // predicate — which on a log table costs as much as the page itself.
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
      orderBy: { startTime: 'asc' },
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
      rows: page.rows.map((r) => ({ ...r, visits: visitsBySession.get(r.activitySessionId) ?? [] })),
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
        ...olderThan('triggeredAt', cursor),
      },
      orderBy: newestFirst('triggeredAt'),
      take: pageSize + 1,
      include: {
        device: { select: { deviceName: true, employee: { select: { id: true, name: true } } } },
      },
    });

    return toPage(rows, pageSize, (r) => r.triggeredAt);
  }

  /** USB device audit trail (Features.md "USB Logs"). */
  async getUsbEvents(
    options: { startDate?: string; endDate?: string; cursor?: string; limit?: number } = {}
  ) {
    const { start, end } = resolveRange(options.startDate, options.endDate);

    const organizationId = await currentOrganizationId();
    const pageSize = await resolvePageSize(organizationId, options.limit);
    const cursor = decodeCursor(options.cursor);

    const rows = await prisma.usbEvent.findMany({
      where: {
        eventTime: { gte: start, lte: end },
        ...olderThan('eventTime', cursor),
      },
      orderBy: newestFirst('eventTime'),
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
   * Screenshot index for the employee detail screen (spec §5), newest first, one page at a time.
   *
   * Paged like the other log feeds rather than returning the range. Screenshots accumulate faster
   * than any other record here — one every few minutes per device, for every device the employee
   * has — so a fixed `take: 500` was both an arbitrary ceiling that silently hid older captures
   * and, at the same time, far more than the gallery shows before the operator scrolls. The grid
   * asks for the next page when it reaches the end, exactly as the timeline does.
   *
   * The bytes are not served from here: rows carry the identifiers the viewer route needs, and
   * each image is fetched (and audit-logged) individually when it is actually displayed.
   *
   * Page size comes from Policy.screenshotPageSize, NOT logPageSize. A page here is that many
   * JPEGs the browser downloads and decodes, not that many rows of JSON — see pagination.ts.
   */
  async getScreenshots(
    employeeId: string,
    options: { startDate?: string; endDate?: string; cursor?: string; limit?: number } = {}
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
        ...olderThan('capturedAt', cursor),
      },
      orderBy: newestFirst('capturedAt'),
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
