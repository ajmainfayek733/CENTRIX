import { z } from 'zod';
import dotenv from 'dotenv';

// quiet: dotenv prints a randomized promotional "tip" line on every load otherwise (harmless,
// just log noise — see dotenv's own lib/main.js TIPS array).
dotenv.config({ quiet: true });

const envSchema = z.object({
  PORT: z.string().default('5000').transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  BETTER_AUTH_SECRET: z.string().min(16, 'BETTER_AUTH_SECRET must be at least 16 characters'),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:3000'),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  // Pepper for hashing Agent device API keys (HMAC-SHA256). Required in production — a default
  // is provided only so local dev works out of the box; never rely on it beyond that.
  DEVICE_TOKEN_PEPPER: z.string().min(16).default('dev-only-device-token-pepper-change-me'),
  // Local filesystem root for uploaded screenshots (spec §6). Swap for blob storage (S3/Azure
  // Blob) behind the same ScreenshotStorage interface if volume grows beyond the ~30-device
  // deployment this was built for (spec §7.1).
  SCREENSHOT_STORAGE_DIR: z.string().default('./storage/screenshots'),
  // Base URL used to build the `remoteUri` returned from POST /api/v1/screenshots. The Agent
  // only logs this value locally — it is never read back — so it does not need to be publicly
  // resolvable, just stable.
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:5000'),
  // Maximum JSON request body. Express defaults to 100kb, which a legitimate agent batch
  // exceeds: 500 activity sessions carrying window titles and executable paths is comfortably
  // over that, and the agent saw 413s in normal operation.
  //
  // This is the *ceiling*. The agent packs each request to stay under its own smaller budget
  // (BackendClient.MaxRequestBytes), so the headroom between the two absorbs the difference
  // between the agent's estimate and the exact encoded size.
  JSON_BODY_LIMIT: z.string().default('2mb'),

  // -- Deployment topology ---------------------------------------------------
  // How many reverse proxies sit in front of this server, or a value Express's `trust proxy`
  // understands directly ('loopback', a CIDR, 'true'/'false').
  //
  // This must match reality. Set too low behind a proxy and every client looks like the proxy,
  // so per-IP limits apply to the whole world at once. Set too high — or 'true' with no proxy —
  // and clients can forge x-forwarded-for to dodge those limits. Default 'false' is the safe
  // end: direct exposure, header ignored.
  TRUST_PROXY: z.string().default('false'),

  // -- Rate limits -----------------------------------------------------------
  // Enrollment mints a credential, so it stays tight — but it is keyed per MachineGuid, not per
  // IP, so a hundred workstations rolling out from behind one NAT get a budget each.
  RATE_LIMIT_ENROLL_PER_MIN: z.coerce.number().int().positive().default(10),
  // Per authenticated device. One agent syncs six channels plus a heartbeat every couple of
  // minutes; 200/min is orders of magnitude above that and exists only to contain an agent
  // stuck in a retry loop.
  RATE_LIMIT_INGEST_PER_MIN: z.coerce.number().int().positive().default(200),
  RATE_LIMIT_SCREENSHOT_PER_MIN: z.coerce.number().int().positive().default(60),
  // Per-IP backstop applied before authentication, so an unauthenticated flood cannot force a
  // credential lookup per request. Sized for a whole office behind one address.
  RATE_LIMIT_UNAUTHENTICATED_PER_MIN: z.coerce.number().int().positive().default(3000),

  // -- Database --------------------------------------------------------------
  // Postgres connection pool ceiling. Node is single-threaded and telemetry writes are short
  // transactions, so this is about burst tolerance rather than parallelism: raise it if many
  // agents sync simultaneously and you see requests queueing behind the pool.
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  // -- Ingest ----------------------------------------------------------------
  // Server-side sanity ceiling on events per push. The *operational* batch size is
  // Policy.syncMaxBatchSize (default 100), which admins edit from the settings screen and the
  // agent reads from policy — this is only an abuse bound.
  //
  // Deliberately several times the policy default: an agent that has not yet picked up a
  // lowered policy must not have its perfectly valid batches rejected, which would strand its
  // queue until someone noticed.
  INGEST_MAX_BATCH_EVENTS: z.coerce.number().int().positive().default(500),
  // Ceiling on the ingest write transaction. Only inserts and one aggregate upsert run inside
  // it — validation, categorization and lookups happen before it opens — so this is generous
  // for a batch of INGEST_MAX_BATCH_EVENTS rows and exists to stop a wedged transaction from
  // holding locks indefinitely.
  INGEST_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // How long the batch-idempotency ledger is kept. It only has to outlive the agent's retry
  // window: once an agent has stopped resending a batch, the row can never be consulted again.
  INGEST_BATCH_RETENTION_DAYS: z.coerce.number().int().positive().default(7),

  // How stale a device's lastSeen may get before deviceAuth refreshes it. Writing on every
  // request means a row update per telemetry call — pure write amplification on the hottest
  // table, and needless contention on a single row. Liveness only needs minute granularity.
  DEVICE_LAST_SEEN_MAX_STALENESS_SECONDS: z.coerce.number().int().nonnegative().default(60),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Invalid environment variables:', _env.error.format());
  throw new Error('Invalid environment configuration');
}

export const env = _env.data;

// The schema default exists only so local dev works without a .env file. Shipping it in
// production would let anyone forge a device API key hash offline, so fail closed instead.
if (env.NODE_ENV === 'production' && env.DEVICE_TOKEN_PEPPER === 'dev-only-device-token-pepper-change-me') {
  throw new Error('DEVICE_TOKEN_PEPPER must be set to a unique secret in production (see .env.example)');
}
