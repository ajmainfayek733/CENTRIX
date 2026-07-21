import { prisma } from '../config/db';
import { RawSampleDto } from '../dtos/ingest.dto';

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
}

export const ingestService = new IngestService();
