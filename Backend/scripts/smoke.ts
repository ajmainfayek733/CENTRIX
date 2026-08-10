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
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import app, { server } from '../src/server';
import { prisma } from '../src/config/db';
import { env } from '../src/config/env';
import { organizationService } from '../src/modules/organization/organizationService';
import { employeeService } from '../src/modules/employee/employeeService';

const BASE = `http://127.0.0.1:${env.PORT}`;

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
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
  let apiKey = '';
  let deviceRowId = '';

  try {
    // -- Enrollment ----------------------------------------------------------
    console.log('Device enrollment');

    const badEnroll = await fetch(`${BASE}/api/v1/device/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-enrollment-token': 'wrong-token' },
      body: JSON.stringify({ deviceId: machineGuid, deviceName: 'SMOKE-PC', macAddress: '00:11:22:33:44:55' }),
    });
    check('rejects an invalid enrollment token with 401', badEnroll.status === 401, badEnroll.status);

    const enrollRes = await fetch(`${BASE}/api/v1/device/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-enrollment-token': enrollmentToken },
      body: JSON.stringify({
        deviceId: machineGuid,
        deviceName: 'SMOKE-PC',
        systemType: '64-bit operating system, x64-based processor',
        edition: 'Windows 11 Pro',
        version: '10.0.26200',
        macAddress: '00:11:22:33:44:55',
        agentVersion: '3.0.0',
      }),
    });
    const enrollBody = (await enrollRes.json()) as any;
    check('enrolls a new device with 201', enrollRes.status === 201, enrollBody);
    check('returns a device API key exactly once', typeof enrollBody.apiKey === 'string' && enrollBody.apiKey.length > 0);

    apiKey = enrollBody.apiKey;
    deviceRowId = enrollBody.deviceId;

    const storedDevice = await prisma.device.findUnique({ where: { deviceId: machineGuid } });
    check('persists device columns individually', storedDevice?.edition === 'Windows 11 Pro' && storedDevice?.version === '10.0.26200', {
      edition: storedDevice?.edition,
      version: storedDevice?.version,
    });

    const auth = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };

    // -- Auth boundaries -----------------------------------------------------
    console.log('\nAuthentication');

    const noAuth = await fetch(`${BASE}/api/v1/heartbeat`);
    check('rejects a missing credential with 401', noAuth.status === 401, noAuth.status);

    const badAuth = await fetch(`${BASE}/api/v1/heartbeat`, { headers: { authorization: 'Bearer nope' } });
    check('rejects an unknown credential with 401', badAuth.status === 401, badAuth.status);

    const heartbeat = await fetch(`${BASE}/api/v1/heartbeat`, { headers: auth });
    const heartbeatBody = (await heartbeat.json()) as any;
    check('heartbeat authorizes a valid device', heartbeat.status === 200 && heartbeatBody.authenticated === true, heartbeatBody);

    // -- Policy --------------------------------------------------------------
    console.log('\nPolicy');

    const policyRes = await fetch(`${BASE}/api/v1/policy`, { headers: auth });
    const policy = (await policyRes.json()) as any;
    check('serves a versioned policy document', policyRes.status === 200 && typeof policy.version === 'number', policy);
    check('policy carries the 5-minute idle default', policy.activity?.idleThresholdSeconds === 300, policy.activity);
    check('policy carries the 30/45/60-minute idle escalation',
      policy.alert?.idle?.normalSeconds === 1800 &&
      policy.alert?.idle?.moderateSeconds === 2700 &&
      policy.alert?.idle?.severeSeconds === 3600,
      policy.alert?.idle
    );

    // -- Telemetry channels --------------------------------------------------
    console.log('\nTelemetry ingest');

    const sessionId = randomUUID();
    const activitySessionId = randomUUID();
    const now = new Date();
    const earlier = new Date(now.getTime() - 60_000);

    async function push(channel: string, events: unknown[]) {
      const res = await fetch(`${BASE}/api/v1/events/${channel}`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ events }),
      });
      return { status: res.status, body: (await res.json()) as any };
    }

    const attendance = await push('attendance', [
      {
        clientEventId: randomUUID(),
        sessionId,
        userSid: 'S-1-5-21-smoke',
        loginTime: earlier.toISOString(),
        logoutTime: null,
        workDate: now.toISOString().slice(0, 10),
        totalActiveSeconds: 45,
        totalIdleSeconds: 15,
      },
    ]);
    check('accepts an attendance session', attendance.status === 200, attendance.body);

    const metric = await push('activity-metric', [
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
    check('accepts an activity metric', metric.status === 200, metric.body);

    const activity = await push('activity-session', [
      {
        clientEventId: randomUUID(),
        activitySessionId,
        sessionId,
        appName: 'Visual Studio Code',
        processName: 'Code',
        executablePath: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
        type: 'Application',
        windowTitle: 'schema.prisma',
        startTime: earlier.toISOString(),
        endTime: now.toISOString(),
        durationSeconds: 60,
        reason: 'AppSwitch',
        productivityTag: 'Productive',
      },
    ]);
    check('accepts an activity session', activity.status === 200, activity.body);

    const browser = await push('browser-activity', [
      {
        clientEventId: randomUUID(),
        browserActivityId: randomUUID(),
        activitySessionId,
        browser: 'Chrome',
        browserVersion: '141.0',
        profileName: 'Default',
        domain: 'github.com',
        rawUrl: 'https://github.com/anthropics',
        pageTitle: 'GitHub',
        protocol: 'Https',
        startTime: earlier.toISOString(),
        endTime: now.toISOString(),
        durationSeconds: 60,
        productivityTag: 'Neutral',
      },
    ]);
    check('accepts a browser visit', browser.status === 200, browser.body);

    const usb = await push('usb-event', [
      {
        clientEventId: randomUUID(),
        sessionId,
        eventType: 'Connected',
        deviceType: 'UsbStorage',
        friendlyName: 'SanDisk Ultra',
        manufacturer: 'SanDisk',
        serialNumber: `SN-${runId}`,
        vendorId: '0781',
        productId: '5583',
        driveLetter: 'E:',
        volumeLabel: 'BACKUP',
        capacityBytes: '64023257088',
        fileSystem: 'exFAT',
        eventTime: now.toISOString(),
      },
    ]);
    check('accepts a USB event', usb.status === 200, usb.body);

    const alertId = randomUUID();
    const alertPush = await push('alert', [
      {
        clientEventId: alertId,
        userSid: 'S-1-5-21-smoke',
        type: 'IdleThreshold',
        severity: 'Warning',
        state: 'New',
        title: 'Idle for 30 minutes',
        message: 'No input detected for 30 minutes.',
        idleSeconds: 1800,
        thresholdSeconds: 1800,
        triggeredAt: now.toISOString(),
        escalationLevel: 1,
        notificationCount: 1,
      },
    ]);
    check('accepts an alert', alertPush.status === 200, alertPush.body);

    // -- Request size --------------------------------------------------------
    // Express defaults to a 100kb JSON body. A full agent batch of activity sessions carrying
    // window titles and executable paths exceeds that, and every push 413'd in normal operation.
    console.log('\nRequest size limits');

    // ~250 bytes of title per event x 600 events -> comfortably past the old 100kb default.
    const bulkSessions = Array.from({ length: 600 }, () => ({
      clientEventId: randomUUID(),
      activitySessionId: randomUUID(),
      sessionId,
      appName: 'Visual Studio Code',
      processName: 'Code',
      executablePath: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      type: 'Application',
      windowTitle: `schema.prisma — ${'employee-tracker/'.repeat(14)}`,
      startTime: earlier.toISOString(),
      endTime: now.toISOString(),
      durationSeconds: 60,
      productivityTag: 'Productive',
    }));

    const bulkBytes = Buffer.byteLength(JSON.stringify({ events: bulkSessions }));
    const bulk = await push('activity-session', bulkSessions);
    check(`accepts a ${Math.round(bulkBytes / 1024)}kb batch (over the old 100kb default)`,
      bulk.status === 200 && bulkBytes > 102400,
      { status: bulk.status, bulkBytes }
    );
    check('acknowledges every event in a large batch',
      bulk.body?.acknowledgedEventIds?.length === bulkSessions.length,
      { acked: bulk.body?.acknowledgedEventIds?.length, sent: bulkSessions.length }
    );

    // Past the ceiling the server still refuses — but with an actionable body, not a stack trace.
    const oversized = await fetch(`${BASE}/api/v1/events/activity-session`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ events: [{ clientEventId: randomUUID(), filler: 'x'.repeat(3 * 1024 * 1024) }] }),
    });
    const oversizedBody = (await oversized.json()) as any;
    check('rejects a body past the ceiling with an actionable 413',
      oversized.status === 413 && typeof oversizedBody.limitBytes === 'number' && !!oversizedBody.remedy,
      { status: oversized.status, body: oversizedBody }
    );

    // -- Screenshot upload ---------------------------------------------------
    // Multipart, not JSON, and therefore the one endpoint whose wire contract the per-channel
    // Zod schemas do not cover. It shipped broken once because the Agent posted the image under
    // a different field name than multer was configured for, and every upload 400'd.
    console.log('\nScreenshot upload');

    const screenshotId = randomUUID();

    async function uploadScreenshot(fieldName: string, clientEventId: string) {
      // Smallest thing that is unambiguously a JPEG: SOI + APP0/JFIF header + EOI. The endpoint
      // filters on the declared mimetype, and nothing downstream decodes the pixels.
      const jpeg = new Uint8Array([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
        0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
      ]);

      const form = new FormData();
      form.set('clientEventId', clientEventId);
      form.set('capturedAtUtc', now.toISOString());
      form.set('userSid', 'S-1-5-21-smoke');
      form.set('width', '1920');
      form.set('height', '1080');
      form.set(fieldName, new Blob([jpeg], { type: 'image/jpeg' }), 'capture.jpg');

      // No content-type header: fetch sets it with the generated multipart boundary.
      const res = await fetch(`${BASE}/api/v1/screenshots`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      });
      return { status: res.status, body: (await res.json()) as any };
    }

    const shotUpload = await uploadScreenshot('file', screenshotId);
    check('accepts a screenshot posted under the "file" field', shotUpload.status === 200, shotUpload.body);

    const storedShot = await prisma.screenshot.findUnique({ where: { clientEventId: screenshotId } });
    check('screenshot metadata lands in typed columns',
      storedShot?.width === 1920 && storedShot?.height === 1080 && (storedShot?.sizeBytes ?? 0) > 0,
      storedShot
    );

    const wrongField = await uploadScreenshot('screenshot', randomUUID());
    check('rejects a wrong field name with 400 and names the expected field',
      wrongField.status === 400 && wrongField.body?.expectedField === 'file',
      wrongField.body
    );

    // -- Validation ----------------------------------------------------------
    console.log('\nValidation');

    const badChannel = await push('not-a-channel', [{ clientEventId: randomUUID() }]);
    check('rejects an unknown channel with 400', badChannel.status === 400, badChannel.status);

    const badEnum = await push('activity-session', [
      {
        clientEventId: randomUUID(),
        activitySessionId: randomUUID(),
        sessionId,
        type: 'NotAValidType',
        startTime: earlier.toISOString(),
        endTime: now.toISOString(),
        durationSeconds: 60,
      },
    ]);
    check('rejects an out-of-range enum with 400', badEnum.status === 400, badEnum.body);

    const badShape = await push('activity-metric', [
      { clientEventId: randomUUID(), sessionId, keyCount: -5, windowStartUtc: earlier.toISOString(), windowEndUtc: now.toISOString() },
    ]);
    check('rejects a negative count with 400', badShape.status === 400, badShape.body);

    // -- Column-level persistence -------------------------------------------
    console.log('\nTyped column persistence');

    const storedMetric = await prisma.activityMetric.findFirst({ where: { sessionId } });
    check('activity metric lands in discrete count columns',
      storedMetric?.keyCount === 412 && storedMetric?.mouseLeftKeyCount === 70 && storedMetric?.mouseRightKeyCount === 20,
      storedMetric
    );

    const storedActivity = await prisma.activitySession.findUnique({ where: { activitySessionId } });
    check('activity session lands in discrete columns',
      storedActivity?.appName === 'Visual Studio Code' && storedActivity?.type === 'Application' && storedActivity?.durationSeconds === 60,
      storedActivity
    );

    const storedBrowser = await prisma.browserActivity.findFirst({ where: { deviceId: deviceRowId } });
    check('browser visit links to its activity session',
      storedBrowser?.activitySessionId === activitySessionId && storedBrowser?.domain === 'github.com',
      storedBrowser
    );

    const storedUsb = await prisma.usbEvent.findFirst({ where: { serialNumber: `SN-${runId}` } });
    check('USB capacity survives as a 64-bit integer',
      storedUsb?.capacityBytes === 64023257088n,
      storedUsb?.capacityBytes?.toString()
    );

    const storedAlert = await prisma.alert.findUnique({ where: { clientEventId: alertId } });
    check('alert context lands in typed columns, not a JSON string',
      storedAlert?.idleSeconds === 1800 && storedAlert?.thresholdSeconds === 1800,
      storedAlert
    );

    // -- Idempotency ---------------------------------------------------------
    console.log('\nIdempotency (at-least-once delivery)');

    const replay = await push('activity-session', [
      {
        clientEventId: randomUUID(),
        activitySessionId,
        sessionId,
        appName: 'Visual Studio Code',
        processName: 'Code',
        type: 'Application',
        startTime: earlier.toISOString(),
        endTime: now.toISOString(),
        durationSeconds: 60,
        productivityTag: 'Productive',
      },
    ]);
    const activityCount = await prisma.activitySession.count({ where: { activitySessionId } });
    check('replayed activity session does not duplicate', replay.status === 200 && activityCount === 1, { activityCount });

    const alertReplay = await push('alert', [
      {
        clientEventId: alertId,
        userSid: 'S-1-5-21-smoke',
        type: 'IdleThreshold',
        severity: 'High',
        state: 'Shown',
        title: 'Idle for 45 minutes',
        message: 'No input detected for 45 minutes.',
        idleSeconds: 2700,
        thresholdSeconds: 2700,
        triggeredAt: now.toISOString(),
        escalationLevel: 2,
        notificationCount: 2,
      },
    ]);
    const escalated = await prisma.alert.findUnique({ where: { clientEventId: alertId } });
    const alertCount = await prisma.alert.count({ where: { clientEventId: alertId } });
    check('re-sent alert escalates in place rather than duplicating',
      alertReplay.status === 200 && alertCount === 1 && escalated?.severity === 'High' && escalated?.escalationLevel === 2,
      { alertCount, severity: escalated?.severity }
    );

    const attendanceReplay = await push('attendance', [
      {
        clientEventId: randomUUID(),
        sessionId,
        userSid: 'S-1-5-21-smoke',
        loginTime: earlier.toISOString(),
        logoutTime: now.toISOString(),
        endReason: 'Shutdown',
        workDate: now.toISOString().slice(0, 10),
        totalActiveSeconds: 60,
        totalIdleSeconds: 15,
      },
    ]);
    const attendanceRow = await prisma.attendanceSession.findUnique({ where: { sessionId } });
    check('re-sent attendance fills in the logout time',
      attendanceReplay.status === 200 && attendanceRow?.logoutTime !== null && attendanceRow?.endReason === 'Shutdown',
      { logoutTime: attendanceRow?.logoutTime, endReason: attendanceRow?.endReason }
    );

    // -- Server-side categorization -----------------------------------------
    console.log('\nServer-side productivity categorization');

    await organizationService.upsertCategory(org.id, {
      pattern: 'facebook.com',
      target: 'Domain',
      tag: 'Unproductive',
      isBlacklisted: true,
    });

    const blacklistedVisitId = randomUUID();
    await push('browser-activity', [
      {
        clientEventId: randomUUID(),
        browserActivityId: blacklistedVisitId,
        browser: 'Chrome',
        domain: 'm.facebook.com',
        rawUrl: 'https://m.facebook.com/feed',
        protocol: 'Https',
        startTime: earlier.toISOString(),
        endTime: now.toISOString(),
        durationSeconds: 60,
        // The agent claims this is fine; the server must override it from the admin's rules.
        productivityTag: 'Productive',
      },
    ]);
    const blacklisted = await prisma.browserActivity.findUnique({ where: { browserActivityId: blacklistedVisitId } });
    check('server overrides the agent tag from admin category rules (subdomain match)',
      blacklisted?.productivityTag === 'Blacklisted',
      blacklisted?.productivityTag
    );

    // -- Fleet onboarding ----------------------------------------------------
    // A single org holds 30-100+ people, so both of these are the difference between a
    // ten-minute rollout and an afternoon of one-at-a-time API calls.
    console.log('\nFleet onboarding');

    const roster = [
      { name: 'Ada Lovelace', email: `ada-${runId}@example.com`, department: 'Engineering' },
      { name: 'Grace Hopper', email: `grace-${runId}@example.com`, department: 'Engineering' },
      // Same address as the first row, differently cased — must be caught before the insert,
      // because the database's unique constraint cannot see an in-payload duplicate.
      { name: 'Ada L', email: `ADA-${runId}@example.com` },
    ];

    // Called at the service layer, like the categorization test below: these routes sit behind
    // a Better Auth dashboard session, and minting one here would test the auth stack rather
    // than the import logic this is about.
    const bulkImport = await employeeService.bulkCreateEmployees({ organizationId: org.id, employees: roster });

    check('bulk import creates a roster in one request', bulkImport.created === 2, bulkImport);
    check('bulk import skips a case-insensitive duplicate inside the payload',
      bulkImport.skipped === 1 &&
        bulkImport.results[2]?.status === 'skipped' &&
        /duplicate/i.test(bulkImport.results[2]?.reason ?? ''),
      bulkImport.results
    );

    // Re-running an import is the normal case — an HR export with ten new hires appended to
    // ninety existing people must not fail or duplicate.
    const replayImport = await employeeService.bulkCreateEmployees({ organizationId: org.id, employees: roster });
    check('re-importing the same roster creates nothing',
      replayImport.created === 0 && replayImport.skipped === 3,
      replayImport
    );

    // The device enrolled at the top of this run is still on the placeholder employee. Assigning
    // it is the one manual step in enrollment, and until it happens the telemetry never reaches
    // per-employee reports.
    const targetEmployee = await prisma.employee.findUnique({ where: { email: `ada-${runId}@example.com` } });
    await employeeService.assignDevice(deviceRowId, { employeeId: targetEmployee!.id });

    const assignedDevice = await prisma.device.findUnique({ where: { id: deviceRowId } });
    check('device can be assigned off the Unassigned placeholder',
      assignedDevice?.employeeId === targetEmployee!.id,
      { employeeId: assignedDevice?.employeeId }
    );

    // -- Rate limiting -------------------------------------------------------
    // Enrollment is keyed per MachineGuid, not per source IP. This is what lets 100 machines
    // behind one office NAT enroll simultaneously instead of sharing a 10/min budget.
    console.log('\nRate limiting');

    const enrollBurst = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        fetch(`${BASE}/api/v1/device/enroll`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-enrollment-token': enrollmentToken },
          body: JSON.stringify({
            deviceId: `fleet-${runId}-${i}`,
            deviceName: `FLEET-PC-${i}`,
            macAddress: '00:11:22:33:44:66',
          }),
        })
      )
    );
    check('25 distinct machines enroll at once without tripping the 10/min limit',
      enrollBurst.every((r) => r.status === 201),
      { statuses: [...new Set(enrollBurst.map((r) => r.status))] }
    );

    // ...while one machine hammering the same endpoint is still contained.
    const repeatBurst = await Promise.all(
      Array.from({ length: 14 }, () =>
        fetch(`${BASE}/api/v1/device/enroll`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-enrollment-token': enrollmentToken },
          body: JSON.stringify({
            deviceId: `repeat-${runId}`,
            deviceName: 'REPEAT-PC',
            macAddress: '00:11:22:33:44:77',
          }),
        })
      )
    );
    check('one machine hammering enrollment is still throttled',
      repeatBurst.some((r) => r.status === 429),
      { statuses: [...new Set(repeatBurst.map((r) => r.status))] }
    );

    // x-forwarded-for is only believed when TRUST_PROXY declares a proxy in front. Login is
    // IP-keyed at 10/min, so with the default (false) rotating the header must not create a
    // fresh bucket per request — the previous implementation read the header unconditionally
    // and could be bypassed exactly this way.
    const spoofed: number[] = [];
    for (let i = 0; i < 14; i++) {
      const res = await fetch(`${BASE}/v1/dashboard/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.9.${i}` },
        body: JSON.stringify({ email: `nobody-${runId}@example.com`, password: 'wrong-password' }),
      });
      spoofed.push(res.status);
    }
    check('rotating x-forwarded-for does not create a fresh rate-limit bucket',
      spoofed.includes(429),
      { statuses: [...new Set(spoofed)] }
    );

    // -- Deactivation kill switch -------------------------------------------
    console.log('\nAdmin kill switch');

    await prisma.device.update({ where: { id: deviceRowId }, data: { isActive: false } });
    const deactivated = await fetch(`${BASE}/api/v1/heartbeat`, { headers: auth });
    check('deactivated device gets 403, not 401', deactivated.status === 403, deactivated.status);
  } finally {
    // -- Teardown: cascade from the organization removes every row this test made.
    // The screenshot bytes live outside the database, so they need their own cleanup.
    if (deviceRowId) {
      await fs.rm(path.join(env.SCREENSHOT_STORAGE_DIR, deviceRowId), { recursive: true, force: true }).catch(() => undefined);
    }
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined);
    await prisma.$disconnect();
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err);
  process.exit(1);
});
