import { createHash } from "crypto";
import { ActivityType, LogoutSource, Prisma, ProductivityTag } from "@prisma/client";
import { prisma } from "../../config/db";
import { env } from "../../config/env";
import { categoryService } from "../report/categoryService";
import { generateDeviceApiKey, hashDeviceApiKey, hashEnrollmentToken } from "../../utils/token";
import { persistScreenshot } from "./screenshotStorage";
import { getOrCreatePolicy } from "./policyService";
import { RollupAccumulator, applyRollup, utcWorkDate } from "./rollupService";
import { broadcastTelemetryIngested } from "../../realtime";
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
} from "./ingest.dto";

/** Retention windows are configured in days; this is the only place they become milliseconds. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
    public statusCode: number,
  ) {
    super(message);
  }
}

/** What a push did, so the controller can answer the agent and log honestly. */
export interface PushOutcome {
  /** Ids now durably stored - freshly written or already present. */
  acknowledged: string[];
  /** True when the whole batch was recognized as a replay and no work was redone. */
  replay: boolean;
}

/**
 * Everything a channel needs to write, resolved *before* the transaction opens.
 *
 * Splitting preparation from writing is the difference between a transaction that holds locks
 * for the duration of several category lookups and one that holds them only for the inserts.
 * With 100 agents syncing on the same interval that gap is the difference between contention and
 * none.
 */
interface PreparedBatch {
  /** Only the events not already stored. These are what the rollup may count. */
  newEventIds: string[];
  write: (tx: Prisma.TransactionClient) => Promise<void>;
  accumulator: RollupAccumulator;
}

/**
 * Two layers of idempotency, because the agent's queue is at-least-once and a batch that was
 * committed but whose HTTP response was lost is resent verbatim:
 *
 *   1. Per batch (ingest_batches). A batchId already recorded, carrying the same event ids, is
 *      answered from the ledger without touching the telemetry tables at all. This is the layer
 *      that matters when a fleet reconnects after an outage and replays at once.
 *
 *   2. Per event (unique clientEventId). Still the backstop for an agent that predates batch
 *      ids, or one whose retry repacked events into a different batch.
 *
 * Layer 2 is also what makes the daily rollup exact: counters are incremented rather than
 * recomputed, so an event that was already stored must contribute nothing. Every prepare step
 * below filters against the ids already present and counts only what it genuinely inserts.
 */
class IngestService {
  async pushEvents(
    device: DeviceContext,
    channel: Channel,
    batchId: string | undefined,
    events: unknown[],
  ): Promise<PushOutcome> {
    const eventIds = (events as Array<{ clientEventId: string }>).map((e) => e.clientEventId);
    const eventIdsHash = hashEventIds(eventIds);

    // -- Layer 1: has this exact batch already landed? ----------------------
    let ledgerBatchId = batchId;

    if (ledgerBatchId) {
      const existing = await prisma.ingestBatch.findUnique({
        where: { deviceId_batchId: { deviceId: device.id, batchId: ledgerBatchId } },
        select: { eventIdsHash: true },
      });

      if (existing?.eventIdsHash === eventIdsHash) {
        return { acknowledged: eventIds, replay: true };
      }

      if (existing) {
        // Same id, different payload. Trusting the ledger here would silently discard real
        // telemetry, so the batch is processed on its merits and the ledger row is left alone -
        // per-event deduplication still guarantees correctness, it is just the slower path.
        console.warn(
          `ingest: device ${device.deviceId} reused batch ${ledgerBatchId} with different contents; ` +
            "falling back to per-event deduplication",
        );
        ledgerBatchId = undefined;
      }
    }

    const prepared = await this.prepare(device, channel, events);

    await prisma.$transaction(
      async (tx) => {
        await prepared.write(tx);

        // The rollup commits with the rows that produced it. Were they separable, a crash
        // between them would leave a day permanently miscounted with nothing to detect it.
        await applyRollup(
          tx,
          {
            organizationId: device.organizationId,
            employeeId: device.employeeId,
            deviceId: device.id,
          },
          prepared.accumulator,
        );

        // Written last and inside the same transaction, so the ledger can never claim a batch
        // that did not land.
        if (ledgerBatchId) {
          await tx.ingestBatch.create({
            data: {
              deviceId: device.id,
              batchId: ledgerBatchId,
              channel,
              eventCount: eventIds.length,
              eventIdsHash,
            },
          });
        }
      },
      { timeout: env.INGEST_TRANSACTION_TIMEOUT_MS },
    );

    // Sent only after the commit, and carrying the aggregate this batch just produced so
    // dashboards can move their totals without querying anything. The work was done once here;
    // making every viewer recompute it was the cost this replaces.
    //
    // A failure here cannot fail the ingest - the data is already durable, and the worst case is
    // a dashboard whose numbers wait for its next refresh.
    broadcastTelemetryIngested(device.organizationId, {
      deviceId: device.id,
      employeeId: device.employeeId,
      channel,
      workDates: prepared.accumulator.dates(),
      eventCount: prepared.newEventIds.length,
      delta: prepared.accumulator.total(),
    });

    // Atomic-batch contract: once the write above resolves, every row in this push is durably
    // stored - freshly inserted, or already present from an earlier partially-acked retry.
    return { acknowledged: eventIds, replay: false };
  }

  private prepare(
    device: DeviceContext,
    channel: Channel,
    events: unknown[],
  ): Promise<PreparedBatch> {
    switch (channel) {
      case "attendance":
        return this.prepareAttendance(device, events as AttendanceEventDto[]);
      case "activity-metric":
        return this.prepareActivityMetrics(device, events as ActivityMetricEventDto[]);
      case "activity-session":
        return this.prepareActivitySessions(device, events as ActivitySessionEventDto[]);
      case "browser-activity":
        return this.prepareBrowserActivity(device, events as BrowserActivityEventDto[]);
      case "usb-event":
        return this.prepareUsbEvents(device, events as UsbEventDto[]);
      case "alert":
        return this.prepareAlerts(device, events as AlertEventDto[]);
    }
  }

  // -------------------------------------------------------------------------
  // Work-date attribution.
  //
  // The rollup is keyed on the employee's local calendar date, which only the workstation knows
  // - a fleet spanning timezones would otherwise have days that start at the server's midnight.
  // Attendance carries that date, so telemetry that references an attendance session inherits
  // it. Everything else falls back to the UTC date of its own timestamp, which is correct for a
  // single-timezone office and never worse than guessing.
  // -------------------------------------------------------------------------

  private async workDatesBySession(sessionIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(sessionIds)];
    if (unique.length === 0) return new Map();

    const rows = await prisma.attendanceSession.findMany({
      where: { sessionId: { in: unique } },
      select: { sessionId: true, workDate: true },
    });

    return new Map(rows.map((r) => [r.sessionId, utcWorkDate(r.workDate)]));
  }

  /** The subset of ids already stored on this channel, so the rollup never counts them twice. */
  private async existingEventIds(channel: Channel, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();

    switch (channel) {
      case "attendance": {
        const rows = await prisma.attendanceSession.findMany({
          where: { sessionId: { in: ids } },
          select: { sessionId: true },
        });
        return new Set(rows.map((r) => r.sessionId));
      }
      case "activity-metric": {
        const rows = await prisma.activityMetric.findMany({
          where: { clientEventId: { in: ids } },
          select: { clientEventId: true },
        });
        return new Set(rows.map((r) => r.clientEventId));
      }
      case "activity-session": {
        const rows = await prisma.activitySession.findMany({
          where: { activitySessionId: { in: ids } },
          select: { activitySessionId: true },
        });
        return new Set(rows.map((r) => r.activitySessionId));
      }
      case "browser-activity": {
        const rows = await prisma.browserActivity.findMany({
          where: { browserActivityId: { in: ids } },
          select: { browserActivityId: true },
        });
        return new Set(rows.map((r) => r.browserActivityId));
      }
      case "usb-event": {
        const rows = await prisma.usbEvent.findMany({
          where: { clientEventId: { in: ids } },
          select: { clientEventId: true },
        });
        return new Set(rows.map((r) => r.clientEventId));
      }
      case "alert": {
        const rows = await prisma.alert.findMany({
          where: { clientEventId: { in: ids } },
          select: { clientEventId: true },
        });
        return new Set(rows.map((r) => r.clientEventId));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Attendance - upsert on sessionId. An open session re-sends its row every couple of minutes as
  // its running totals grow, so later writes overwrite earlier ones.
  //
  // "LATER" IS THE AGENT'S REVISION NUMBER, NOT THE SHAPE OF THE REPORT. One session produces a
  // stream of snapshots - open at 0 seconds, open at 120, closed at 215 - and the server has to
  // know which of two of them the workstation wrote last. It used to infer that from the contents:
  // a report carrying a logout was assumed to be the later of the pair. That holds only while
  // delivery is ordered, and this queue is at-least-once over a link that drops for hours: a
  // refresh written before the close, retried after it, arrived looking exactly like fresh news
  // that the session was open again. The agent now stamps a counter it bumps on every rewrite of
  // the row, and a report whose revision is below the one on file is dropped as stale - the whole
  // question answered by one comparison, before any of the rules below are consulted.
  //
  // A revision of 0 means the agent predates the counter. Those reports are not ordered relative
  // to each other and fall back to the older rules, which is why the rules are still here.
  //
  // AN AGENT-STAMPED LOGOUT IS FINAL. The agent closes a session once - a lock, a suspend or a
  // logoff ends it, and presence resumed afterwards arrives as a new sessionId - so a write against
  // a row the agent already closed is stale by definition and is dropped. Enforced here as well as
  // on the agent because sync is at-least-once over an offline queue: a batch that was retried, or
  // one from an agent still running the old build, must not be able to blank a logout that has
  // already been reported. That is exactly what produced days of logins with no logout - the null
  // logoutTime that means "still open" landing on a row closed minutes earlier.
  //
  // A SERVER-STAMPED LOGOUT IS NOT. When a workstation loses power the agent never gets to close
  // anything, so attendanceReaper closes the row from the last evidence the server holds and marks
  // it `logoutSource = Server`. That is an inference about a machine that stopped answering, and
  // the machine itself is the better witness: when it comes back and drains its queue, its report
  // overwrites the estimate - including a "still open" refresh, which reopens the row. A laptop
  // that ran on battery through the outage was never gone, and the server must be able to be told
  // so. Only `logoutSource = Agent` closes the door.
  //
  // Contributes no seconds to the rollup: totalActiveSeconds here is the agent's own sum of the
  // activity sessions it already sent, and counting both would double every working day. It only
  // establishes that the day exists.
  // -------------------------------------------------------------------------

  private async prepareAttendance(
    device: DeviceContext,
    events: AttendanceEventDto[],
  ): Promise<PreparedBatch> {
    const collapsed = collapseAttendanceBySession(events);

    const existing = await prisma.attendanceSession.findMany({
      where: { sessionId: { in: collapsed.map((e) => e.sessionId) } },
      select: { sessionId: true },
    });

    const stored = new Set(existing.map((r) => r.sessionId));

    const accumulator = new RollupAccumulator();

    // Acknowledged even when the write is dropped: the agent is told the row is stored so it stops
    // resending it. Rejecting would leave a stale row queued on the workstation forever.
    for (const e of collapsed) accumulator.touchDate(e.workDate);

    return {
      newEventIds: collapsed.filter((e) => !stored.has(e.sessionId)).map((e) => e.sessionId),
      accumulator,
      write: async (tx) => {
        for (const e of collapsed) {
          const logoutTime = e.logoutTime ?? null;
          const logoutSource = logoutTime === null ? null : LogoutSource.Agent;
          const shared = {
            deviceId: device.id,
            userSid: e.userSid,
            revision: e.revision,
            loginTime: e.loginTime,
            logoutTime,
            endReason: e.endReason ?? null,
            // Everything arriving on this channel came from the workstation, so a logout it
            // carries is observed rather than inferred - and supersedes any estimate on the row.
            logoutSource,
            workDate: new Date(`${e.workDate}T00:00:00.000Z`),
            totalActiveSeconds: e.totalActiveSeconds,
            totalIdleSeconds: e.totalIdleSeconds,
          };

          // Keep the revision and provenance checks inside the upsert. The read above is only for
          // rollup bookkeeping and can be stale when two pushes for the same session race.
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO "attendance_sessions" (
              "sessionId", "deviceId", "userSid", "revision", "loginTime", "logoutTime",
              "endReason", "logoutSource", "workDate", "totalActiveSeconds", "totalIdleSeconds"
            ) VALUES (
              ${e.sessionId}, ${shared.deviceId}, ${shared.userSid}, ${shared.revision},
              ${shared.loginTime}, ${shared.logoutTime}, ${shared.endReason}::"SessionEndReason",
              ${shared.logoutSource}::"LogoutSource", ${shared.workDate},
              ${shared.totalActiveSeconds}, ${shared.totalIdleSeconds}
            )
            ON CONFLICT ("sessionId") DO UPDATE SET
              "deviceId" = EXCLUDED."deviceId",
              "userSid" = EXCLUDED."userSid",
              "revision" = EXCLUDED."revision",
              "loginTime" = EXCLUDED."loginTime",
              "logoutTime" = EXCLUDED."logoutTime",
              "endReason" = EXCLUDED."endReason",
              "logoutSource" = EXCLUDED."logoutSource",
              "workDate" = EXCLUDED."workDate",
              "totalActiveSeconds" = EXCLUDED."totalActiveSeconds",
              "totalIdleSeconds" = EXCLUDED."totalIdleSeconds",
              "updatedAt" = CURRENT_TIMESTAMP
            WHERE "attendance_sessions"."revision" < EXCLUDED."revision"
              AND (
                "attendance_sessions"."logoutTime" IS NULL
                OR "attendance_sessions"."logoutSource" = 'Server'::"LogoutSource"
              )
          `);
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // Activity metric - insert-only counts. No content is accepted by the schema.
  // -------------------------------------------------------------------------

  private async prepareActivityMetrics(
    device: DeviceContext,
    events: ActivityMetricEventDto[],
  ): Promise<PreparedBatch> {
    const stored = await this.existingEventIds(
      "activity-metric",
      events.map((e) => e.clientEventId),
    );
    const fresh = events.filter((e) => !stored.has(e.clientEventId));
    const workDates = await this.workDatesBySession(fresh.map((e) => e.sessionId));

    const accumulator = new RollupAccumulator();
    const rows: Prisma.ActivityMetricCreateManyInput[] = [];

    for (const e of fresh) {
      accumulator.addActivityMetric(
        workDates.get(e.sessionId) ?? utcWorkDate(e.windowEndUtc),
        e.keyCount,
        e.mouseCount,
        e.windowEndUtc,
      );

      rows.push({
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
      });
    }

    return {
      newEventIds: fresh.map((e) => e.clientEventId),
      accumulator,
      write: async (tx) => {
        // skipDuplicates is kept as a backstop even though `fresh` is already filtered: the
        // filter read outside the transaction, so a concurrent insert would otherwise abort the
        // whole batch instead of being absorbed.
        if (rows.length > 0)
          await tx.activityMetric.createMany({ data: rows, skipDuplicates: true });
      },
    };
  }

  // -------------------------------------------------------------------------
  // Activity sessions. The server re-derives ProductivityTag from the org's category
  // rules rather than trusting the agent's copy: the agent's rules can be a policy
  // version behind, and reports must be consistent with what the admin sees now.
  // The agent's tag is kept only when no rule matches.
  // -------------------------------------------------------------------------

  private async prepareActivitySessions(
    device: DeviceContext,
    events: ActivitySessionEventDto[],
  ): Promise<PreparedBatch> {
    const stored = await this.existingEventIds(
      "activity-session",
      events.map((e) => e.activitySessionId),
    );
    const fresh = events.filter((e) => !stored.has(e.activitySessionId));
    const workDates = await this.workDatesBySession(fresh.map((e) => e.sessionId));

    const accumulator = new RollupAccumulator();
    const rows: Prisma.ActivitySessionCreateManyInput[] = [];

    for (const e of fresh) {
      const match = await categoryService.categorizeApp(
        device.organizationId,
        e.appName,
        e.processName,
        e.executablePath,
      );

      const productivityTag = match ? match.tag : (e.productivityTag as ProductivityTag);
      const workDate = workDates.get(e.sessionId) ?? utcWorkDate(e.startTime);

      accumulator.addActivitySession(
        workDate,
        e.type as ActivityType,
        productivityTag,
        e.durationSeconds,
        e.startTime,
        e.endTime,
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
        productivityTag,
      });
    }

    return {
      newEventIds: fresh.map((e) => e.activitySessionId),
      accumulator,
      write: async (tx) => {
        if (rows.length > 0)
          await tx.activitySession.createMany({ data: rows, skipDuplicates: true });
      },
    };
  }

  // -------------------------------------------------------------------------
  // Browser activity. Same server-side re-categorization as activity sessions.
  //
  // activitySessionId is a foreign key to a row that may not have arrived yet - the
  // app session closes after the browser visit it contains. Unknown parents are nulled
  // rather than rejected, so an out-of-order batch is not lost.
  // -------------------------------------------------------------------------

  private async prepareBrowserActivity(
    device: DeviceContext,
    events: BrowserActivityEventDto[],
  ): Promise<PreparedBatch> {
    const stored = await this.existingEventIds(
      "browser-activity",
      events.map((e) => e.browserActivityId),
    );
    const fresh = events.filter((e) => !stored.has(e.browserActivityId));

    const referenced = [
      ...new Set(fresh.map((e) => e.activitySessionId).filter((v): v is string => !!v)),
    ];

    // sessionId comes along for the ride: it is how a browser visit inherits the local work date
    // of the attendance session that contained it, rather than being attributed by UTC midnight.
    const parents = await prisma.activitySession.findMany({
      where: { activitySessionId: { in: referenced } },
      select: { activitySessionId: true, sessionId: true },
    });

    const parentSessionId = new Map(parents.map((p) => [p.activitySessionId, p.sessionId]));
    const workDates = await this.workDatesBySession([...parentSessionId.values()]);

    const accumulator = new RollupAccumulator();
    const rows: Prisma.BrowserActivityCreateManyInput[] = [];

    for (const e of fresh) {
      const match = await categoryService.categorizeDomain(device.organizationId, e.domain);

      const parentSession = e.activitySessionId
        ? parentSessionId.get(e.activitySessionId)
        : undefined;
      const workDate = (parentSession && workDates.get(parentSession)) ?? utcWorkDate(e.startTime);

      accumulator.addBrowserVisit(workDate, e.startTime, e.endTime);

      rows.push({
        deviceId: device.id,
        browserActivityId: e.browserActivityId,
        activitySessionId:
          e.activitySessionId && parentSessionId.has(e.activitySessionId)
            ? e.activitySessionId
            : null,
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

    return {
      newEventIds: fresh.map((e) => e.browserActivityId),
      accumulator,
      write: async (tx) => {
        if (rows.length > 0)
          await tx.browserActivity.createMany({ data: rows, skipDuplicates: true });
      },
    };
  }

  // -------------------------------------------------------------------------
  // USB events - connection/removal metadata only, never contents.
  // -------------------------------------------------------------------------

  private async prepareUsbEvents(
    device: DeviceContext,
    events: UsbEventDto[],
  ): Promise<PreparedBatch> {
    const stored = await this.existingEventIds(
      "usb-event",
      events.map((e) => e.clientEventId),
    );
    const fresh = events.filter((e) => !stored.has(e.clientEventId));

    // sessionId is a nullable FK onto attendance_sessions; null out ids we haven't seen
    // so a USB event that beat its attendance row to the server still lands.
    const referenced = [...new Set(fresh.map((e) => e.sessionId).filter((v): v is string => !!v))];
    const workDates = await this.workDatesBySession(referenced);

    const accumulator = new RollupAccumulator();
    const rows: Prisma.UsbEventCreateManyInput[] = [];

    for (const e of fresh) {
      const known = !!e.sessionId && workDates.has(e.sessionId);
      accumulator.addUsbEvent(
        (known && workDates.get(e.sessionId!)) || utcWorkDate(e.eventTime),
        e.eventTime,
      );

      rows.push({
        deviceId: device.id,
        sessionId: known ? e.sessionId! : null,
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
      });
    }

    return {
      newEventIds: fresh.map((e) => e.clientEventId),
      accumulator,
      write: async (tx) => {
        if (rows.length > 0) await tx.usbEvent.createMany({ data: rows, skipDuplicates: true });
      },
    };
  }

  // -------------------------------------------------------------------------
  // Alerts - upsert, because an escalating incident (idle 30 -> 45 -> 60 min)
  // reuses one clientEventId rather than creating a new row per escalation.
  //
  // Every alert is written, but only first sightings are counted: an escalation is the same
  // incident, and counting it again would inflate the day's alert total on every re-send.
  // -------------------------------------------------------------------------

  private async prepareAlerts(
    device: DeviceContext,
    events: AlertEventDto[],
  ): Promise<PreparedBatch> {
    const stored = await this.existingEventIds(
      "alert",
      events.map((e) => e.clientEventId),
    );
    const accumulator = new RollupAccumulator();

    for (const e of events) {
      if (!stored.has(e.clientEventId))
        accumulator.addAlert(utcWorkDate(e.triggeredAt), e.triggeredAt);
    }

    return {
      newEventIds: events.filter((e) => !stored.has(e.clientEventId)).map((e) => e.clientEventId),
      accumulator,
      write: async (tx) => {
        for (const e of events) {
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
          await tx.alert.upsert({
            where: { clientEventId: e.clientEventId },
            create: { clientEventId: e.clientEventId, ...shared },
            update: shared,
          });
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // Policy / consent / screenshots
  // -------------------------------------------------------------------------

  /** GET /api/v1/policy - always the full document, never a diff. */
  async getPolicy(organizationId: string) {
    return getOrCreatePolicy(organizationId);
  }

  /** POST /api/v1/consent - idempotent on (device, userSid, policyVersion). */
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

  /** POST /api/v1/screenshots - idempotent on clientEventId: overwrite, not append. */
  async storeScreenshot(device: DeviceContext, fields: ScreenshotFieldsDto, tempFilePath: string) {
    const { storagePath, sizeBytes } = await persistScreenshot(
      device.id,
      fields.clientEventId,
      tempFilePath,
    );

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
  // Device enrollment - Features.md "Device Auth".
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
      throw new EnrollmentError("Invalid enrollment token", 401);
    }

    const existing = await prisma.device.findUnique({ where: { deviceId: dto.deviceId } });

    if (existing && !existing.isActive) {
      throw new EnrollmentError("Device has been deactivated by an administrator", 403);
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
      // Already normalized by macAddressSchema, and null when the agent could not determine one.
      // A previously known address is kept rather than overwritten with null: an agent that
      // enrolls before the NIC is up should not erase what we learned last time.
      macAddress: dto.macAddress ?? existing?.macAddress ?? null,
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
        name: "Unassigned Devices",
        department: null,
        status: "placeholder",
      },
      update: {},
    });
  }

  /**
   * GET /api/v1/heartbeat - Features.md "Device Auth". The agent must pass this before it
   * starts syncing, so it doubles as a check that the credential is still valid and a cheap
   * way for the agent to learn the current policy version without pulling the whole document.
   *
   * This, not the Socket.IO connection, is the agent's availability gate. It proves the
   * credential is accepted *and* that the server can reach Postgres to answer - neither of
   * which an open socket implies.
   */
  async heartbeat(device: DeviceContext) {
    const policy = await prisma.policy.findUnique({
      where: { organizationId: device.organizationId },
      select: { version: true, realtimeEnabled: true },
    });

    return {
      authenticated: true,
      deviceId: device.deviceId,
      policyVersion: policy?.version ?? 1,
      realtimeEnabled: policy?.realtimeEnabled ?? true,
      serverTimeUtc: new Date().toISOString(),
    };
  }

  /**
   * Prunes the batch-idempotency ledger. It only has to outlive the agent's retry window: once
   * an agent has stopped resending a batch the row can never be consulted again, and leaving it
   * would grow a table nothing reads at roughly one row per device per channel per interval.
   */
  async pruneIngestBatches(client: Prisma.TransactionClient = prisma): Promise<number> {
    const cutoff = new Date(Date.now() - env.INGEST_BATCH_RETENTION_DAYS * MS_PER_DAY);
    const { count } = await client.ingestBatch.deleteMany({
      where: { receivedAt: { lt: cutoff } },
    });
    return count;
  }
}

/**
 * Reduces a batch to one event per attendance session - the newest snapshot of each.
 *
 * The current agent keeps one row per session in its local queue (`ON CONFLICT (session_id) DO
 * UPDATE`), so a batch normally carries each session once. This does not rely on that. Two events
 * for one session applied in the order they happen to arrive would let a stale "still open"
 * refresh land after the close and blank it - the original bug, reintroduced from inside a single
 * batch - and array order is not a guarantee the wire protocol makes.
 *
 * The winner is the highest revision, which is the agent's own statement of which snapshot it
 * wrote last. Order within the batch is preserved for everything else, so the caller still writes
 * sessions in the sequence the agent sent them.
 *
 * Equal revisions are duplicates of the same snapshot, so the first event remains the winner.
 */
function collapseAttendanceBySession(events: AttendanceEventDto[]): AttendanceEventDto[] {
  const bySession = new Map<string, AttendanceEventDto>();

  for (const event of events) {
    const winner = bySession.get(event.sessionId);

    if (winner === undefined) {
      bySession.set(event.sessionId, event);
      continue;
    }

    if (event.revision > winner.revision) {
      bySession.set(event.sessionId, event);
    }
  }

  return [...bySession.values()];
}

/**
 * Fingerprints a batch's contents.
 *
 * Sorted before hashing so a retry that repacked the same events in a different order is still
 * recognized as the same batch. This is a contents check against one agent's own previous batch,
 * not a security boundary - nothing here is trusted on the strength of the hash alone.
 */
function hashEventIds(ids: string[]): string {
  return createHash("sha256")
    .update([...ids].sort().join(","))
    .digest("hex");
}

export const ingestService = new IngestService();
