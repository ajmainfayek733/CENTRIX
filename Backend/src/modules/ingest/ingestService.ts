import { Prisma, ProductivityTag } from '@prisma/client';
import { prisma } from '../../config/db';
import { categoryService } from '../report/categoryService';
import { generateDeviceApiKey, hashDeviceApiKey, hashEnrollmentToken } from '../../utils/token';
import { persistScreenshot } from './screenshotStorage';
import { getOrCreatePolicy } from './policyService';
import type {
  ActivityMetricEventDto,
  ActivitySessionEventDto,
  AlertEventDto,
  AttendanceEventDto,
  BrowserActivityEventDto,
  Channel,
  ConsentDto,
  DeviceRegisterDto,
  ScreenshotFieldsDto,
  UsbEventDto,
} from './ingest.dto';

export interface DeviceContext {
  id: string;
  employeeId: string;
  organizationId: string;
  deviceId: string;
  deviceName: string;
}

export class IngestValidationError extends Error {
  statusCode = 400;
}

export class EnrollmentError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
  }
}

/**
 * Every write below is idempotent on a client-generated GUID, because the agent's offline
 * queue delivers at-least-once: a batch that was stored but whose HTTP response was lost gets
 * resent verbatim on the next sync. Insert-only channels use `skipDuplicates`; channels whose
 * rows legitimately change after first send (attendance, alerts) upsert instead.
 */
class IngestService {
  async pushEvents(device: DeviceContext, channel: Channel, events: unknown[]): Promise<string[]> {
    switch (channel) {
      case 'attendance':
        await this.saveAttendance(device, events as AttendanceEventDto[]);
        break;
      case 'activity-metric':
        await this.saveActivityMetrics(device, events as ActivityMetricEventDto[]);
        break;
      case 'activity-session':
        await this.saveActivitySessions(device, events as ActivitySessionEventDto[]);
        break;
      case 'browser-activity':
        await this.saveBrowserActivity(device, events as BrowserActivityEventDto[]);
        break;
      case 'usb-event':
        await this.saveUsbEvents(device, events as UsbEventDto[]);
        break;
      case 'alert':
        await this.saveAlerts(device, events as AlertEventDto[]);
        break;
    }

    // Atomic-batch contract: once the write above resolves, every row in this push is durably
    // stored — freshly inserted, or already present from an earlier partially-acked retry.
    return (events as Array<{ clientEventId: string }>).map((e) => e.clientEventId);
  }

  // -------------------------------------------------------------------------
  // Attendance — upsert on sessionId. The agent re-sends the row as logoutTime
  // firms up (lock → sleep → shutdown), so later writes must overwrite earlier ones.
  // -------------------------------------------------------------------------

  private async saveAttendance(device: DeviceContext, events: AttendanceEventDto[]) {
    await prisma.$transaction(
      events.map((e) => {
        const shared = {
          deviceId: device.id,
          userSid: e.userSid,
          loginTime: e.loginTime,
          logoutTime: e.logoutTime ?? null,
          endReason: e.endReason ?? null,
          workDate: new Date(`${e.workDate}T00:00:00.000Z`),
          totalActiveSeconds: e.totalActiveSeconds,
          totalIdleSeconds: e.totalIdleSeconds,
        };
        return prisma.attendanceSession.upsert({
          where: { sessionId: e.sessionId },
          create: { sessionId: e.sessionId, ...shared },
          update: shared,
        });
      })
    );
  }

  // -------------------------------------------------------------------------
  // Activity metric — insert-only counts. No content is accepted by the schema.
  // -------------------------------------------------------------------------

  private async saveActivityMetrics(device: DeviceContext, events: ActivityMetricEventDto[]) {
    const rows: Prisma.ActivityMetricCreateManyInput[] = events.map((e) => ({
      deviceId: device.id,
      sessionId: e.sessionId,
      clientEventId: e.clientEventId,
      keyCount: e.keyCount,
      mouseCount: e.mouseCount,
      mouseLeftKeyCount: e.mouseLeftKeyCount,
      mouseRightKeyCount: e.mouseRightKeyCount,
      mouseMiddleKeyCount: e.mouseMiddleKeyCount,
      mouseOtherKeyCount: e.mouseOtherKeyCount,
      windowStartUtc: e.windowStartUtc,
      windowEndUtc: e.windowEndUtc,
    }));

    await prisma.activityMetric.createMany({ data: rows, skipDuplicates: true });
  }

  // -------------------------------------------------------------------------
  // Activity sessions. The server re-derives ProductivityTag from the org's category
  // rules rather than trusting the agent's copy: the agent's rules can be a policy
  // version behind, and reports must be consistent with what the admin sees now.
  // The agent's tag is kept only when no rule matches.
  // -------------------------------------------------------------------------

  private async saveActivitySessions(device: DeviceContext, events: ActivitySessionEventDto[]) {
    const rows: Prisma.ActivitySessionCreateManyInput[] = [];

    for (const e of events) {
      const match = await categoryService.categorizeApp(
        device.organizationId,
        e.appName,
        e.processName,
        e.executablePath
      );

      rows.push({
        deviceId: device.id,
        sessionId: e.sessionId,
        activitySessionId: e.activitySessionId,
        appName: e.appName ?? null,
        processName: e.processName ?? null,
        executablePath: e.executablePath ?? null,
        type: e.type,
        windowTitle: e.windowTitle ?? null,
        startTime: e.startTime,
        endTime: e.endTime,
        durationSeconds: e.durationSeconds,
        reason: e.reason ?? null,
        productivityTag: match ? match.tag : (e.productivityTag as ProductivityTag),
      });
    }

    await prisma.activitySession.createMany({ data: rows, skipDuplicates: true });
  }

  // -------------------------------------------------------------------------
  // Browser activity. Same server-side re-categorization as activity sessions.
  //
  // activitySessionId is a foreign key to a row that may not have arrived yet — the
  // app session closes after the browser visit it contains. Unknown parents are nulled
  // rather than rejected, so an out-of-order batch is not lost.
  // -------------------------------------------------------------------------

  private async saveBrowserActivity(device: DeviceContext, events: BrowserActivityEventDto[]) {
    const referenced = [...new Set(events.map((e) => e.activitySessionId).filter((v): v is string => !!v))];
    const known = new Set(
      (
        await prisma.activitySession.findMany({
          where: { activitySessionId: { in: referenced } },
          select: { activitySessionId: true },
        })
      ).map((r) => r.activitySessionId)
    );

    const rows: Prisma.BrowserActivityCreateManyInput[] = [];
    for (const e of events) {
      const match = await categoryService.categorizeDomain(device.organizationId, e.domain);

      rows.push({
        deviceId: device.id,
        browserActivityId: e.browserActivityId,
        activitySessionId: e.activitySessionId && known.has(e.activitySessionId) ? e.activitySessionId : null,
        browser: e.browser,
        browserVersion: e.browserVersion ?? null,
        profileName: e.profileName ?? null,
        domain: e.domain.toLowerCase(),
        rawUrl: e.rawUrl,
        windowTitle: e.windowTitle ?? null,
        pageTitle: e.pageTitle ?? null,
        protocol: e.protocol,
        startTime: e.startTime,
        endTime: e.endTime,
        durationSeconds: e.durationSeconds,
        productivityTag: match ? match.tag : (e.productivityTag as ProductivityTag),
      });
    }

    await prisma.browserActivity.createMany({ data: rows, skipDuplicates: true });
  }

  // -------------------------------------------------------------------------
  // USB events — connection/removal metadata only, never contents.
  // -------------------------------------------------------------------------

  private async saveUsbEvents(device: DeviceContext, events: UsbEventDto[]) {
    // sessionId is a nullable FK onto attendance_sessions; null out ids we haven't seen
    // so a USB event that beat its attendance row to the server still lands.
    const referenced = [...new Set(events.map((e) => e.sessionId).filter((v): v is string => !!v))];
    const known = new Set(
      (
        await prisma.attendanceSession.findMany({
          where: { sessionId: { in: referenced } },
          select: { sessionId: true },
        })
      ).map((r) => r.sessionId)
    );

    const rows: Prisma.UsbEventCreateManyInput[] = events.map((e) => ({
      deviceId: device.id,
      sessionId: e.sessionId && known.has(e.sessionId) ? e.sessionId : null,
      clientEventId: e.clientEventId,
      eventType: e.eventType,
      deviceType: e.deviceType,
      friendlyName: e.friendlyName ?? null,
      manufacturer: e.manufacturer ?? null,
      model: e.model ?? null,
      serialNumber: e.serialNumber ?? null,
      vendorId: e.vendorId ?? null,
      productId: e.productId ?? null,
      driveLetter: e.driveLetter ?? null,
      volumeLabel: e.volumeLabel ?? null,
      capacityBytes: e.capacityBytes ?? null,
      fileSystem: e.fileSystem ?? null,
      eventTime: e.eventTime,
    }));

    await prisma.usbEvent.createMany({ data: rows, skipDuplicates: true });
  }

  // -------------------------------------------------------------------------
  // Alerts — upsert, because an escalating incident (idle 30 → 45 → 60 min)
  // reuses one clientEventId rather than creating a new row per escalation.
  // -------------------------------------------------------------------------

  private async saveAlerts(device: DeviceContext, events: AlertEventDto[]) {
    await prisma.$transaction(
      events.map((e) => {
        const shared = {
          deviceId: device.id,
          userSid: e.userSid,
          type: e.type,
          severity: e.severity,
          state: e.state,
          title: e.title,
          message: e.message,
          idleSeconds: e.idleSeconds ?? null,
          thresholdSeconds: e.thresholdSeconds ?? null,
          contextAppName: e.contextAppName ?? null,
          contextProcessName: e.contextProcessName ?? null,
          contextDomain: e.contextDomain ?? null,
          contextUrl: e.contextUrl ?? null,
          contextUsbSerialNumber: e.contextUsbSerialNumber ?? null,
          contextUsbFriendlyName: e.contextUsbFriendlyName ?? null,
          triggeredAt: e.triggeredAt,
          acknowledgedAt: e.acknowledgedAt ?? null,
          resolvedAt: e.resolvedAt ?? null,
          lastNotifiedAt: e.lastNotifiedAt ?? null,
          escalationLevel: e.escalationLevel,
          notificationCount: e.notificationCount,
        };
        return prisma.alert.upsert({
          where: { clientEventId: e.clientEventId },
          create: { clientEventId: e.clientEventId, ...shared },
          update: shared,
        });
      })
    );
  }

  // -------------------------------------------------------------------------
  // Policy / consent / screenshots
  // -------------------------------------------------------------------------

  /** GET /api/v1/policy — always the full document, never a diff. */
  async getPolicy(organizationId: string) {
    return getOrCreatePolicy(organizationId);
  }

  /** POST /api/v1/consent — idempotent on (device, userSid, policyVersion). */
  async recordConsent(device: DeviceContext, dto: ConsentDto) {
    return prisma.consentRecord.upsert({
      where: {
        deviceId_userSid_policyVersion: {
          deviceId: device.id,
          userSid: dto.userSid,
          policyVersion: dto.policyVersion,
        },
      },
      create: {
        deviceId: device.id,
        userSid: dto.userSid,
        policyVersion: dto.policyVersion,
        acknowledgedAt: dto.acknowledgedAt,
      },
      update: {},
    });
  }

  /** POST /api/v1/screenshots — idempotent on clientEventId: overwrite, not append. */
  async storeScreenshot(device: DeviceContext, fields: ScreenshotFieldsDto, tempFilePath: string) {
    const { storagePath, sizeBytes } = await persistScreenshot(device.id, fields.clientEventId, tempFilePath);

    const shared = {
      deviceId: device.id,
      userSid: fields.userSid ?? null,
      capturedAt: fields.capturedAtUtc,
      storagePath,
      sizeBytes,
      width: fields.width ?? null,
      height: fields.height ?? null,
    };

    const row = await prisma.screenshot.upsert({
      where: { clientEventId: fields.clientEventId },
      create: { clientEventId: fields.clientEventId, ...shared },
      update: shared,
    });

    return { screenshotId: row.id };
  }

  // -------------------------------------------------------------------------
  // Device enrollment — Features.md "Device Auth".
  //
  // Trades the install-time org enrollment token for a per-device API key. The MAC address
  // is recorded as Features.md asks, but identity is keyed on the Windows MachineGuid:
  // MAC is spoofable and multi-NIC machines report several, so it is metadata, not a key.
  // -------------------------------------------------------------------------

  async enrollDevice(enrollmentToken: string, dto: DeviceRegisterDto) {
    const organization = await prisma.organization.findUnique({
      where: { enrollmentTokenHash: hashEnrollmentToken(enrollmentToken) },
    });
    if (!organization) {
      throw new EnrollmentError('Invalid enrollment token', 401);
    }

    const existing = await prisma.device.findUnique({ where: { deviceId: dto.deviceId } });

    if (existing && !existing.isActive) {
      throw new EnrollmentError('Device has been deactivated by an administrator', 403);
    }

    // A device that re-enrolls (agent reinstalled, key file lost) gets a fresh key. That is
    // safe because presenting the enrollment token is already an install-time privileged act,
    // and it means a rebuilt workstation recovers without an admin touching the dashboard.
    const apiKey = generateDeviceApiKey();
    const apiKeyHash = hashDeviceApiKey(apiKey);

    const profile = {
      deviceName: dto.deviceName,
      systemType: dto.systemType ?? null,
      edition: dto.edition ?? null,
      version: dto.version ?? null,
      macAddress: dto.macAddress,
      agentVersion: dto.agentVersion ?? null,
      lastSeen: new Date(),
    };

    if (existing) {
      const updated = await prisma.device.update({
        where: { id: existing.id },
        data: { ...profile, apiKeyHash },
      });
      return { apiKey, deviceId: updated.id, employeeId: updated.employeeId, enrolled: false };
    }

    // First contact from an unknown workstation. It has no employee yet, so it is parked on
    // an "Unassigned" placeholder employee and shows up in the dashboard for an admin to
    // assign. Rejecting it instead would mean no telemetry until someone notices the device.
    const placeholder = await this.unassignedEmployee(organization.id);

    const created = await prisma.device.create({
      data: {
        organizationId: organization.id,
        employeeId: placeholder.id,
        deviceId: dto.deviceId,
        apiKeyHash,
        ...profile,
      },
    });

    return { apiKey, deviceId: created.id, employeeId: created.employeeId, enrolled: true };
  }

  private async unassignedEmployee(organizationId: string) {
    const email = `unassigned+${organizationId}@local.invalid`;
    return prisma.employee.upsert({
      where: { email },
      create: {
        organizationId,
        email,
        name: 'Unassigned Devices',
        department: null,
        status: 'placeholder',
      },
      update: {},
    });
  }

  /**
   * GET /api/v1/heartbeat — Features.md "Device Auth". The agent must pass this before it
   * starts syncing, so it doubles as a check that the credential is still valid and a cheap
   * way for the agent to learn the current policy version without pulling the whole document.
   */
  async heartbeat(device: DeviceContext) {
    const policy = await prisma.policy.findUnique({
      where: { organizationId: device.organizationId },
      select: { version: true },
    });

    return {
      authenticated: true,
      deviceId: device.deviceId,
      policyVersion: policy?.version ?? 1,
      serverTimeUtc: new Date().toISOString(),
    };
  }
}

export const ingestService = new IngestService();
