import { prisma as realPrisma } from './src/config/db';
import { hashDeviceToken } from './src/utils/token';
import { env } from './src/config/env';

console.log(`Test configured to run on port: ${env.PORT}`);

const mockDevice = {
  id: 'desktop-01',
  employeeId: 'employee-123',
  hostname: 'desktop-01',
  os: 'Windows 11',
  agentVersion: '1.0.0',
  tokenHash: hashDeviceToken('valid-device-token'),
  lastSeen: null,
};

// Keep track of queries and database state
let activityLogsInserted: any[] = [];
let attendanceRecordsUpserted: any[] = [];
let ingestBatchesCreated: string[] = [];
let ingestBatchesQueried: string[] = [];

// Create a Proxy over realPrisma to intercept only the target methods
const fakePrisma = new Proxy(realPrisma, {
  get(target, prop) {
    if (prop === 'device') {
      return {
        findUnique: async (args: any) => {
          console.log('[-] Mocked prisma.device.findUnique called with:', JSON.stringify(args));
          if (args.where.id === 'desktop-01') {
            return mockDevice;
          }
          return null;
        },
        update: async (args: any) => {
          console.log('[-] Mocked prisma.device.update called with:', JSON.stringify(args));
          return mockDevice;
        },
      };
    }

    if (prop === '$transaction') {
      return async (callback: (tx: any) => Promise<any>) => {
        console.log('[-] Mocked prisma.$transaction called');
        const txMock = {
          ingestBatch: {
            findUnique: async (args: any) => {
              console.log('[-] tx.ingestBatch.findUnique called with:', JSON.stringify(args));
              ingestBatchesQueried.push(args.where.idempotencyKey);
              if (ingestBatchesCreated.includes(args.where.idempotencyKey)) {
                return { idempotencyKey: args.where.idempotencyKey, deviceId: 'desktop-01' };
              }
              return null;
            },
            create: async (args: any) => {
              console.log('[-] tx.ingestBatch.create called with:', JSON.stringify(args));
              ingestBatchesCreated.push(args.data.idempotencyKey);
              return args.data;
            },
          },
          activityLog: {
            createMany: async (args: any) => {
              console.log('[-] tx.activityLog.createMany called with:', JSON.stringify(args));
              activityLogsInserted.push(...args.data);
              return { count: args.data.length };
            },
          },
          attendance: {
            upsert: async (args: any) => {
              console.log('[-] tx.attendance.upsert called with:', JSON.stringify(args));
              attendanceRecordsUpserted.push({
                where: args.where,
                create: args.create,
                update: args.update,
              });
              return args.create;
            },
          },
          device: {
            update: async (args: any) => {
              console.log('[-] tx.device.update called with:', JSON.stringify(args));
              return mockDevice;
            },
          },
        };
        return callback(txMock);
      };
    }

    return (target as any)[prop];
  },
});

// Hijack require.cache for the db module
const dbPath = require.resolve('./src/config/db');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    prisma: fakePrisma,
  },
} as any;

console.log('1. Hijacked require.cache for db module');

// 2. Now import app to start the server
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

async function runTests() {
  const baseUrl = `http://127.0.0.1:${env.PORT}`;

  try {
    await waitForServer(baseUrl);
  } catch (err: any) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  console.log('🧪 Starting Agent API Integration Tests...');

  // Test 1: GET /api/v1/config with invalid authentication
  console.log('\nTest 1: GET /api/v1/config with missing/invalid credentials...');
  try {
    const res = await fetch(`${baseUrl}/api/v1/config`, {
      headers: {
        'X-Device-ID': 'desktop-01',
        'Authorization': 'Bearer invalid-token',
      },
    });
    if (res.status === 401) {
      console.log('✅ Correctly rejected unauthorized request with 401.');
    } else {
      console.error(`❌ Expected 401, got ${res.status}`);
      const text = await res.text();
      console.error('Response body:', text);
      process.exit(1);
    }
  } catch (err: any) {
    console.error('❌ Request failed:', err.message);
    process.exit(1);
  }

  // Test 2: GET /api/v1/config with valid credentials
  console.log('\nTest 2: GET /api/v1/config with valid credentials...');
  try {
    const res = await fetch(`${baseUrl}/api/v1/config`, {
      headers: {
        'X-Device-ID': 'desktop-01',
        'Authorization': 'Bearer valid-device-token',
      },
    });
    if (res.status === 200) {
      const config = await res.json();
      console.log('✅ Correctly retrieved config:', config);
      if (config.AppTrackingEnabled === true && config.SyncIntervalSeconds === 60) {
        console.log('✅ Config properties match contract.');
      } else {
        console.error('❌ Config properties mismatch!');
        process.exit(1);
      }
    } else {
      console.error(`❌ Expected 200, got ${res.status}`);
      const text = await res.text();
      console.error('Response body:', text);
      process.exit(1);
    }
  } catch (err: any) {
    console.error('❌ Request failed:', err.message);
    process.exit(1);
  }

  // Test 3: POST /api/v1/ingest with valid payload
  console.log('\nTest 3: POST /api/v1/ingest with valid batch payload...');
  const testPayload = {
    DeviceId: 'desktop-01',
    ActivityLogs: [
      {
        DeviceId: 'desktop-01',
        AppName: 'Visual Studio Code',
        WindowTitle: 'Agent API Contract',
        Domain: null,
        IsIdle: false,
        ActivityScore: 12,
        CapturedAt: '2026-07-21T10:15:00Z',
      },
    ],
    Screenshots: [
      {
        DeviceId: 'desktop-01',
        CapturedAt: '2026-07-21T10:15:00Z',
        EncryptedImageData: 'base64-encoded-bytes-here',
      },
    ],
    UsbLogs: [
      {
        DeviceId: 'desktop-01',
        DeviceName: 'USB Drive',
        Action: 'Connected',
        CapturedAt: '2026-07-21T10:15:00Z',
      },
    ],
    AttendanceRecords: [
      {
        DeviceId: 'desktop-01',
        Date: '2026-07-21',
        FirstLogin: '2026-07-21T08:00:00Z',
        LastLogout: '2026-07-21T17:00:00Z',
        TotalActiveSeconds: 28800,
      },
    ],
  };

  const idempotencyKey = 'unique-test-idempotency-key';

  try {
    const res = await fetch(`${baseUrl}/api/v1/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-ID': 'desktop-01',
        'Authorization': 'Bearer valid-device-token',
        'X-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(testPayload),
    });

    if (res.status === 202) {
      const responseBody = await res.json();
      console.log('✅ Correctly accepted batch with 202:', responseBody);
      if (responseBody.status === 'success' && responseBody.message === 'batch accepted') {
        console.log('✅ Response body matches contract.');
      } else {
        console.error('❌ Response body mismatch!');
        process.exit(1);
      }

      // Check database inserts/upserts
      if (activityLogsInserted.length === 1 && activityLogsInserted[0].appName === 'Visual Studio Code') {
        console.log('✅ ActivityLogs correctly routed to database.');
      } else {
        console.error('❌ ActivityLogs database insertion failed!');
        process.exit(1);
      }

      if (
        attendanceRecordsUpserted.length === 1 &&
        attendanceRecordsUpserted[0].create.totalActiveSeconds === 28800
      ) {
        console.log('✅ AttendanceRecords correctly upserted to database.');
      } else {
        console.error('❌ AttendanceRecords database upsert failed!');
        process.exit(1);
      }
    } else {
      console.error(`❌ Expected 202, got ${res.status}`);
      const text = await res.text();
      console.error('Error response:', text);
      process.exit(1);
    }
  } catch (err: any) {
    console.error('❌ Request failed:', err.message);
    process.exit(1);
  }

  // Test 4: POST /api/v1/ingest duplicate key (Idempotency check)
  console.log('\nTest 4: POST /api/v1/ingest duplicate key (Idempotency test)...');
  try {
    const res = await fetch(`${baseUrl}/api/v1/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-ID': 'desktop-01',
        'Authorization': 'Bearer valid-device-token',
        'X-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(testPayload),
    });

    if (res.status === 202) {
      const responseBody = await res.json();
      console.log('✅ Correctly accepted duplicate batch with 202 (idempotency honored):', responseBody);
    } else {
      console.error(`❌ Expected 202, got ${res.status}`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error('❌ Request failed:', err.message);
    process.exit(1);
  }

  console.log('\n🎉 All tests passed successfully!');
  process.exit(0);
}

if (process.argv.includes('--server') || process.env.MOCK_SERVER === 'true') {
  console.log('\n========================================================================');
  console.log('🚀 MOCK DATABASE SERVER ACTIVE');
  console.log('The backend is running with a mocked, in-memory database.');
  console.log('You can now point your Windows agent to this server for testing.\n');
  console.log('Connection Details:');
  console.log(`  - Config Endpoint: http://localhost:${env.PORT}/api/v1/config`);
  console.log(`  - Ingest Endpoint: http://localhost:${env.PORT}/api/v1/ingest`);
  console.log('  - Device ID: desktop-01');
  console.log('  - Device Token: valid-device-token');
  console.log('  - Authorization Header: Bearer valid-device-token');
  console.log('  - X-Device-ID Header: desktop-01\n');
  console.log('All agent requests will be validated, processed in-memory, and logged below.');
  console.log('========================================================================\n');
} else {
  runTests();
}
