/**
 * Integration smoke test for the Agent-facing surface, run against the real Express app and a
 * real Postgres database.
 *
 * The previous version of this file mocked Prisma in memory. That made sense when every
 * channel wrote the same `payload` blob; now that each channel has its own typed columns, a
 * mock would only prove the mock's shape, so this talks to the actual database and asserts the
 * values landed in the right columns.
 *
 * Run with: npm test   (requires DATABASE_URL to point at a dev database)
 */
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { io as ioClient } from "socket.io-client";
import app, { server } from "../src/server";
import { issueRealtimeTicket } from "../src/realtime/ticket";
import { forgetDeviceLiveness } from "../src/modules/ingest/deviceLiveness";
import { closeAbandonedSessions } from "../src/modules/attendance/attendanceReaper";
import { prisma } from "../src/config/db";
import { env } from "../src/config/env";
import { currentOrganizationId } from "../src/config/tenant";
import { generateDeviceApiKey, hashDeviceApiKey } from "../src/utils/token";
import { organizationService } from "../src/modules/organization/organizationService";
import { employeeService } from "../src/modules/employee/employeeService";
import { resolveRange, reportService } from "../src/modules/report/reportService";
import { formatDuration } from "../src/lib/format";
import {
  summarizeBrowserDay,
  backfillMissingDailySummaries,
} from "../src/modules/report/browserSummaryService";
import { categoryService } from "../src/modules/report/categoryService";
import { pdfReportService } from "../src/modules/report/pdfReportService";

const BASE = `http://127.0.0.1:${env.PORT}`;

let passed = 0;
let failed = 0;

/**
 * Awaits an event, or gives up.
 *
 * Every realtime assertion needs this shape, and a bare promise would hang the whole suite when
 * the thing under test is broken - which is precisely when the suite has to report rather than
 * stall. Resolves to null on timeout so the assertion fails with a readable value.
 */
function waitFor<T>(
  subscribe: (resolve: (value: T | null) => void) => void,
  timeoutMs = 5_000,
): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    subscribe((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`);
  }
}

async function main() {
  const runId = randomUUID().slice(0, 8);
  console.log(`\nAgent API smoke test (run ${runId})\n`);

  // -- Setup: an organization to enroll into ---------------------------------
  const org = await organizationService.createOrganization({ name: `Smoke Test Org ${runId}` });
  const enrollmentToken = org.enrollmentToken;

  const machineGuid = `smoke-${runId}`;
  let apiKey = "";
  let deviceRowId = "";

  // Lives in the *resolved* organization rather than this test's own, because that is the one a
  // dashboard socket joins. Torn down separately for the same reason - it is outside the org
  // whose cascade delete cleans up everything else.
  let presenceDeviceRowId = "";
  let presenceEmployeeId = "";

  try {
    // -- Enrollment ----------------------------------------------------------
    console.log("Device enrollment");

    const badEnroll = await fetch(`${BASE}/api/v1/device/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-enrollment-token": "wrong-token" },
      body: JSON.stringify({
        deviceId: machineGuid,
        deviceName: "SMOKE-PC",
        macAddress: "00:11:22:33:44:55",
      }),
    });
    check(
      "rejects an invalid enrollment token with 401",
      badEnroll.status === 401,
      badEnroll.status,
    );

    const enrollRes = await fetch(`${BASE}/api/v1/device/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-enrollment-token": enrollmentToken },
      body: JSON.stringify({
        deviceId: machineGuid,
        deviceName: "SMOKE-PC",
        systemType: "64-bit operating system, x64-based processor",
        edition: "Windows 11 Pro",
        version: "10.0.26200",
        macAddress: "00:11:22:33:44:55",
        agentVersion: "3.0.0",
      }),
    });
    const enrollBody = (await enrollRes.json()) as any;
    check("enrolls a new device with 201", enrollRes.status === 201, enrollBody);
    check(
      "returns a device API key exactly once",
      typeof enrollBody.apiKey === "string" && enrollBody.apiKey.length > 0,
    );

    apiKey = enrollBody.apiKey;
    deviceRowId = enrollBody.deviceId;

    const storedDevice = await prisma.device.findUnique({ where: { deviceId: machineGuid } });
    check(
      "persists device columns individually",
      storedDevice?.edition === "Windows 11 Pro" && storedDevice?.version === "10.0.26200",
      {
        edition: storedDevice?.edition,
        version: storedDevice?.version,
      },
    );

    const auth = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

    // -- Auth boundaries -----------------------------------------------------
    console.log("\nAuthentication");

    const noAuth = await fetch(`${BASE}/api/v1/heartbeat`);
    check("rejects a missing credential with 401", noAuth.status === 401, noAuth.status);

    const badAuth = await fetch(`${BASE}/api/v1/heartbeat`, {
      headers: { authorization: "Bearer nope" },
    });
    check("rejects an unknown credential with 401", badAuth.status === 401, badAuth.status);

    const heartbeat = await fetch(`${BASE}/api/v1/heartbeat`, { headers: auth });
    const heartbeatBody = (await heartbeat.json()) as any;
    check(
      "heartbeat authorizes a valid device",
      heartbeat.status === 200 && heartbeatBody.authenticated === true,
      heartbeatBody,
    );

    // -- Policy --------------------------------------------------------------
    console.log("\nPolicy");

    const policyRes = await fetch(`${BASE}/api/v1/policy`, { headers: auth });
    const policy = (await policyRes.json()) as any;
    check(
      "serves a versioned policy document",
      policyRes.status === 200 && typeof policy.version === "number",
      policy,
    );
    check(
      "policy carries the 5-minute idle default",
      policy.activity?.idleThresholdSeconds === 300,
      policy.activity,
    );
    check(
      "policy carries the 30/45/60-minute idle escalation",
      policy.alert?.idle?.normalSeconds === 1800 &&
        policy.alert?.idle?.moderateSeconds === 2700 &&
        policy.alert?.idle?.severeSeconds === 3600,
      policy.alert?.idle,
    );

    // -- Telemetry channels --------------------------------------------------
    console.log("\nTelemetry ingest");

    const sessionId = randomUUID();
    const activitySessionId = randomUUID();
    const now = new Date();
    const earlier = new Date(now.getTime() - 60_000);

    async function push(channel: string, events: unknown[]) {
      const res = await fetch(`${BASE}/api/v1/events/${channel}`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ events }),
      });
      return { status: res.status, body: (await res.json()) as any };
    }

    const attendance = await push("attendance", [
      {
        clientEventId: randomUUID(),
        sessionId,
        userSid: "S-1-5-21-smoke",
        loginTime: earlier.toISOString(),
        logoutTime: null,
        workDate: now.toISOString().slice(0, 10),
        totalActiveSeconds: 45,
        totalIdleSeconds: 15,
      },
    ]);
    check("accepts an attendance session", attendance.status === 200, attendance.body);

    const metric = await push("activity-metric", [
      {
        clientEventId: randomUUID(),
        sessionId,
        keyCount: 412,
        mouseCount: 96,
        mouseLeftKeyCount: 70,
        mouseRightKeyCount: 20,
        mouseMiddleKeyCount: 6,
        mouseOtherKeyCount: 0,
        windowStartUtc: earlier.toISOString(),
        windowEndUtc: now.toISOString(),
      },
    ]);
    check("accepts an activity metric", metric.status === 200, metric.body);

    const activity = await push("activity-session", [
      {
        clientEventId: randomUUID(),
        activitySessionId,
        sessionId,
        appName: "Visual Studio Code",
        processName: "Code",
        executablePath: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
        type: "Application",
        windowTitle: "schema.prisma",
        startTime: earlier.toISOString(),
        endTime: now.toISOString(),
        durationSeconds: 60,
        reason: "AppSwitch",
        productivityTag: "Productive",
      },
    ]);
    check("accepts an activity session", activity.status === 200, activity.body);

    const browser = await push("browser-activity", [
      {
        clientEventId: randomUUID(),
        browserActivityId: randomUUID(),
        activitySessionId,
        browser: "Chrome",
        browserVersion: "141.0",
        profileName: "Default",
        domain: "github.com",
        rawUrl: "https://github.com/anthropics",
        pageTitle: "GitHub",
        protocol: "Https",
        startTime: earlier.toISOString(),
        endTime: now.toISOString(),
        durationSeconds: 60,
        productivityTag: "Neutral",
      },
    ]);
    check("accepts a browser visit", browser.status === 200, browser.body);

    const usb = await push("usb-event", [
      {
        clientEventId: randomUUID(),
        sessionId,
        eventType: "Connected",
        deviceType: "UsbStorage",
        friendlyName: "SanDisk Ultra",
        manufacturer: "SanDisk",
        serialNumber: `SN-${runId}`,
        vendorId: "0781",
        productId: "5583",
        driveLetter: "E:",
        volumeLabel: "BACKUP",
        capacityBytes: "64023257088",
        fileSystem: "exFAT",
        eventTime: now.toISOString(),
      },
    ]);
    check("accepts a USB event", usb.status === 200, usb.body);

    const alertId = randomUUID();
    const alertPush = await push("alert", [
      {
        clientEventId: alertId,
        userSid: "S-1-5-21-smoke",
        type: "IdleThreshold",
        severity: "Warning",
        state: "New",
        title: "Idle for 30 minutes",
        message: "No input detected for 30 minutes.",
        idleSeconds: 1800,
        thresholdSeconds: 1800,
        triggeredAt: now.toISOString(),
        escalationLevel: 1,
        notificationCount: 1,
      },
    ]);
    check("accepts an alert", alertPush.status === 200, alertPush.body);

    // -- Request size --------------------------------------------------------
    // Express defaults to a 100kb JSON body. A full agent batch of activity sessions carrying
    // window titles and executable paths exceeds that, and every push 413'd in normal operation.
    console.log("\nRequest size limits");

    // ~700 bytes per event x 400 events -> comfortably past the old 100kb default, while staying
    // inside INGEST_MAX_BATCH_EVENTS. This assertion is about the *body size* limit; the
    // event-count ceiling is a separate bound with its own case below.
    const bulkSessions = Array.from({ length: 400 }, () => ({
      clientEventId: randomUUID(),
      activitySessionId: randomUUID(),
      sessionId,
      appName: "Visual Studio Code",
      processName: "Code",
      executablePath: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
      type: "Application",
      windowTitle: `schema.prisma - ${"employee-tracker/".repeat(14)}`,
      startTime: earlier.toISOString(),
      endTime: now.toISOString(),
      durationSeconds: 60,
      productivityTag: "Productive",
    }));

    const bulkBytes = Buffer.byteLength(JSON.stringify({ events: bulkSessions }));
    const bulk = await push("activity-session", bulkSessions);
    check(
      `accepts a ${Math.round(bulkBytes / 1024)}kb batch (over the old 100kb default)`,
      bulk.status === 200 && bulkBytes > 102400,
      { status: bulk.status, bulkBytes },
    );
    check(
      "acknowledges every event in a large batch",
      bulk.body?.acknowledgedEventIds?.length === bulkSessions.length,
      { acked: bulk.body?.acknowledgedEventIds?.length, sent: bulkSessions.length },
    );

    // Event count is bounded independently of body size. The operational batch size is
    // Policy.syncMaxBatchSize (100); this ceiling is the abuse bound above it, and a batch past
    // it must be refused even though the body itself is small.
    const tooManyEvents = Array.from({ length: env.INGEST_MAX_BATCH_EVENTS + 1 }, () => ({
      clientEventId: randomUUID(),
      activitySessionId: randomUUID(),
      sessionId,
      type: "Desktop",
      startTime: earlier.toISOString(),
      endTime: now.toISOString(),
      durationSeconds: 60,
      productivityTag: "Neutral",
    }));
    const overCount = await push("activity-session", tooManyEvents);
    check("rejects a batch with more events than the ceiling allows", overCount.status === 400, {
      status: overCount.status,
      sent: tooManyEvents.length,
      ceiling: env.INGEST_MAX_BATCH_EVENTS,
    });

    // -- Batch idempotency ---------------------------------------------------
    // The agent's queue is at-least-once: a batch that was committed but whose response was lost
    // is resent verbatim. Replaying it must be a no-op, not a second set of rows and not a second
    // contribution to the daily rollup.
    console.log("\nBatch idempotency");

    const replayBatchId = randomUUID();
    const replaySessionId = randomUUID();
    const replayEvents = [
      {
        clientEventId: randomUUID(),
        activitySessionId: replaySessionId,
        sessionId,
        appName: "Replay Test",
        processName: "replay",
        type: "Application",
        startTime: earlier.toISOString(),
        endTime: now.toISOString(),
        durationSeconds: 90,
        productivityTag: "Productive",
      },
    ];

    async function pushBatch(events: unknown[], batchId: string) {
      const res = await fetch(`${BASE}/api/v1/events/activity-session`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ batchId, events }),
      });
      return { status: res.status, body: (await res.json()) as any };
    }

    const firstPush = await pushBatch(replayEvents, replayBatchId);
    check(
      "stores a batch carrying a batchId",
      firstPush.status === 200 && firstPush.body.replay === false,
      firstPush.body,
    );

    const rollupAfterFirst = await prisma.dailyActivityRollup.aggregate({
      where: { deviceId: deviceRowId },
      _sum: { activeSeconds: true, activitySessionCount: true },
    });

    const replayPush = await pushBatch(replayEvents, replayBatchId);
    check(
      "recognizes a replayed batch instead of redoing the work",
      replayPush.status === 200 && replayPush.body.replay === true,
      replayPush.body,
    );
    check(
      "still acknowledges every event on a replay",
      replayPush.body?.acknowledgedEventIds?.length === replayEvents.length,
      replayPush.body,
    );

    const rollupAfterReplay = await prisma.dailyActivityRollup.aggregate({
      where: { deviceId: deviceRowId },
      _sum: { activeSeconds: true, activitySessionCount: true },
    });

    check(
      "a replay does not double-count the daily rollup",
      rollupAfterFirst._sum.activeSeconds === rollupAfterReplay._sum.activeSeconds &&
        rollupAfterFirst._sum.activitySessionCount === rollupAfterReplay._sum.activitySessionCount,
      { before: rollupAfterFirst._sum, after: rollupAfterReplay._sum },
    );

    // The same events sent under a *different* batch id must also not double-count: per-event
    // deduplication is the backstop when a retry repacks its queue.
    const repacked = await pushBatch(replayEvents, randomUUID());
    const rollupAfterRepack = await prisma.dailyActivityRollup.aggregate({
      where: { deviceId: deviceRowId },
      _sum: { activeSeconds: true, activitySessionCount: true },
    });
    check(
      "resending under a new batch id still does not double-count",
      repacked.status === 200 &&
        rollupAfterFirst._sum.activeSeconds === rollupAfterRepack._sum.activeSeconds &&
        rollupAfterFirst._sum.activitySessionCount === rollupAfterRepack._sum.activitySessionCount,
      { before: rollupAfterFirst._sum, after: rollupAfterRepack._sum },
    );

    // -- MAC address normalization -------------------------------------------
    // An agent that cannot determine a hardware address must not have that recorded as though it
    // were one: the all-zero address is what enumeration returns when it found nothing.
    console.log("\nDevice identity");

    const zeroMacEnroll = await fetch(`${BASE}/api/v1/device/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-enrollment-token": enrollmentToken },
      body: JSON.stringify({
        deviceId: `${machineGuid}-zero-mac`,
        deviceName: "ZERO-MAC-PC",
        macAddress: "00:00:00:00:00:00",
      }),
    });
    check(
      "accepts an enrollment with no usable MAC",
      zeroMacEnroll.status === 201 || zeroMacEnroll.status === 200,
      zeroMacEnroll.status,
    );

    const zeroMacDevice = await prisma.device.findUnique({
      where: { deviceId: `${machineGuid}-zero-mac` },
    });
    check(
      "stores the all-zero MAC as null rather than as an address",
      zeroMacDevice?.macAddress === null,
      zeroMacDevice?.macAddress,
    );

    const dashedMacEnroll = await fetch(`${BASE}/api/v1/device/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-enrollment-token": enrollmentToken },
      body: JSON.stringify({
        deviceId: `${machineGuid}-dashed-mac`,
        deviceName: "DASHED-MAC-PC",
        macAddress: "a0-b1-c2-d3-e4-f5",
      }),
    });
    check(
      "accepts a dash-separated MAC",
      dashedMacEnroll.status === 201 || dashedMacEnroll.status === 200,
      dashedMacEnroll.status,
    );

    const dashedMacDevice = await prisma.device.findUnique({
      where: { deviceId: `${machineGuid}-dashed-mac` },
    });
    check(
      "normalizes a MAC to canonical colon form",
      dashedMacDevice?.macAddress === "A0:B1:C2:D3:E4:F5",
      dashedMacDevice?.macAddress,
    );

    // Past the ceiling the server still refuses - but with an actionable body, not a stack trace.
    const oversized = await fetch(`${BASE}/api/v1/events/activity-session`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        events: [{ clientEventId: randomUUID(), filler: "x".repeat(3 * 1024 * 1024) }],
      }),
    });
    const oversizedBody = (await oversized.json()) as any;
    check(
      "rejects a body past the ceiling with an actionable 413",
      oversized.status === 413 &&
        typeof oversizedBody.limitBytes === "number" &&
        !!oversizedBody.remedy,
      { status: oversized.status, body: oversizedBody },
    );

    // -- Screenshot upload ---------------------------------------------------
    // Multipart, not JSON, and therefore the one endpoint whose wire contract the per-channel
    // Zod schemas do not cover. It shipped broken once because the Agent posted the image under
    // a different field name than multer was configured for, and every upload 400'd.
    console.log("\nScreenshot upload");

    const screenshotId = randomUUID();

    async function uploadScreenshot(fieldName: string, clientEventId: string) {
      // Smallest thing that is unambiguously a JPEG: SOI + APP0/JFIF header + EOI. The endpoint
      // filters on the declared mimetype, and nothing downstream decodes the pixels.
      const jpeg = new Uint8Array([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
        0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
      ]);

      const form = new FormData();
      form.set("clientEventId", clientEventId);
      form.set("capturedAtUtc", now.toISOString());
      form.set("userSid", "S-1-5-21-smoke");
      form.set("width", "1920");
      form.set("height", "1080");
      form.set(fieldName, new Blob([jpeg], { type: "image/jpeg" }), "capture.jpg");

      // No content-type header: fetch sets it with the generated multipart boundary.
      const res = await fetch(`${BASE}/api/v1/screenshots`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      });
      return { status: res.status, body: (await res.json()) as any };
    }

    const shotUpload = await uploadScreenshot("file", screenshotId);
    check(
      'accepts a screenshot posted under the "file" field',
      shotUpload.status === 200,
      shotUpload.body,
    );

    const storedShot = await prisma.screenshot.findUnique({
      where: { clientEventId: screenshotId },
    });
    check(
      "screenshot metadata lands in typed columns",
      storedShot?.width === 1920 && storedShot?.height === 1080 && (storedShot?.sizeBytes ?? 0) > 0,
      storedShot,
    );

    const wrongField = await uploadScreenshot("screenshot", randomUUID());
    check(
      "rejects a wrong field name with 400 and names the expected field",
      wrongField.status === 400 && wrongField.body?.expectedField === "file",
      wrongField.body,
    );

    // -- Validation ----------------------------------------------------------
    console.log("\nValidation");

    const badChannel = await push("not-a-channel", [{ clientEventId: randomUUID() }]);
    check("rejects an unknown channel with 400", badChannel.status === 400, badChannel.status);

    const badEnum = await push("activity-session", [
      {
        clientEventId: randomUUID(),
        activitySessionId: randomUUID(),
        sessionId,
        type: "NotAValidType",
        startTime: earlier.toISOString(),
        endTime: now.toISOString(),
        durationSeconds: 60,
      },
    ]);
    check("rejects an out-of-range enum with 400", badEnum.status === 400, badEnum.body);

    const badShape = await push("activity-metric", [
      {
        clientEventId: randomUUID(),
        sessionId,
        keyCount: -5,
        windowStartUtc: earlier.toISOString(),
        windowEndUtc: now.toISOString(),
      },
    ]);
    check("rejects a negative count with 400", badShape.status === 400, badShape.body);

    // -- Column-level persistence -------------------------------------------
    console.log("\nTyped column persistence");

    const storedMetric = await prisma.activityMetric.findFirst({ where: { sessionId } });
    check(
      "activity metric lands in discrete count columns",
      storedMetric?.keyCount === 412 &&
        storedMetric?.mouseLeftKeyCount === 70 &&
        storedMetric?.mouseRightKeyCount === 20,
      storedMetric,
    );

    const storedActivity = await prisma.activitySession.findUnique({
      where: { activitySessionId },
    });
    check(
      "activity session lands in discrete columns",
      storedActivity?.appName === "Visual Studio Code" &&
        storedActivity?.type === "Application" &&
        storedActivity?.durationSeconds === 60,
      storedActivity,
    );

    const storedBrowser = await prisma.browserActivity.findFirst({
      where: { deviceId: deviceRowId },
    });
    check(
      "browser visit links to its activity session",
      storedBrowser?.activitySessionId === activitySessionId &&
        storedBrowser?.domain === "github.com",
      storedBrowser,
    );

    await prisma.$transaction((tx) =>
      summarizeBrowserDay(tx, now.toISOString().slice(0, 10), org.id),
    );

    const browserSummary = await prisma.browserDailySummary.findFirst({
      where: { organizationId: org.id, domain: "github.com" },
    });
    check(
      "browser visit contributes to the daily domain summary",
      browserSummary?.durationSeconds === 60 && browserSummary?.visitCount === 1,
      browserSummary,
    );

    const storedUsb = await prisma.usbEvent.findFirst({ where: { serialNumber: `SN-${runId}` } });
    check(
      "USB capacity survives as a 64-bit integer",
      storedUsb?.capacityBytes === 64023257088n,
      storedUsb?.capacityBytes?.toString(),
    );

    const storedAlert = await prisma.alert.findUnique({ where: { clientEventId: alertId } });
    check(
      "alert context lands in typed columns, not a JSON string",
      storedAlert?.idleSeconds === 1800 && storedAlert?.thresholdSeconds === 1800,
      storedAlert,
    );

    // -- Idempotency ---------------------------------------------------------
    console.log("\nIdempotency (at-least-once delivery)");

    const replay = await push("activity-session", [
      {
        clientEventId: randomUUID(),
        activitySessionId,
        sessionId,
        appName: "Visual Studio Code",
        processName: "Code",
        type: "Application",
        startTime: earlier.toISOString(),
        endTime: now.toISOString(),
        durationSeconds: 60,
        productivityTag: "Productive",
      },
    ]);
    const activityCount = await prisma.activitySession.count({ where: { activitySessionId } });
    check(
      "replayed activity session does not duplicate",
      replay.status === 200 && activityCount === 1,
      { activityCount },
    );

    const alertReplay = await push("alert", [
      {
        clientEventId: alertId,
        userSid: "S-1-5-21-smoke",
        type: "IdleThreshold",
        severity: "High",
        state: "Shown",
        title: "Idle for 45 minutes",
        message: "No input detected for 45 minutes.",
        idleSeconds: 2700,
        thresholdSeconds: 2700,
        triggeredAt: now.toISOString(),
        escalationLevel: 2,
        notificationCount: 2,
      },
    ]);
    const escalated = await prisma.alert.findUnique({ where: { clientEventId: alertId } });
    const alertCount = await prisma.alert.count({ where: { clientEventId: alertId } });
    check(
      "re-sent alert escalates in place rather than duplicating",
      alertReplay.status === 200 &&
        alertCount === 1 &&
        escalated?.severity === "High" &&
        escalated?.escalationLevel === 2,
      { alertCount, severity: escalated?.severity },
    );

    const attendanceReplay = await push("attendance", [
      {
        clientEventId: randomUUID(),
        sessionId,
        userSid: "S-1-5-21-smoke",
        loginTime: earlier.toISOString(),
        logoutTime: now.toISOString(),
        endReason: "Shutdown",
        workDate: now.toISOString().slice(0, 10),
        totalActiveSeconds: 60,
        totalIdleSeconds: 15,
      },
    ]);
    const attendanceRow = await prisma.attendanceSession.findUnique({ where: { sessionId } });
    check(
      "re-sent attendance fills in the logout time",
      attendanceReplay.status === 200 &&
        attendanceRow?.logoutTime !== null &&
        attendanceRow?.endReason === "Shutdown",
      { logoutTime: attendanceRow?.logoutTime, endReason: attendanceRow?.endReason },
    );

    // A null logout time means "this session is still open". Landing one on a session that has
    // already ended is what left days of logins with no logout, so a closed row must ignore it.
    const attendanceStale = await push("attendance", [
      {
        clientEventId: randomUUID(),
        sessionId,
        userSid: "S-1-5-21-smoke",
        loginTime: earlier.toISOString(),
        logoutTime: null,
        workDate: now.toISOString().slice(0, 10),
        totalActiveSeconds: 90,
        totalIdleSeconds: 30,
      },
    ]);
    const attendanceAfterStale = await prisma.attendanceSession.findUnique({
      where: { sessionId },
    });
    check(
      "a stale refresh cannot clear a logout time that was already stamped",
      attendanceStale.status === 200 &&
        attendanceAfterStale?.logoutTime?.getTime() === attendanceRow?.logoutTime?.getTime() &&
        attendanceAfterStale?.endReason === "Shutdown" &&
        attendanceAfterStale?.totalActiveSeconds === 60,
      {
        logoutTime: attendanceAfterStale?.logoutTime,
        endReason: attendanceAfterStale?.endReason,
        totalActiveSeconds: attendanceAfterStale?.totalActiveSeconds,
      },
    );

    // A batch is not ordered. Two events for one session in the same push must not let a stale
    // "still open" refresh land after the close and blank it - the bug above, from inside one
    // batch instead of across two.
    const collapseSessionId = randomUUID();
    const collapseLogout = new Date(now.getTime() - 30_000);
    const attendanceCollapse = await push("attendance", [
      {
        clientEventId: randomUUID(),
        sessionId: collapseSessionId,
        userSid: "S-1-5-21-smoke",
        loginTime: earlier.toISOString(),
        logoutTime: collapseLogout.toISOString(),
        endReason: "Lock",
        workDate: now.toISOString().slice(0, 10),
        totalActiveSeconds: 30,
        totalIdleSeconds: 0,
      },
      {
        clientEventId: randomUUID(),
        sessionId: collapseSessionId,
        userSid: "S-1-5-21-smoke",
        loginTime: earlier.toISOString(),
        logoutTime: null,
        workDate: now.toISOString().slice(0, 10),
        totalActiveSeconds: 20,
        totalIdleSeconds: 0,
      },
    ]);
    const collapsedRow = await prisma.attendanceSession.findUnique({
      where: { sessionId: collapseSessionId },
    });
    check(
      "a close and a stale refresh in one batch resolve to the close",
      attendanceCollapse.status === 200 &&
        collapsedRow?.logoutTime?.getTime() === collapseLogout.getTime() &&
        collapsedRow?.endReason === "Lock",
      { logoutTime: collapsedRow?.logoutTime, endReason: collapsedRow?.endReason },
    );

    // A session reports itself many times while it is open, and the reports are not delivered in
    // the order they were written. Nothing about the *contents* of two open refreshes says which
    // the workstation wrote first - both carry a null logout - so before `revision` the later
    // arrival simply won and a redelivered old refresh rolled the day's totals backwards.
    const revisionSessionId = randomUUID();
    const revisionBase = {
      sessionId: revisionSessionId,
      userSid: "S-1-5-21-smoke",
      loginTime: earlier.toISOString(),
      logoutTime: null,
      workDate: now.toISOString().slice(0, 10),
      totalIdleSeconds: 0,
    };

    await push("attendance", [
      { ...revisionBase, clientEventId: randomUUID(), revision: 5, totalActiveSeconds: 300 },
    ]);
    const staleRevision = await push("attendance", [
      { ...revisionBase, clientEventId: randomUUID(), revision: 4, totalActiveSeconds: 200 },
    ]);
    const afterStaleRevision = await prisma.attendanceSession.findUnique({
      where: { sessionId: revisionSessionId },
    });
    check(
      "an older revision delivered late cannot roll back a newer one",
      staleRevision.status === 200 &&
        afterStaleRevision?.totalActiveSeconds === 300 &&
        afterStaleRevision?.revision === 5,
      {
        totalActiveSeconds: afterStaleRevision?.totalActiveSeconds,
        revision: afterStaleRevision?.revision,
      },
    );

    const newerRevision = await push("attendance", [
      { ...revisionBase, clientEventId: randomUUID(), revision: 6, totalActiveSeconds: 360 },
    ]);
    const afterNewerRevision = await prisma.attendanceSession.findUnique({
      where: { sessionId: revisionSessionId },
    });
    check(
      "a newer revision is applied",
      newerRevision.status === 200 &&
        afterNewerRevision?.totalActiveSeconds === 360 &&
        afterNewerRevision?.revision === 6,
      {
        totalActiveSeconds: afterNewerRevision?.totalActiveSeconds,
        revision: afterNewerRevision?.revision,
      },
    );

    // The same question inside one batch, where array order is the only thing distinguishing the
    // two events and the wire protocol does not promise it means anything.
    const batchRevisionSessionId = randomUUID();
    const batchRevision = await push("attendance", [
      {
        ...revisionBase,
        sessionId: batchRevisionSessionId,
        clientEventId: randomUUID(),
        revision: 2,
        totalActiveSeconds: 50,
      },
      {
        ...revisionBase,
        sessionId: batchRevisionSessionId,
        clientEventId: randomUUID(),
        revision: 1,
        totalActiveSeconds: 10,
      },
    ]);
    const batchRevisionRow = await prisma.attendanceSession.findUnique({
      where: { sessionId: batchRevisionSessionId },
    });
    check(
      "two revisions of one session in a batch collapse to the highest",
      batchRevision.status === 200 &&
        batchRevisionRow?.totalActiveSeconds === 50 &&
        batchRevisionRow?.revision === 2,
      {
        totalActiveSeconds: batchRevisionRow?.totalActiveSeconds,
        revision: batchRevisionRow?.revision,
      },
    );

    // -- Abandoned sessions: the load-shedding path --------------------------
    //
    // A workstation that loses power stamps no logout and its agent's recovery pass only runs if
    // that machine boots again. These assertions cover the server closing those rows itself, and
    // - just as important - the agent still being able to correct it afterwards.
    console.log("\nAbandoned attendance closure");

    const reapEnroll = await fetch(`${BASE}/api/v1/device/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-enrollment-token": enrollmentToken },
      body: JSON.stringify({
        deviceId: `smoke-reap-${runId}`,
        deviceName: "SMOKE-REAP-PC",
        agentVersion: "3.0.0",
      }),
    });
    const reapDevice = (await reapEnroll.json()) as any;
    const reapAuth = {
      authorization: `Bearer ${reapDevice.apiKey}`,
      "content-type": "application/json",
    };
    const reapDeviceRowId: string = reapDevice.deviceId;
    const reapSid = "S-1-5-21-reap";

    async function pushReapAttendance(event: Record<string, unknown>) {
      const res = await fetch(`${BASE}/api/v1/events/attendance`, {
        method: "POST",
        headers: reapAuth,
        body: JSON.stringify({
          events: [{ clientEventId: randomUUID(), userSid: reapSid, ...event }],
        }),
      });
      return res.status;
    }

    /** Runs one sweep in its own transaction, the way the scheduler does. */
    function reap(at: Date) {
      return prisma.$transaction((tx) => closeAbandonedSessions(tx, at));
    }

    // Thresholds come from configuration, so the test derives its clock from them rather than
    // restating the numbers - a retuned deployment must not silently invalidate these assertions.
    const abandonMs = env.ATTENDANCE_ABANDON_AFTER_SECONDS * 1_000;
    const wellPastAbandonMs = abandonMs * 2;

    // The session power loss interrupted: half an hour of observed presence, then nothing.
    const deadSessionId = randomUUID();
    const deadLogin = new Date(now.getTime() - wellPastAbandonMs - 3_600_000);
    const deadObservedSeconds = 1_800;
    const deadLastEvidence = new Date(deadLogin.getTime() + deadObservedSeconds * 1_000);

    // The session opened when the power came back.
    const liveSessionId = randomUUID();
    const liveLogin = new Date(now.getTime() - wellPastAbandonMs);

    await pushReapAttendance({
      sessionId: deadSessionId,
      loginTime: deadLogin.toISOString(),
      logoutTime: null,
      workDate: deadLogin.toISOString().slice(0, 10),
      totalActiveSeconds: deadObservedSeconds,
      totalIdleSeconds: 0,
    });

    await pushReapAttendance({
      sessionId: liveSessionId,
      loginTime: liveLogin.toISOString(),
      logoutTime: null,
      workDate: liveLogin.toISOString().slice(0, 10),
      totalActiveSeconds: 0,
      totalIdleSeconds: 0,
    });

    const supersededSweep = await reap(now);
    const deadRow = await prisma.attendanceSession.findUnique({
      where: { sessionId: deadSessionId },
    });

    check(
      "closes a session superseded by a later login on the same workstation",
      supersededSweep.superseded >= 1 &&
        deadRow?.logoutTime !== null &&
        deadRow?.endReason === "Recovered",
      {
        superseded: supersededSweep.superseded,
        logoutTime: deadRow?.logoutTime,
        endReason: deadRow?.endReason,
      },
    );

    // The whole point of the estimate: a session that ended when the power went did not run until
    // a sweep noticed it. Stamping the discovery time would add the length of the outage to the
    // working day.
    check(
      "stamps the last evidence of presence, not the time the sweep ran",
      deadRow?.logoutTime?.getTime() === deadLastEvidence.getTime(),
      { logoutTime: deadRow?.logoutTime, expected: deadLastEvidence, sweptAt: now },
    );

    check(
      "marks an inferred logout as server-sourced",
      deadRow?.logoutSource === "Server",
      deadRow?.logoutSource,
    );

    // The device is still checking in, so its newest session belongs to somebody at their desk.
    const liveAfterFirstSweep = await prisma.attendanceSession.findUnique({
      where: { sessionId: liveSessionId },
    });
    check(
      "leaves the newest session of a reporting workstation open",
      liveAfterFirstSweep?.logoutTime === null,
      { logoutTime: liveAfterFirstSweep?.logoutTime },
    );

    // Now the workstation goes dark - the power cut itself, with no successor session to prove
    // anything, which is the state the agent can never resolve on its own.
    await prisma.device.update({
      where: { id: reapDeviceRowId },
      data: { lastSeen: new Date(now.getTime() - wellPastAbandonMs) },
    });
    forgetDeviceLiveness(reapDeviceRowId);

    const abandonedSweep = await reap(now);
    const liveAfterBlackout = await prisma.attendanceSession.findUnique({
      where: { sessionId: liveSessionId },
    });

    check(
      "closes a session whose workstation stopped reporting",
      abandonedSweep.abandoned >= 1 &&
        liveAfterBlackout?.endReason === "PowerLoss" &&
        liveAfterBlackout?.logoutSource === "Server" &&
        liveAfterBlackout?.logoutTime?.getTime() === liveLogin.getTime(),
      {
        abandoned: abandonedSweep.abandoned,
        endReason: liveAfterBlackout?.endReason,
        logoutTime: liveAfterBlackout?.logoutTime,
      },
    );

    // The machine comes back and drains its queue. It was on battery all along, so its own report
    // says the session never ended - and it is the better witness.
    await pushReapAttendance({
      sessionId: liveSessionId,
      loginTime: liveLogin.toISOString(),
      logoutTime: null,
      workDate: liveLogin.toISOString().slice(0, 10),
      totalActiveSeconds: 600,
      totalIdleSeconds: 0,
    });

    const reopened = await prisma.attendanceSession.findUnique({
      where: { sessionId: liveSessionId },
    });
    check(
      "an agent refresh reopens a session the server had inferred closed",
      reopened?.logoutTime === null &&
        reopened?.logoutSource === null &&
        reopened?.totalActiveSeconds === 600,
      {
        logoutTime: reopened?.logoutTime,
        logoutSource: reopened?.logoutSource,
        totalActiveSeconds: reopened?.totalActiveSeconds,
      },
    );

    // And when it does report the real end, that is final.
    const observedLogout = new Date(now.getTime() - 60_000);
    await pushReapAttendance({
      sessionId: liveSessionId,
      loginTime: liveLogin.toISOString(),
      logoutTime: observedLogout.toISOString(),
      endReason: "Shutdown",
      workDate: liveLogin.toISOString().slice(0, 10),
      totalActiveSeconds: 900,
      totalIdleSeconds: 0,
    });

    await prisma.device.update({
      where: { id: reapDeviceRowId },
      data: { lastSeen: new Date(now.getTime() - wellPastAbandonMs) },
    });
    forgetDeviceLiveness(reapDeviceRowId);
    await reap(now);

    const observedRow = await prisma.attendanceSession.findUnique({
      where: { sessionId: liveSessionId },
    });
    check(
      "a sweep cannot revise a logout the workstation observed",
      observedRow?.logoutTime?.getTime() === observedLogout.getTime() &&
        observedRow?.endReason === "Shutdown" &&
        observedRow?.logoutSource === "Agent",
      {
        logoutTime: observedRow?.logoutTime,
        endReason: observedRow?.endReason,
        logoutSource: observedRow?.logoutSource,
      },
    );

    // -- Report date ranges --------------------------------------------------
    //
    // Not agent surface, but the failure it guards is invisible: a zero-width window empties
    // attendance, sessions and the timeline while the totals beside them still render, because
    // those read the rollup by day and everything else filters raw timestamps.
    console.log("\nReport date ranges");

    const singleDay = resolveRange("2026-08-15", "2026-08-15");
    check(
      "a date-only end bound includes the day it names",
      singleDay.start.toISOString() === "2026-08-15T00:00:00.000Z" &&
        singleDay.end.toISOString() === "2026-08-15T23:59:59.999Z",
      { start: singleDay.start, end: singleDay.end },
    );

    check("zero-duration formatting shows 0m", formatDuration(0) === "0m", formatDuration(0));

    // The "Today" preset sends startDate === endDate. Before the fix this window was zero-width.
    check(
      "a same-day range is a whole day, not an instant",
      singleDay.end.getTime() > singleDay.start.getTime(),
      { widthMs: singleDay.end.getTime() - singleDay.start.getTime() },
    );

    const explicitInstant = resolveRange("2026-08-15T00:00:00.000Z", "2026-08-15T09:30:00.000Z");
    check(
      "an explicit timestamp is not widened to the end of its day",
      explicitInstant.end.toISOString() === "2026-08-15T09:30:00.000Z",
      { end: explicitInstant.end },
    );

    const badRange = (() => {
      try {
        resolveRange("not-a-date", "2026-08-15");
        return null;
      } catch (error) {
        return error as { statusCode?: number };
      }
    })();
    check(
      "an unparseable bound is a 400, not a silent empty range",
      badRange?.statusCode === 400,
      badRange,
    );

    // -- Server-side categorization -----------------------------------------
    console.log("\nServer-side productivity categorization");

    await organizationService.upsertCategory(org.id, {
      pattern: "facebook.com",
      target: "Domain",
      tag: "Unproductive",
      isBlacklisted: true,
    });

    const blacklistedVisitId = randomUUID();
    await push("browser-activity", [
      {
        clientEventId: randomUUID(),
        browserActivityId: blacklistedVisitId,
        browser: "Chrome",
        domain: "m.facebook.com",
        rawUrl: "https://m.facebook.com/feed",
        protocol: "Https",
        startTime: earlier.toISOString(),
        endTime: now.toISOString(),
        durationSeconds: 60,
        // The agent claims this is fine; the server must override it from the admin's rules.
        productivityTag: "Productive",
      },
    ]);
    const blacklisted = await prisma.browserActivity.findUnique({
      where: { browserActivityId: blacklistedVisitId },
    });
    check(
      "server overrides the agent tag from admin category rules (subdomain match)",
      blacklisted?.productivityTag === "Blacklisted",
      blacklisted?.productivityTag,
    );

    // -- Department-based productivity categorization -----------------------
    console.log("\nDepartment-based productivity categorization");

    const engineeringDept = await organizationService.createDepartment(org.id, {
      name: "Engineering",
      description: "Software engineering team",
    });
    check(
      "creates a department successfully",
      engineeringDept.name === "Engineering",
      engineeringDept,
    );

    const salesDept = await organizationService.createDepartment(org.id, {
      name: "Sales",
      description: "Sales and BD team",
    });
    check("creates second department successfully", salesDept.name === "Sales", salesDept);

    // Set org-wide default: canva.com is Unproductive
    await organizationService.upsertCategory(org.id, {
      pattern: "canva.com",
      target: "Domain",
      tag: "Unproductive",
      isBlacklisted: false,
    });

    // Set department override: canva.com is Productive for Engineering
    await organizationService.upsertCategory(org.id, {
      pattern: "canva.com",
      target: "Domain",
      tag: "Productive",
      isBlacklisted: false,
      departmentId: engineeringDept.id,
    });

    // Set department blacklist: reddit.com is Blacklisted for Sales only
    await organizationService.upsertCategory(org.id, {
      pattern: "reddit.com",
      target: "Domain",
      tag: "Unproductive",
      isBlacklisted: true,
      departmentId: salesDept.id,
    });

    const orgDefaultCanva = await categoryService.categorizeDomain(org.id, "canva.com", null);
    check(
      "org-wide fallback applies when no department specified (canva -> Unproductive)",
      orgDefaultCanva?.tag === "Unproductive" && !orgDefaultCanva.isBlacklisted,
      orgDefaultCanva,
    );

    const deptCanva = await categoryService.categorizeDomain(
      org.id,
      "canva.com",
      engineeringDept.id,
    );
    check(
      "department-specific rule overrides org-wide default (Engineering canva -> Productive)",
      deptCanva?.tag === "Productive",
      deptCanva,
    );

    const salesReddit = await categoryService.categorizeDomain(org.id, "reddit.com", salesDept.id);
    check(
      "department-specific blacklist rule applies to that department (Sales reddit -> Blacklisted)",
      salesReddit?.tag === "Blacklisted" && salesReddit.isBlacklisted,
      salesReddit,
    );

    const engReddit = await categoryService.categorizeDomain(
      org.id,
      "reddit.com",
      engineeringDept.id,
    );
    check(
      "other departments do not inherit sales department blacklist",
      engReddit === null || engReddit.tag !== "Blacklisted",
      engReddit,
    );

    // Verify department category POST route exists and is handled (responds with 401 unauthenticated, never 404 Cannot POST)
    const unauthDeptCategory = await fetch(
      `${BASE}/v1/dashboard/organizations/${org.id}/departments/${engineeringDept.id}/categories`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pattern: "facebook.com",
          target: "Domain",
          tag: "Productive",
          isBlacklisted: false,
        }),
      },
    );
    const unauthBody = (await unauthDeptCategory.json()) as any;
    check(
      "department category POST route exists and is protected by auth (401 JSON, not 404 HTML)",
      unauthDeptCategory.status === 401 && typeof unauthBody?.error === "string",
      unauthBody,
    );

    // Verify unmatched route receives JSON 404 rather than Express default HTML
    const notFoundRes = await fetch(`${BASE}/v1/dashboard/nonexistent-endpoint-test`);
    const notFoundBody = (await notFoundRes.json()) as any;
    check(
      "unmatched dashboard endpoint returns JSON 404 instead of HTML",
      notFoundRes.status === 404 && typeof notFoundBody?.error === "string" && notFoundBody.error.includes("Endpoint not found"),
      notFoundBody,
    );

    // -- Fleet onboarding ----------------------------------------------------
    // A single org holds 30-100+ people, so both of these are the difference between a
    // ten-minute rollout and an afternoon of one-at-a-time API calls.
    console.log("\nFleet onboarding");

    const roster = [
      { name: "Ada Lovelace", email: `ada-${runId}@example.com`, department: "Engineering" },
      { name: "Grace Hopper", email: `grace-${runId}@example.com`, department: "Engineering" },
      // Same address as the first row, differently cased - must be caught before the insert,
      // because the database's unique constraint cannot see an in-payload duplicate.
      { name: "Ada L", email: `ADA-${runId}@example.com` },
    ];

    // Called at the service layer, like the categorization test below: these routes sit behind
    // a Better Auth dashboard session, and minting one here would test the auth stack rather
    // than the import logic this is about.
    const bulkImport = await employeeService.bulkCreateEmployees({
      organizationId: org.id,
      employees: roster,
    });

    check("bulk import creates a roster in one request", bulkImport.created === 2, bulkImport);
    check(
      "bulk import skips a case-insensitive duplicate inside the payload",
      bulkImport.skipped === 1 &&
        bulkImport.results[2]?.status === "skipped" &&
        /duplicate/i.test(bulkImport.results[2]?.reason ?? ""),
      bulkImport.results,
    );

    // Re-running an import is the normal case - an HR export with ten new hires appended to
    // ninety existing people must not fail or duplicate.
    const replayImport = await employeeService.bulkCreateEmployees({
      organizationId: org.id,
      employees: roster,
    });
    check(
      "re-importing the same roster creates nothing",
      replayImport.created === 0 && replayImport.skipped === 3,
      replayImport,
    );

    // The device enrolled at the top of this run is still on the placeholder employee. Assigning
    // it is the one manual step in enrollment, and until it happens the telemetry never reaches
    // per-employee reports.
    const targetEmployee = await prisma.employee.findUnique({
      where: { email: `ada-${runId}@example.com` },
    });
    await employeeService.assignDevice(deviceRowId, { employeeId: targetEmployee!.id });

    const assignedDevice = await prisma.device.findUnique({ where: { id: deviceRowId } });
    check(
      "device can be assigned off the Unassigned placeholder",
      assignedDevice?.employeeId === targetEmployee!.id,
      { employeeId: assignedDevice?.employeeId },
    );

    // Assign targetEmployee to engineeringDept and test policy endpoint resolution
    await organizationService.addDepartmentMembers(org.id, engineeringDept.id, {
      employeeIds: [targetEmployee!.id],
    });
    const assignedEmp = await prisma.employee.findUnique({ where: { id: targetEmployee!.id } });
    check(
      "employee is assigned to department",
      assignedEmp?.departmentId === engineeringDept.id,
      assignedEmp?.departmentId,
    );

    const deptPolicyRes = await fetch(`${BASE}/api/v1/policy`, { headers: auth });
    const deptPolicy = (await deptPolicyRes.json()) as any;
    const canvaPolicyRule = deptPolicy.categories?.find((c: any) => c.pattern === "canva.com");
    check(
      "device in engineering department receives department-specific rule (canva.com -> Productive)",
      canvaPolicyRule?.tag === "Productive" && canvaPolicyRule?.isBlacklisted === false,
      canvaPolicyRule,
    );
    const redditPolicyRule = deptPolicy.categories?.find((c: any) => c.pattern === "reddit.com");
    check(
      "device in engineering does not receive sales department blacklist rule",
      !redditPolicyRule || !redditPolicyRule.isBlacklisted,
      redditPolicyRule,
    );

    // -- Brave Browser Isolation & Aggregation Accuracy --------------------
    console.log("\nBrave Browser Isolation & Aggregation");

    const braveSessionId = randomUUID();
    const braveAppSessionId = randomUUID();
    const chromeAppSessionId = randomUUID();
    const testWorkDate = now.toISOString().slice(0, 10);

    // 1. Attendance session for targetEmployee
    await push("attendance", [
      {
        clientEventId: randomUUID(),
        sessionId: braveSessionId,
        userSid: "S-1-5-21-ada",
        loginTime: earlier.toISOString(),
        logoutTime: now.toISOString(),
        endReason: "Logout",
        workDate: testWorkDate,
        totalActiveSeconds: 240,
        totalIdleSeconds: 0,
      },
    ]);

    // 2. Brave activity session (120s)
    await push("activity-session", [
      {
        clientEventId: randomUUID(),
        activitySessionId: braveAppSessionId,
        sessionId: braveSessionId,
        appName: "Brave Browser",
        processName: "brave",
        executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
        type: "Application",
        windowTitle: "GitHub: Let's build from here - Brave",
        startTime: earlier.toISOString(),
        endTime: now.toISOString(),
        durationSeconds: 120,
        reason: "AppSwitch",
        productivityTag: "Productive",
      },
    ]);

    // 3. Browser activity visited inside Brave: only productive domain (github.com)
    await push("browser-activity", [
      {
        clientEventId: randomUUID(),
        browserActivityId: randomUUID(),
        activitySessionId: braveAppSessionId,
        browser: "Brave",
        browserVersion: "1.70.0",
        domain: "github.com",
        rawUrl: "https://github.com/microsoft/vscode",
        pageTitle: "GitHub - microsoft/vscode",
        protocol: "Https",
        startTime: earlier.toISOString(),
        endTime: now.toISOString(),
        durationSeconds: 120,
        productivityTag: "Productive",
      },
    ]);

    // 4. Chrome activity session (120s)
    await push("activity-session", [
      {
        clientEventId: randomUUID(),
        activitySessionId: chromeAppSessionId,
        sessionId: braveSessionId,
        appName: "Google Chrome",
        processName: "chrome",
        executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        type: "Application",
        windowTitle: "Facebook - Chrome",
        startTime: earlier.toISOString(),
        endTime: now.toISOString(),
        durationSeconds: 120,
        reason: "AppSwitch",
        productivityTag: "Productive",
      },
    ]);

    // 5. Browser activity visited inside Chrome: blacklisted domain (facebook.com)
    await push("browser-activity", [
      {
        clientEventId: randomUUID(),
        browserActivityId: randomUUID(),
        activitySessionId: chromeAppSessionId,
        browser: "Chrome",
        browserVersion: "130.0",
        domain: "facebook.com",
        rawUrl: "https://facebook.com/feed",
        pageTitle: "Facebook",
        protocol: "Https",
        startTime: earlier.toISOString(),
        endTime: now.toISOString(),
        durationSeconds: 120,
        productivityTag: "Productive",
      },
    ]);

    // Query employee detail to verify application and browser aggregation
    const employeeReport = await reportService.getEmployeeDetail(
      targetEmployee!.id,
      testWorkDate,
      testWorkDate,
    );

    const braveAppGroup = employeeReport.topApps.find((a: any) =>
      a.appName?.toLowerCase().includes("brave"),
    );
    const chromeAppGroup = employeeReport.topApps.find((a: any) =>
      a.appName?.toLowerCase().includes("chrome"),
    );

    check("Brave application group exists in employee report", !!braveAppGroup, braveAppGroup);
    check(
      "Brave has strictly ZERO unproductive seconds when only visiting clean/productive sites",
      braveAppGroup?.unproductiveSeconds === 0,
      { unproductiveSeconds: braveAppGroup?.unproductiveSeconds },
    );
    check(
      "Brave has strictly ZERO blacklisted seconds (not contaminated by Chrome's facebook visit)",
      braveAppGroup?.blacklistedSeconds === 0,
      { blacklistedSeconds: braveAppGroup?.blacklistedSeconds },
    );
    check(
      "Brave maintains its productive duration (120s)",
      braveAppGroup?.productiveSeconds === 120,
      { productiveSeconds: braveAppGroup?.productiveSeconds },
    );

    check(
      "Chrome application group reflects both blacklisted visits (180s total)",
      chromeAppGroup?.blacklistedSeconds === 180,
      { blacklistedSeconds: chromeAppGroup?.blacklistedSeconds },
    );

    // -- Fault-Tolerant Daily Summaries Backfilling ------------------------
    console.log("\nFault-Tolerant Daily Summaries Backfill");

    const backfilledCount = await backfillMissingDailySummaries(org.id);
    check(
      "backfillMissingDailySummaries runs cleanly without error",
      typeof backfilledCount === "number",
      { backfilledCount },
    );

    // -- Employee PDF Report Generation -------------------------------------
    console.log("\nEmployee PDF Report Generation");

    const pdfBuffer = await pdfReportService.generateEmployeeReportPdfBuffer(employeeReport as any);
    check(
      "generates a valid binary PDF buffer",
      Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 1000,
      { isBuffer: Buffer.isBuffer(pdfBuffer), length: pdfBuffer?.length },
    );
    check(
      "PDF buffer starts with standard PDF file header (%PDF)",
      pdfBuffer.subarray(0, 4).toString() === "%PDF",
      pdfBuffer.subarray(0, 8).toString(),
    );

    // -- Rate limiting -------------------------------------------------------
    // Enrollment is keyed per MachineGuid, not per source IP. This is what lets 100 machines
    // behind one office NAT enroll simultaneously instead of sharing a 10/min budget.
    console.log("\nRate limiting");

    const enrollBurst = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        fetch(`${BASE}/api/v1/device/enroll`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-enrollment-token": enrollmentToken },
          body: JSON.stringify({
            deviceId: `fleet-${runId}-${i}`,
            deviceName: `FLEET-PC-${i}`,
            macAddress: "00:11:22:33:44:66",
          }),
        }),
      ),
    );
    check(
      "25 distinct machines enroll at once without tripping the 10/min limit",
      enrollBurst.every((r) => r.status === 201),
      { statuses: [...new Set(enrollBurst.map((r) => r.status))] },
    );

    // ...while one machine hammering the same endpoint is still contained.
    const repeatBurst = await Promise.all(
      Array.from({ length: 14 }, () =>
        fetch(`${BASE}/api/v1/device/enroll`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-enrollment-token": enrollmentToken },
          body: JSON.stringify({
            deviceId: `repeat-${runId}`,
            deviceName: "REPEAT-PC",
            macAddress: "00:11:22:33:44:77",
          }),
        }),
      ),
    );
    check(
      "one machine hammering enrollment is still throttled",
      repeatBurst.some((r) => r.status === 429),
      { statuses: [...new Set(repeatBurst.map((r) => r.status))] },
    );

    // x-forwarded-for is only believed when TRUST_PROXY declares a proxy in front. Login is
    // IP-keyed at 10/min, so with the default (false) rotating the header must not create a
    // fresh bucket per request - the previous implementation read the header unconditionally
    // and could be bypassed exactly this way.
    const spoofed: number[] = [];
    for (let i = 0; i < 14; i++) {
      const res = await fetch(`${BASE}/v1/dashboard/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.9.9.${i}` },
        body: JSON.stringify({ email: `nobody-${runId}@example.com`, password: "wrong-password" }),
      });
      spoofed.push(res.status);
    }
    check(
      "rotating x-forwarded-for does not create a fresh rate-limit bucket",
      spoofed.includes(429),
      { statuses: [...new Set(spoofed)] },
    );

    // -- Realtime presence ---------------------------------------------------
    // The end-to-end path behind "Active now": agent socket -> heartbeat -> devices.lastSeen ->
    // dashboard event. Asserted over a real Socket.IO connection rather than by calling the
    // registry directly, because the handshake and the fan-out are most of what can break.
    console.log("\nRealtime presence");

    // The dashboard namespace resolves its organization with currentOrganizationId() - the
    // deployment is single-tenant, so there is no user->organization link to read. This test
    // creates its own throwaway organization, which is therefore NOT the one a dashboard joins,
    // so the presence assertions need an agent inside the resolved organization instead.
    //
    // Built directly through Prisma rather than by enrolling over HTTP: the resolved organization
    // is whatever the developer's database already had, and it may have no enrollment token.
    const presenceOrgId = await currentOrganizationId();
    const presenceEmployee = await prisma.employee.upsert({
      where: { email: `smoke-presence+${runId}@local.invalid` },
      create: {
        organizationId: presenceOrgId,
        email: `smoke-presence+${runId}@local.invalid`,
        name: "Smoke Presence",
        status: "placeholder",
      },
      update: {},
    });

    presenceEmployeeId = presenceEmployee.id;

    const presenceApiKey = generateDeviceApiKey();
    presenceDeviceRowId = (
      await prisma.device.create({
        data: {
          organizationId: presenceOrgId,
          employeeId: presenceEmployee.id,
          deviceId: `smoke-presence-${runId}`,
          deviceName: "SMOKE-PRESENCE-PC",
          apiKeyHash: hashDeviceApiKey(presenceApiKey),
        },
        select: { id: true },
      })
    ).id;

    const agentSocket = ioClient(`${BASE}/agents`, {
      auth: { apiKey: presenceApiKey },
      transports: ["websocket"],
      reconnection: false,
    });

    const agentConnected = await waitFor<boolean>((resolve) => {
      agentSocket.on("connect", () => resolve(true));
      agentSocket.on("connect_error", () => resolve(false));
    });
    check("an agent can open a socket with its device API key", agentConnected === true);

    const rejected = ioClient(`${BASE}/agents`, {
      auth: { apiKey: "not-a-real-key" },
      transports: ["websocket"],
      reconnection: false,
    });
    const rejectedConnected = await waitFor<boolean>((resolve) => {
      rejected.on("connect", () => resolve(true));
      rejected.on("connect_error", () => resolve(false));
    });
    check("a socket presenting a bad key is refused", rejectedConnected === false);
    rejected.close();

    // A dashboard connects with a short-lived ticket, never the session token.
    const { ticket } = issueRealtimeTicket({ userId: "smoke-admin", role: "super_admin" });
    const dashboardSocket = ioClient(`${BASE}/dashboard`, {
      auth: { ticket },
      transports: ["websocket"],
      reconnection: false,
    });

    const snapshot = await waitFor<any>((resolve) => {
      dashboardSocket.on("device:presence-snapshot", resolve);
      dashboardSocket.on("connect_error", () => resolve(null));
    });
    check(
      "a dashboard authenticates with a realtime ticket and receives a presence snapshot",
      snapshot !== null && Array.isArray(snapshot?.devices),
      snapshot,
    );
    check(
      "the snapshot carries the silence window so the client need not hardcode it",
      typeof snapshot?.maxSilenceMs === "number" && snapshot.maxSilenceMs > 0,
      snapshot?.maxSilenceMs,
    );
    check(
      "the connected agent is present in the snapshot",
      snapshot?.devices?.some((d: any) => d.deviceId === presenceDeviceRowId),
      snapshot?.devices,
    );

    const forgedTicket = ioClient(`${BASE}/dashboard`, {
      auth: { ticket: "smoke-admin.super_admin.99999999999.forged" },
      transports: ["websocket"],
      reconnection: false,
    });
    const forgedConnected = await waitFor<boolean>((resolve) => {
      forgedTicket.on("connect", () => resolve(true));
      forgedTicket.on("connect_error", () => resolve(false));
    });
    check("a forged realtime ticket is refused", forgedConnected === false);
    forgedTicket.close();

    // Clear lastSeen so the assertion below cannot pass on a value an earlier HTTP call wrote.
    await prisma.device.update({ where: { id: presenceDeviceRowId }, data: { lastSeen: null } });
    forgetDeviceLiveness(presenceDeviceRowId);

    const presenceEvent = await waitFor<any>((resolve) => {
      dashboardSocket.on("device:presence", resolve);
      agentSocket.emit("agent:heartbeat", { userPresent: true });
    });

    check(
      "a heartbeat reaches the dashboard as a presence event",
      presenceEvent?.deviceId === presenceDeviceRowId,
      presenceEvent,
    );
    check(
      "the presence event reports the device as live",
      presenceEvent?.live === true,
      presenceEvent,
    );
    check(
      "the presence event carries whether a user is at the workstation",
      presenceEvent?.userPresent === true,
      presenceEvent,
    );

    const afterHeartbeat = await prisma.device.findUnique({
      where: { id: presenceDeviceRowId },
      select: { lastSeen: true },
    });
    check(
      "a socket heartbeat updates devices.lastSeen",
      afterHeartbeat?.lastSeen !== null,
      afterHeartbeat,
    );

    // The point of aggregating at ingest: the dashboard is handed the result, so its totals move
    // without asking the server anything.
    // activity_sessions.sessionId is a required FK onto attendance_sessions, so the parent has to
    // exist first. The agent guarantees this by pushing attendance ahead of activity in every
    // sync cycle (SyncWorker.SyncOnceAsync orders the channels for exactly this reason).
    const presenceHeaders = {
      authorization: `Bearer ${presenceApiKey}`,
      "content-type": "application/json",
    };
    const presenceSessionId = randomUUID();

    await fetch(`${BASE}/api/v1/events/attendance`, {
      method: "POST",
      headers: presenceHeaders,
      body: JSON.stringify({
        batchId: randomUUID(),
        events: [
          {
            clientEventId: randomUUID(),
            sessionId: presenceSessionId,
            userSid: "S-1-5-21-presence",
            loginTime: earlier.toISOString(),
            logoutTime: null,
            workDate: now.toISOString().slice(0, 10),
            totalActiveSeconds: 0,
            totalIdleSeconds: 0,
          },
        ],
      }),
    });

    const ingestEvent = await waitFor<any>((resolve) => {
      dashboardSocket.on("telemetry:ingested", (payload: any) => {
        // Ignore the attendance batch above, which may still be in flight.
        if (payload?.channel === "activity-session") resolve(payload);
      });

      void fetch(`${BASE}/api/v1/events/activity-session`, {
        method: "POST",
        headers: presenceHeaders,
        body: JSON.stringify({
          batchId: randomUUID(),
          events: [
            {
              clientEventId: randomUUID(),
              activitySessionId: randomUUID(),
              sessionId: presenceSessionId,
              appName: "Live Totals Test",
              processName: "live",
              type: "Application",
              startTime: earlier.toISOString(),
              endTime: now.toISOString(),
              durationSeconds: 120,
              productivityTag: "Productive",
            },
          ],
        }),
      });
    });

    check(
      "an ingested batch reaches the dashboard",
      ingestEvent?.deviceId === presenceDeviceRowId,
      ingestEvent,
    );
    check(
      "the event carries the aggregate the batch produced, not just a hint",
      ingestEvent?.delta?.activeSeconds === 120 && ingestEvent?.delta?.activitySessionCount === 1,
      ingestEvent?.delta,
    );
    check(
      "the event names the employee so a per-row total can be moved",
      typeof ingestEvent?.employeeId === "string" && ingestEvent.employeeId.length > 0,
      ingestEvent?.employeeId,
    );
    check(
      "the event reports how many events were genuinely stored",
      ingestEvent?.eventCount === 1,
      ingestEvent?.eventCount,
    );

    // Disconnecting must announce the departure, so a dashboard does not hold a green dot for a
    // machine that has gone.
    const departure = await waitFor<any>((resolve) => {
      dashboardSocket.on("device:presence", (payload: any) => {
        if (payload?.connected === false) resolve(payload);
      });
      agentSocket.close();
    });
    check(
      "a disconnect is announced as a presence change",
      departure?.deviceId === presenceDeviceRowId && departure?.connected === false,
      departure,
    );

    dashboardSocket.close();

    // -- Deactivation kill switch -------------------------------------------
    console.log("\nAdmin kill switch");

    await prisma.device.update({ where: { id: deviceRowId }, data: { isActive: false } });
    const deactivated = await fetch(`${BASE}/api/v1/heartbeat`, { headers: auth });
    check("deactivated device gets 403, not 401", deactivated.status === 403, deactivated.status);
  } finally {
    // -- Teardown: cascade from the organization removes every row this test made.
    // The screenshot bytes live outside the database, so they need their own cleanup.
    if (deviceRowId) {
      await fs
        .rm(path.join(env.SCREENSHOT_STORAGE_DIR, deviceRowId), { recursive: true, force: true })
        .catch(() => undefined);
    }
    // The presence fixtures live in the resolved organization, which this test must not delete -
    // it is the developer's real one. Removed individually instead.
    if (presenceDeviceRowId) {
      await prisma.device.delete({ where: { id: presenceDeviceRowId } }).catch(() => undefined);
    }
    if (presenceEmployeeId) {
      await prisma.employee.delete({ where: { id: presenceEmployeeId } }).catch(() => undefined);
    }
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined);
    await prisma.$disconnect();
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nSmoke test crashed:", err);
  process.exit(1);
});
