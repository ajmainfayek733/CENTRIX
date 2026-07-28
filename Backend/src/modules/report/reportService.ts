import { TelemetryChannel } from '@prisma/client';
import { prisma } from '../../config/db';
import { categoryService } from './categoryService';
import { AttendanceRawEvent, buildDailyAttendanceSummaries } from './attendanceEngine';

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export class ReportService {
  /** Backs the authenticated dashboard read path that Screenshot.remoteUri points at (spec §4.3/§6). */
  async getScreenshotPath(deviceId: string, clientEventId: string) {
    const screenshot = await prisma.screenshot.findUnique({ where: { clientEventId } });
    if (!screenshot || screenshot.deviceId !== deviceId) {
      throw { statusCode: 404, message: 'Screenshot not found' };
    }
    return screenshot.storagePath;
  }

  async getTeamSummary(startDate?: string, endDate?: string) {
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    // Attendance sessions can straddle the requested window, so pull a day of buffer on each
    // side before splitting at UTC midnight (see attendanceEngine.ts) and filtering back down.
    const attendanceEvents = await prisma.telemetryEvent.findMany({
      where: {
        channel: TelemetryChannel.attendance,
        occurredAtUtc: { gte: new Date(start.getTime() - 86400_000), lte: new Date(end.getTime() + 86400_000) },
      },
      include: { device: { select: { employeeId: true } } },
      orderBy: { occurredAtUtc: 'asc' },
    });

    const rawByEmployee = new Map<string, AttendanceRawEvent[]>();
    for (const evt of attendanceEvents) {
      const payload = evt.payload as any;
      const raw: AttendanceRawEvent = {
        clientEventId: evt.clientEventId,
        sessionId: payload.SessionId,
        userSid: evt.userSid,
        machineId: evt.machineId,
        eventType: payload.EventType,
        occurredAtUtc: evt.occurredAtUtc,
      };
      const list = rawByEmployee.get(evt.device.employeeId);
      if (list) list.push(raw);
      else rawByEmployee.set(evt.device.employeeId, [raw]);
    }

    const now = new Date();
    let totalActiveSeconds = 0;
    const perEmployee: Array<{ employeeId: string; activeSeconds: number; days: number }> = [];

    for (const [employeeId, events] of rawByEmployee) {
      const summaries = buildDailyAttendanceSummaries(events, now).filter(
        (s) => new Date(s.dateUtc) >= startOfUtcDay(start) && new Date(s.dateUtc) <= end
      );
      const activeSeconds = summaries.reduce((sum, s) => sum + s.activeSeconds, 0);
      totalActiveSeconds += activeSeconds;
      perEmployee.push({ employeeId, activeSeconds, days: summaries.length });
    }

    // Active-vs-idle mix from Active vs Idle module sessions (spec §4.1.3), by wall-clock
    // duration rather than raw sample counts — a more meaningful ratio than counting rows.
    const activitySessions = await prisma.telemetryEvent.findMany({
      where: {
        channel: TelemetryChannel.activity_session,
        occurredAtUtc: { gte: start, lte: end },
      },
      select: { payload: true },
    });

    const secondsByState: Record<string, number> = {};
    for (const evt of activitySessions) {
      const payload = evt.payload as any;
      const durationSeconds = (new Date(payload.EndTimeUtc).getTime() - new Date(payload.StartTimeUtc).getTime()) / 1000;
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) continue;
      secondsByState[payload.State] = (secondsByState[payload.State] || 0) + durationSeconds;
    }

    return {
      period: { start, end },
      employeesTracked: perEmployee.length,
      totalActiveSeconds,
      perEmployee,
      activityStateBreakdownSeconds: secondsByState,
    };
  }

  async getEmployeeTimeline(employeeId: string, dateStr?: string) {
    const targetDate = dateStr ? new Date(dateStr) : new Date();
    const startOfDay = startOfUtcDay(targetDate);
    const endOfDay = new Date(startOfDay.getTime() + 86400_000);

    const devices = await prisma.device.findMany({
      where: { employeeId },
      select: { id: true },
    });
    const deviceIds = devices.map((d) => d.id);

    // App Sessions are only synced once closed (spec §4.1.2), so EndTimeUtc — not
    // OccurredAtUtc, which this channel has none of — is what's indexed and filtered on here.
    const events = await prisma.telemetryEvent.findMany({
      where: {
        channel: TelemetryChannel.app_session,
        deviceId: { in: deviceIds },
        occurredAtUtc: { gte: startOfDay, lt: endOfDay },
      },
      orderBy: { occurredAtUtc: 'asc' },
    });

    const timeline = await Promise.all(
      events.map(async (evt) => {
        const payload = evt.payload as any;
        const category = payload.ProductivityTag
          ? payload.ProductivityTag
          : await categoryService.categorizeActivity(payload.Executable, null);

        return {
          id: evt.id,
          deviceId: evt.deviceId,
          kind: payload.Kind,
          executable: payload.Executable,
          windowTitle: payload.WindowTitle,
          startTimeUtc: payload.StartTimeUtc,
          endTimeUtc: payload.EndTimeUtc,
          category,
        };
      })
    );

    return {
      employeeId,
      date: startOfDay,
      totalEntries: timeline.length,
      timeline,
    };
  }
}

export const reportService = new ReportService();
