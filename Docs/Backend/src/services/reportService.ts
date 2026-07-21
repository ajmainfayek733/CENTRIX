import { prisma } from '../config/db';
import { categoryService } from './categoryService';

export class ReportService {
  async getTeamSummary(startDate?: string, endDate?: string) {
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    const logs = await prisma.activityLog.findMany({
      where: {
        capturedAt: {
          gte: start,
          lte: end,
        },
      },
      include: {
        device: {
          include: {
            employee: true,
          },
        },
      },
    });

    let totalActiveCount = 0;
    let totalIdleCount = 0;

    for (const log of logs) {
      if (log.isIdle) {
        totalIdleCount++;
      } else {
        totalActiveCount++;
      }
    }

    return {
      period: { start, end },
      totalLogs: logs.length,
      totalActiveCount,
      totalIdleCount,
      employeesTracked: new Set(logs.map((l) => l.device.employeeId)).size,
    };
  }

  async getEmployeeTimeline(employeeId: string, dateStr?: string) {
    const targetDate = dateStr ? new Date(dateStr) : new Date();
    const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
    const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));

    const devices = await prisma.device.findMany({
      where: { employeeId },
      select: { id: true },
    });

    const deviceIds = devices.map((d) => d.id);

    const logs = await prisma.activityLog.findMany({
      where: {
        deviceId: { in: deviceIds },
        capturedAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      orderBy: { capturedAt: 'asc' },
    });

    const categorizedTimeline = await Promise.all(
      logs.map(async (log) => ({
        id: log.id,
        deviceId: log.deviceId,
        appName: log.appName,
        windowTitle: log.windowTitle,
        domain: log.domain,
        isIdle: log.isIdle,
        capturedAt: log.capturedAt,
        category: await categoryService.categorizeActivity(log.appName, log.domain),
      }))
    );

    return {
      employeeId,
      date: startOfDay,
      totalEntries: logs.length,
      timeline: categorizedTimeline,
    };
  }
}

export const reportService = new ReportService();
