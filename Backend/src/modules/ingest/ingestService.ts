import { Prisma, TelemetryChannel } from '@prisma/client';
import { prisma } from '../../config/db';
import { DEFAULT_POLICY_DOCUMENT } from './defaultPolicy';
import { alertPayloadSchema, commonPayloadSchema, Channel, ConsentDto, PushEventItemDto } from './ingest.dto';
import { buildRemoteUri, persistScreenshot } from './screenshotStorage';

interface DeviceContext {
  id: string;
  employeeId: string;
  organizationId: string;
  machineId: string;
}

const CHANNEL_TO_ENUM: Record<string, TelemetryChannel> = {
  attendance: TelemetryChannel.attendance,
  'app-session': TelemetryChannel.app_session,
  'activity-session': TelemetryChannel.activity_session,
  'browser-navigation': TelemetryChannel.browser_navigation,
  'usb-device': TelemetryChannel.usb_device,
};

// Per spec §4.1.1-§4.1.5: attendance/browser-navigation/usb-device stamp OccurredAtUtc directly;
// app-session/activity-session are only synced once closed, so EndTimeUtc is the meaningful
// "when did this happen" timestamp for reporting/indexing purposes.
const TIMESTAMP_FIELD_BY_CHANNEL: Record<string, string> = {
  attendance: 'OccurredAtUtc',
  'browser-navigation': 'OccurredAtUtc',
  'usb-device': 'OccurredAtUtc',
  'app-session': 'EndTimeUtc',
  'activity-session': 'EndTimeUtc',
};

export class IngestValidationError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
  }
}

class IngestService {
  /**
   * POST /api/v1/events/{channel} (spec §4.1). Validates and parses the whole batch up front so
   * a bad row fails the entire push atomically (spec §3.3) before anything is written. Dedup is
   * per (channel, clientEventId) via a unique constraint + skipDuplicates, so retried batches
   * that partially landed are safe to resend verbatim (spec §3.2).
   */
  async pushEvents(device: DeviceContext, channel: Channel, items: PushEventItemDto[]): Promise<string[]> {
    if (channel === 'alert') {
      return this.upsertAlerts(device, items);
    }
    return this.insertTelemetryEvents(device, channel, items);
  }

  private async insertTelemetryEvents(device: DeviceContext, channel: Channel, items: PushEventItemDto[]): Promise<string[]> {
    const timestampField = TIMESTAMP_FIELD_BY_CHANNEL[channel];
    const enumChannel = CHANNEL_TO_ENUM[channel];

    const rows: Prisma.TelemetryEventCreateManyInput[] = items.map((item) => {
      const payload = parsePayload(item.payloadJson);
      const parsed = commonPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw new IngestValidationError(
          `event ${item.clientEventId}: ${parsed.error.issues.map((i) => i.message).join('; ')}`
        );
      }

      const occurredAtRaw = payload[timestampField];
      const occurredAtUtc = occurredAtRaw ? new Date(occurredAtRaw) : null;
      if (!occurredAtUtc || Number.isNaN(occurredAtUtc.getTime())) {
        throw new IngestValidationError(`event ${item.clientEventId}: payload.${timestampField} is missing or not a valid timestamp`);
      }

      return {
        channel: enumChannel,
        clientEventId: item.clientEventId,
        deviceId: device.id,
        // Trust boundary: MachineId is taken from the authenticated device, never from the
        // payload the device itself declares, so one device can't attribute events to another.
        machineId: device.machineId,
        userSid: parsed.data.UserSid,
        occurredAtUtc,
        payload,
      };
    });

    await prisma.telemetryEvent.createMany({ data: rows, skipDuplicates: true });

    // Atomic-batch contract (§3.3): once createMany succeeds, every row in this push is durably
    // stored (freshly inserted or already present from a prior retry) — ack the whole batch.
    return items.map((i) => i.clientEventId);
  }

  private async upsertAlerts(device: DeviceContext, items: PushEventItemDto[]): Promise<string[]> {
    const parsedAlerts = items.map((item) => {
      const payload = parsePayload(item.payloadJson);
      const parsed = alertPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw new IngestValidationError(
          `alert ${item.clientEventId}: ${parsed.error.issues.map((i) => i.message).join('; ')}`
        );
      }
      return { clientEventId: item.clientEventId, alert: parsed.data };
    });

    await prisma.$transaction(
      parsedAlerts.map(({ clientEventId, alert }) => {
        const shared = {
          deviceId: device.id,
          machineId: device.machineId,
          userSid: alert.UserSid,
          type: alert.Type,
          severity: alert.Severity,
          state: alert.State,
          title: alert.Title,
          message: alert.Message,
          contextJson: alert.ContextJson,
          triggeredAtUtc: new Date(alert.TriggeredAtUtc),
          acknowledgedAtUtc: alert.AcknowledgedAtUtc ? new Date(alert.AcknowledgedAtUtc) : null,
          resolvedAtUtc: alert.ResolvedAtUtc ? new Date(alert.ResolvedAtUtc) : null,
          lastNotifiedAtUtc: alert.LastNotifiedAtUtc ? new Date(alert.LastNotifiedAtUtc) : null,
          escalationLevel: alert.EscalationLevel,
          notificationCount: alert.NotificationCount,
        };

        // Same ClientEventId is reused across escalations of one incident (spec §4.1.6) — upsert
        // rather than insert-only.
        return prisma.alert.upsert({
          where: { clientEventId },
          create: { clientEventId, ...shared },
          update: shared,
        });
      })
    );

    return items.map((i) => i.clientEventId);
  }

  /** GET /api/v1/policy (spec §4.2) — always the full document, never a diff. */
  async getPolicy(organizationId: string) {
    const policy = await prisma.policy.upsert({
      where: { organizationId },
      create: { organizationId, version: 1, document: DEFAULT_POLICY_DOCUMENT },
      update: {},
    });

    return { Version: policy.version, ...(policy.document as object) };
  }

  /** POST /api/v1/consent (spec §8) — idempotent on (userSid, machineId, policyVersion). */
  async recordConsent(device: DeviceContext, dto: ConsentDto) {
    return prisma.consentRecord.upsert({
      where: {
        userSid_machineId_policyVersion: {
          userSid: dto.userSid,
          machineId: dto.machineId,
          policyVersion: dto.policyVersion,
        },
      },
      create: {
        deviceId: device.id,
        userSid: dto.userSid,
        machineId: dto.machineId,
        policyVersion: dto.policyVersion,
        acknowledgedAtUtc: new Date(dto.acknowledgedAtUtc),
      },
      update: {},
    });
  }

  /** POST /api/v1/screenshots (spec §4.3/§6). Idempotent on clientEventId: overwrite, not append. */
  async storeScreenshot(
    device: DeviceContext,
    fields: { clientEventId: string; capturedAtUtc: string },
    tempFilePath: string
  ) {
    const { storagePath, sizeBytes } = await persistScreenshot(device.id, fields.clientEventId, tempFilePath);
    const remoteUri = buildRemoteUri(device.id, fields.clientEventId);
    const capturedAtUtc = new Date(fields.capturedAtUtc);
    if (Number.isNaN(capturedAtUtc.getTime())) {
      throw new IngestValidationError('capturedAtUtc is not a valid timestamp');
    }

    await prisma.screenshot.upsert({
      where: { clientEventId: fields.clientEventId },
      create: {
        clientEventId: fields.clientEventId,
        deviceId: device.id,
        machineId: device.machineId,
        capturedAtUtc,
        storagePath,
        remoteUri,
        sizeBytes,
      },
      update: { capturedAtUtc, storagePath, remoteUri, sizeBytes },
    });

    return { remoteUri };
  }
}

function parsePayload(payloadJson: string): Record<string, any> {
  try {
    const parsed = JSON.parse(payloadJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('payloadJson must decode to a JSON object');
    }
    return parsed;
  } catch (err) {
    throw new IngestValidationError(`payloadJson is not valid JSON: ${(err as Error).message}`);
  }
}

export const ingestService = new IngestService();
