import { ActivityType, Prisma, ProductivityTag } from '@prisma/client';
import { prisma } from '../../config/db';

/**
 * Dashboard read path (spec §5). Every query here reads the typed telemetry tables directly —
 * there is no blob to unpack, so aggregation happens in Postgres via groupBy rather than by
 * pulling rows into Node and reducing them.
 */

/** Foreground work. Everything else is time the employee was not at the keyboard. */
const ACTIVE_TYPES: ActivityType[] = [ActivityType.Application, ActivityType.Desktop];
const IDLE_TYPES: ActivityType[] = [
  ActivityType.Idle,
  ActivityType.Locked,
  ActivityType.Sleeping,
  ActivityType.Disconnected,
];

/** A device seen within this window counts as "online now" on the overview screen. */
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

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
   * Rolls activity_sessions up per employee for a date range. Grouped by (device, type, tag)
   * in Postgres, then folded onto employees in one pass — one query regardless of headcount.
   */
  private async totalsByEmployee(where: Prisma.ActivitySessionWhereInput) {
    // Kept as separate awaits rather than a Promise.all tuple: groupBy's return type is
    // generic enough that tuple destructuring widens the sibling findMany to `unknown`.
    const grouped = await prisma.activitySession.groupBy({
      by: ['deviceId', 'type', 'productivityTag'],
      where,
      _sum: { durationSeconds: true },
    });
    const devices = await prisma.device.findMany({ select: { id: true, employeeId: true } });

    const employeeByDevice = new Map<string, string>();
    for (const d of devices) employeeByDevice.set(d.id, d.employeeId);

    const totals = new Map<string, Totals>();

    for (const row of grouped) {
      const employeeId = employeeByDevice.get(row.deviceId);
      if (!employeeId) continue;

      const seconds = row._sum.durationSeconds ?? 0;
      const t = totals.get(employeeId) ?? emptyTotals();

      if (ACTIVE_TYPES.includes(row.type)) {
        t.activeSeconds += seconds;
        switch (row.productivityTag) {
          case ProductivityTag.Productive:
            t.productiveSeconds += seconds;
            break;
          case ProductivityTag.Unproductive:
            t.unproductiveSeconds += seconds;
            break;
          case ProductivityTag.Blacklisted:
            t.blacklistedSeconds += seconds;
            break;
          default:
            t.neutralSeconds += seconds;
        }
      } else if (IDLE_TYPES.includes(row.type)) {
        t.idleSeconds += seconds;
      }

      totals.set(employeeId, t);
    }

    return totals;
  }

  /** Overview screen (spec §5): team-wide active time, productivity, who's online, attendance. */
  async getOverview(startDate?: string, endDate?: string) {
    const { start, end } = resolveRange(startDate, endDate);
    const onlineSince = new Date(Date.now() - ONLINE_WINDOW_MS);
    const today = startOfUtcDay(new Date());

    const [totals, employees, onlineDevices, todaysAttendance, openAlerts] = await Promise.all([
      this.totalsByEmployee({ startTime: { gte: start, lte: end } }),
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
      this.totalsByEmployee({ startTime: { gte: start, lte: end } }),
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
   * Employee detail (spec §5): timeline of apps/sites, active-vs-idle split, top apps and
   * domains for the range. Defaults to today when no range is given.
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
      return { employee, period: { start, end }, totals: { ...emptyTotals(), productivityPercent: 0 }, timeline: [], topApps: [], topDomains: [], attendance: [] };
    }

    const deviceScope = { deviceId: { in: deviceIds } };
    const inRange = { ...deviceScope, startTime: { gte: start, lte: end } };

    const [sessions, browserRows, appGroups, domainGroups, attendance] = await Promise.all([
      prisma.activitySession.findMany({
        where: inRange,
        orderBy: { startTime: 'asc' },
        take: 2000,
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
      }),
      prisma.browserActivity.findMany({
        where: inRange,
        orderBy: { startTime: 'asc' },
        take: 2000,
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
      }),
      prisma.activitySession.groupBy({
        by: ['appName', 'productivityTag'],
        where: { ...inRange, type: ActivityType.Application },
        _sum: { durationSeconds: true },
        orderBy: { _sum: { durationSeconds: 'desc' } },
        take: 15,
      }),
      prisma.browserActivity.groupBy({
        by: ['domain', 'productivityTag'],
        where: inRange,
        _sum: { durationSeconds: true },
        orderBy: { _sum: { durationSeconds: 'desc' } },
        take: 15,
      }),
      prisma.attendanceSession.findMany({
        where: { ...deviceScope, loginTime: { gte: start, lte: end } },
        orderBy: { loginTime: 'asc' },
        select: { sessionId: true, loginTime: true, logoutTime: true, endReason: true, workDate: true },
      }),
    ]);

    const totals = emptyTotals();
    for (const s of sessions) {
      if (ACTIVE_TYPES.includes(s.type)) {
        totals.activeSeconds += s.durationSeconds;
        if (s.productivityTag === ProductivityTag.Productive) totals.productiveSeconds += s.durationSeconds;
        else if (s.productivityTag === ProductivityTag.Unproductive) totals.unproductiveSeconds += s.durationSeconds;
        else if (s.productivityTag === ProductivityTag.Blacklisted) totals.blacklistedSeconds += s.durationSeconds;
        else totals.neutralSeconds += s.durationSeconds;
      } else if (IDLE_TYPES.includes(s.type)) {
        totals.idleSeconds += s.durationSeconds;
      }
    }

    // Browser visits are nested under the app session that contained them, so the UI can
    // expand a "Chrome — 2h" row into the sites that made it up.
    const visitsBySession = new Map<string, typeof browserRows>();
    for (const row of browserRows) {
      if (!row.activitySessionId) continue;
      const list = visitsBySession.get(row.activitySessionId);
      if (list) list.push(row);
      else visitsBySession.set(row.activitySessionId, [row]);
    }

    return {
      employee,
      period: { start, end },
      totals: { ...totals, productivityPercent: productivityPercent(totals) },
      timeline: sessions.map((s) => ({ ...s, visits: visitsBySession.get(s.activitySessionId) ?? [] })),
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

  /** Alert feed (Features.md "Alert Notification") for the dashboard. */
  async getAlerts(limit = 100, includeResolved = false) {
    const alerts = await prisma.alert.findMany({
      where: includeResolved ? {} : { resolvedAt: null },
      orderBy: { triggeredAt: 'desc' },
      take: Math.min(limit, 500),
      include: {
        device: { select: { deviceName: true, employee: { select: { id: true, name: true } } } },
      },
    });

    return { alerts };
  }

  /** USB device audit trail (Features.md "USB Logs"). */
  async getUsbEvents(startDate?: string, endDate?: string, limit = 200) {
    const { start, end } = resolveRange(startDate, endDate);

    const events = await prisma.usbEvent.findMany({
      where: { eventTime: { gte: start, lte: end } },
      orderBy: { eventTime: 'desc' },
      take: Math.min(limit, 1000),
      include: {
        device: { select: { deviceName: true, employee: { select: { id: true, name: true } } } },
      },
    });

    // capacityBytes is a BigInt column; JSON.stringify throws on BigInt, so it is serialized
    // as a decimal string on the way out rather than silently losing precision as a Number.
    return {
      period: { start, end },
      events: events.map((e) => ({ ...e, capacityBytes: e.capacityBytes?.toString() ?? null })),
    };
  }

  /** Screenshot index for the employee detail screen (spec §5). */
  async getScreenshots(employeeId: string, startDate?: string, endDate?: string) {
    const { start, end } = resolveRange(startDate, endDate);
    const devices = await prisma.device.findMany({ where: { employeeId }, select: { id: true } });

    const screenshots = await prisma.screenshot.findMany({
      where: { deviceId: { in: devices.map((d) => d.id) }, capturedAt: { gte: start, lte: end } },
      orderBy: { capturedAt: 'desc' },
      take: 500,
      select: { id: true, deviceId: true, clientEventId: true, capturedAt: true, width: true, height: true },
    });

    return { period: { start, end }, screenshots };
  }
}

export const reportService = new ReportService();
