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
import app, { server } from '../src/server';
import { prisma } from '../src/config/db';
import { env } from '../src/config/env';
import { organizationService } from '../src/modules/organization/organizationService';

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

    // -- Deactivation kill switch -------------------------------------------
    console.log('\nAdmin kill switch');

    await prisma.device.update({ where: { id: deviceRowId }, data: { isActive: false } });
    const deactivated = await fetch(`${BASE}/api/v1/heartbeat`, { headers: auth });
    check('deactivated device gets 403, not 401', deactivated.status === 403, deactivated.status);
  } finally {
    // -- Teardown: cascade from the organization removes every row this test made.
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
