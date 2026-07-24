import { prisma } from '../../config/db';
import { RawSampleDto } from './ingest.dto';

export class IngestService {
  /**
   * Ingest a batch of activity log samples from an authenticated Windows Agent device.
   * Enforces transaction-level idempotency via IngestBatch ledger.
   */
  async ingestBatch(deviceId: string, idempotencyKey: string, samples: RawSampleDto[]) {
    return prisma.$transaction(async (tx) => {
      // 1. Idempotency Check
      const existingBatch = await tx.ingestBatch.findUnique({
        where: { idempotencyKey },
      });

      if (existingBatch) {
        return {
          alreadyProcessed: true,
          message: 'Batch was already processed successfully',
          insertedCount: 0,
        };
      }

      // 2. Insert Activity Logs
      await tx.activityLog.createMany({
        data: samples.map((sample) => ({
          deviceId,
          appName: sample.appName || null,
          windowTitle: sample.windowTitle || null,
          domain: sample.domain || null,
          isIdle: sample.isIdle,
          capturedAt: sample.capturedAt,
        })),
      });

      // 3. Create Idempotency Ledger record
      await tx.ingestBatch.create({
        data: {
          idempotencyKey,
          deviceId,
        },
      });

      // 4. Update Device lastSeen timestamp
      await tx.device.update({
        where: { id: deviceId },
        data: { lastSeen: new Date() },
      });

      return {
        alreadyProcessed: false,
        message: 'Batch processed successfully',
        insertedCount: samples.length,
      };
    });
  }

  /**
   * Ingest a batch of telemetry data (ActivityLogs, AttendanceRecords, etc.) from an agent.
   * Enforces transaction-level idempotency and upserts attendance.
   */
  async ingestAgentBatch(
    deviceId: string,
    employeeId: string,
    idempotencyKey: string,
    data: {
      ActivityLogs: any[];
      AttendanceRecords: any[];
    }
  ) {
    return prisma.$transaction(async (tx) => {
      // 1. Idempotency Check
      const existingBatch = await tx.ingestBatch.findUnique({
        where: { idempotencyKey },
      });

      if (existingBatch) {
        return {
          alreadyProcessed: true,
          message: 'Batch was already processed successfully',
        };
      }

      // 2. Insert Activity Logs
      if (data.ActivityLogs && data.ActivityLogs.length > 0) {
        await tx.activityLog.createMany({
          data: data.ActivityLogs.map((log) => ({
            deviceId,
            appName: log.AppName || null,
            windowTitle: log.WindowTitle || null,
            domain: log.Domain || null,
            isIdle: log.IsIdle,
            capturedAt: log.CapturedAt,
          })),
        });
      }

      // 3. Upsert Attendance Records
      if (data.AttendanceRecords && data.AttendanceRecords.length > 0) {
        for (const record of data.AttendanceRecords) {
          const recordDate = new Date(record.Date);
          await tx.attendance.upsert({
            where: {
              employeeId_date: {
                employeeId,
                date: recordDate,
              },
            },
            create: {
              employeeId,
              date: recordDate,
              firstLogin: record.FirstLogin,
              lastLogout: record.LastLogout || null,
              totalActiveSeconds: record.TotalActiveSeconds,
            },
            update: {
              firstLogin: record.FirstLogin,
              lastLogout: record.LastLogout || null,
              totalActiveSeconds: record.TotalActiveSeconds,
            },
          });
        }
      }

      // 4. Create Idempotency Ledger record
      await tx.ingestBatch.create({
        data: {
          idempotencyKey,
          deviceId,
        },
      });

      // 5. Update Device lastSeen timestamp
      await tx.device.update({
        where: { id: deviceId },
        data: { lastSeen: new Date() },
      });

      return {
        alreadyProcessed: false,
        message: 'batch accepted',
      };
    });
  }
}

export const ingestService = new IngestService();
