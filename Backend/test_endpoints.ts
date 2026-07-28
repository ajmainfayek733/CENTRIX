/**
 * Smoke test for the Agent-facing surface (docs/backend-api-specification.md §4), run against
 * the real Express app with an in-memory Prisma mock so it needs no live database. Covers the
 * behaviors the spec calls out as load-bearing: bearer auth (401 unknown, 403 deactivated),
 * per-clientEventId idempotency on POST /api/v1/events/{channel}, and GET /api/v1/policy always
 * returning a full versioned document.
 */
import { prisma as realPrisma } from './src/config/db';
import { hashDeviceApiKey } from './src/utils/token';
import { env } from './src/config/env';

const ACTIVE_DEVICE = {
  id: 'device-01',
  organizationId: 'org-01',
  employeeId: 'employee-01',
  machineId: 'machine-guid-01',
  hostname: 'desktop-01',
  os: 'Windows 11',
  isActive: true,
  apiKeyHash: hashDeviceApiKey('valid-device-key'),
};

const DEACTIVATED_DEVICE = {
  id: 'device-02',
  organizationId: 'org-01',
  employeeId: 'employee-02',
  machineId: 'machine-guid-02',
  hostname: 'desktop-02',
  os: 'Windows 11',
  isActive: false,
  apiKeyHash: hashDeviceApiKey('deactivated-device-key'),
};

const devicesByApiKeyHash = new Map([
  [ACTIVE_DEVICE.apiKeyHash, ACTIVE_DEVICE],
  [DEACTIVATED_DEVICE.apiKeyHash, DEACTIVATED_DEVICE],
]);

const telemetryEvents: any[] = [];
const alerts = new Map<string, any>();
const policies = new Map<string, any>([['org-01', { organizationId: 'org-01', version: 3, document: { WorkingHours: { StartLocal: '08:00:00' } } }]]);
const consentRecords = new Map<string, any>();

const fakePrisma = new Proxy(realPrisma, {
  get(target, prop) {
    if (prop === 'device') {
      return {
        findUnique: async (args: any) => devicesByApiKeyHash.get(args.where.apiKeyHash) ?? null,
        update: async (args: any) => ({ ...(devicesByApiKeyHash.get(args.where.id) ?? {}) }),
      };
    }

    if (prop === 'telemetryEvent') {
      return {
        createMany: async (args: any) => {
          let inserted = 0;
          for (const row of args.data) {
            const exists = telemetryEvents.some((e) => e.channel === row.channel && e.clientEventId === row.clientEventId);
            if (exists && args.skipDuplicates) continue;
            telemetryEvents.push(row);
            inserted++;
          }
          return { count: inserted };
        },
      };
    }

    if (prop === 'alert') {
      return {
        upsert: async (args: any) => {
          const row = { ...(alerts.get(args.where.clientEventId) ?? args.create), ...args.update };
          alerts.set(args.where.clientEventId, row);
          return row;
        },
      };
    }

    if (prop === 'policy') {
      return {
        upsert: async (args: any) => {
          const existing = policies.get(args.where.organizationId);
          if (existing) return existing;
          const created = { organizationId: args.where.organizationId, ...args.create };
          policies.set(args.where.organizationId, created);
          return created;
        },
      };
    }

    if (prop === 'consentRecord') {
      return {
        upsert: async (args: any) => {
          const key = JSON.stringify(args.where.userSid_machineId_policyVersion);
          const row = { ...(consentRecords.get(key) ?? args.create), ...args.update };
          consentRecords.set(key, row);
          return row;
        },
      };
    }

    if (prop === '$transaction') {
      return async (arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg((fakePrisma as any)));
    }

    return (target as any)[prop];
  },
});

const dbPath = require.resolve('./src/config/db');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { prisma: fakePrisma },
} as any;

console.log('1. Hijacked require.cache for db module');

const app = require('./src/server').default;

async function waitForServer(url: string, maxRetries = 15, delayMs = 500) {
  console.log(`Polling server health at ${url}/health ...`);
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.status === 200) {
        console.log('✅ Server is up and healthy!');
        return true;
      }
    } catch (e: any) {
      console.log(`[-] Fetch error: ${e.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Server at ${url} failed to start in time`);
}

function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

async function runTests() {
  const baseUrl = `http://127.0.0.1:${env.PORT}`;
  await waitForServer(baseUrl).catch((err) => fail(err.message));

  console.log('🧪 Starting Agent API Contract Tests (docs/backend-api-specification.md §4)...');

  console.log('\nTest 1: POST /api/v1/events/attendance with invalid bearer token -> 401');
  {
    const res = await fetch(`${baseUrl}/api/v1/events/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-a-real-key' },
      body: JSON.stringify({ events: [] }),
    });
    if (res.status !== 401) fail(`Expected 401, got ${res.status}: ${await res.text()}`);
    console.log('✅ Unknown device credential correctly rejected with 401.');
  }

  console.log('\nTest 2: POST /api/v1/events/attendance with a deactivated device -> 403');
  {
    const res = await fetch(`${baseUrl}/api/v1/events/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer deactivated-device-key' },
      body: JSON.stringify({ events: [] }),
    });
    if (res.status !== 403) fail(`Expected 403, got ${res.status}: ${await res.text()}`);
    console.log('✅ Deactivated device correctly rejected with 403 (spec §2.3).');
  }

  const clientEventId = '8f14e45f-ceea-4d5a-9e57-5a5b7f2b1a3c';
  const attendancePayload = JSON.stringify({
    ClientEventId: clientEventId,
    MachineId: ACTIVE_DEVICE.machineId,
    UserSid: 'S-1-5-21-1111111111-2222222222-3333333333-1001',
    SessionId: 1,
    IsRemoteSession: false,
    Reason: null,
    OccurredAtUtc: '2026-07-27T09:00:00.0000000+00:00',
    EventType: 'Login',
  });

  console.log('\nTest 3: POST /api/v1/events/attendance with a valid batch -> 200 + acknowledgedEventIds');
  {
    const res = await fetch(`${baseUrl}/api/v1/events/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-device-key' },
      body: JSON.stringify({ events: [{ clientEventId, payloadJson: attendancePayload }] }),
    });
    if (res.status !== 200) fail(`Expected 200, got ${res.status}: ${await res.text()}`);
    const body = await res.json();
    if (!body.acknowledgedEventIds?.includes(clientEventId)) fail(`clientEventId missing from acknowledgedEventIds: ${JSON.stringify(body)}`);
    if (telemetryEvents.length !== 1) fail(`Expected 1 stored telemetry event, got ${telemetryEvents.length}`);
    console.log('✅ Batch accepted and persisted.');
  }

  console.log('\nTest 4: Resending the same batch (retry) -> 200, no duplicate row (spec §3.2)');
  {
    const res = await fetch(`${baseUrl}/api/v1/events/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-device-key' },
      body: JSON.stringify({ events: [{ clientEventId, payloadJson: attendancePayload }] }),
    });
    if (res.status !== 200) fail(`Expected 200, got ${res.status}: ${await res.text()}`);
    const body = await res.json();
    if (!body.acknowledgedEventIds?.includes(clientEventId)) fail('Retried duplicate must still be acknowledged');
    if (telemetryEvents.length !== 1) fail(`Idempotency violated: expected 1 stored row, got ${telemetryEvents.length}`);
    console.log('✅ Retry was idempotent — duplicate was not re-inserted, but was still acknowledged.');
  }

  console.log('\nTest 5: GET /api/v1/policy -> 200 with Version field (spec §4.2)');
  {
    const res = await fetch(`${baseUrl}/api/v1/policy`, {
      headers: { Authorization: 'Bearer valid-device-key' },
    });
    if (res.status !== 200) fail(`Expected 200, got ${res.status}: ${await res.text()}`);
    const body = await res.json();
    if (typeof body.Version !== 'number') fail(`Policy response missing numeric Version: ${JSON.stringify(body)}`);
    console.log(`✅ Policy document returned with Version=${body.Version}.`);
  }

  console.log('\nTest 6: POST /api/v1/consent -> 200 (spec §8)');
  {
    const res = await fetch(`${baseUrl}/api/v1/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-device-key' },
      body: JSON.stringify({
        userSid: 'S-1-5-21-1111111111-2222222222-3333333333-1001',
        machineId: ACTIVE_DEVICE.machineId,
        policyVersion: 3,
        acknowledgedAtUtc: '2026-07-27T08:00:00Z',
      }),
    });
    if (res.status !== 200) fail(`Expected 200, got ${res.status}: ${await res.text()}`);
    console.log('✅ Consent record accepted.');
  }

  console.log('\n🎉 All Agent API contract tests passed.');
  process.exit(0);
}

runTests().catch((err) => fail(err.stack ?? err.message));
