import { z } from "zod";
import dotenv from "dotenv";

// quiet: dotenv prints a randomized promotional "tip" line on every load otherwise (harmless,
// just log noise - see dotenv's own lib/main.js TIPS array).
dotenv.config({ quiet: true });

const envSchema = z.object({
  PORT: z
    .string()
    .default("5000")
    .transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BETTER_AUTH_SECRET: z.string().min(16, "BETTER_AUTH_SECRET must be at least 16 characters"),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
  // Pepper for hashing Agent device API keys (HMAC-SHA256). Required in production - a default
  // is provided only so local dev works out of the box; never rely on it beyond that.
  DEVICE_TOKEN_PEPPER: z.string().min(16).default("dev-only-device-token-pepper-change-me"),
  // Screenshot bytes use local disk by default for development. Production should use S3 so
  // container replacement cannot remove historical screenshots.
  SCREENSHOT_STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),
  SCREENSHOT_STORAGE_DIR: z.string().default("./storage/screenshots"),
  SCREENSHOT_S3_BUCKET: z.string().min(1).optional(),
  SCREENSHOT_S3_REGION: z.string().min(1).default("us-east-1"),
  SCREENSHOT_S3_ENDPOINT: z.string().url().optional(),
  SCREENSHOT_S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Base URL used to build the `remoteUri` returned from POST /api/v1/screenshots. The Agent
  // only logs this value locally - it is never read back - so it does not need to be publicly
  // resolvable, just stable.
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:5000"),
  // Maximum JSON request body. Express defaults to 100kb, which a legitimate agent batch
  // exceeds: 500 activity sessions carrying window titles and executable paths is comfortably
  // over that, and the agent saw 413s in normal operation.
  //
  // This is the *ceiling*. The agent packs each request to stay under its own smaller budget
  // (BackendClient.MaxRequestBytes), so the headroom between the two absorbs the difference
  // between the agent's estimate and the exact encoded size.
  JSON_BODY_LIMIT: z.string().default("2mb"),

  // -- Deployment topology ---------------------------------------------------
  // How many reverse proxies sit in front of this server, or a value Express's `trust proxy`
  // understands directly ('loopback', a CIDR, 'true'/'false').
  //
  // This must match reality. Set too low behind a proxy and every client looks like the proxy,
  // so per-IP limits apply to the whole world at once. Set too high - or 'true' with no proxy -
  // and clients can forge x-forwarded-for to dodge those limits. Default 'false' is the safe
  // end: direct exposure, header ignored.
  TRUST_PROXY: z.string().default("false"),

  // -- Rate limits -----------------------------------------------------------
  // Enrollment mints a credential, so it stays tight - but it is keyed per MachineGuid, not per
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
  // agent reads from policy - this is only an abuse bound.
  //
  // Deliberately several times the policy default: an agent that has not yet picked up a
  // lowered policy must not have its perfectly valid batches rejected, which would strand its
  // queue until someone noticed.
  INGEST_MAX_BATCH_EVENTS: z.coerce.number().int().positive().default(500),
  // Ceiling on the ingest write transaction. Only inserts and one aggregate upsert run inside
  // it - validation, categorization and lookups happen before it opens - so this is generous
  // for a batch of INGEST_MAX_BATCH_EVENTS rows and exists to stop a wedged transaction from
  // holding locks indefinitely.
  INGEST_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // How long the batch-idempotency ledger is kept. It only has to outlive the agent's retry
  // window: once an agent has stopped resending a batch, the row can never be consulted again.
  INGEST_BATCH_RETENTION_DAYS: z.coerce.number().int().positive().default(7),

  // How stale a device's lastSeen may get before deviceAuth refreshes it. Writing on every
  // request means a row update per telemetry call - pure write amplification on the hottest
  // table, and needless contention on a single row. Liveness only needs minute granularity.
  DEVICE_LAST_SEEN_MAX_STALENESS_SECONDS: z.coerce.number().int().nonnegative().default(60),

  // -- Maintenance jobs ------------------------------------------------------
  // Set false to run a server that serves traffic but sweeps nothing - useful when several
  // instances share a database and you would rather one dedicated box did the housekeeping.
  // The jobs are safe to leave on everywhere regardless: each takes a Postgres advisory lock,
  // so only one instance sweeps at a time.
  MAINTENANCE_JOBS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  // -- Attendance closure ----------------------------------------------------
  // How often the server looks for attendance sessions nothing is ever going to close. Well
  // under the abandonment threshold below, so a session is closed promptly once it qualifies
  // rather than up to a whole interval later.
  ATTENDANCE_REAP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),

  // How long a workstation must be silent before an attendance session still open on it is
  // treated as abandoned and closed from the last evidence the server holds.
  //
  // THIS IS THE LOAD-SHEDDING KNOB. The agent's own recovery pass uses 14 minutes
  // (AgentCadence.AttendanceStale) and can afford to: it runs on the workstation, where
  // silence means the host process really did stop. The server is behind the network as
  // well, and an outage that kills the workstations kills the router with them - so a live
  // agent can go quiet for reasons that have nothing to do with the employee leaving. It
  // therefore waits several times longer before inferring anything, and what it writes stays
  // correctable: `logoutSource = Server` lets the agent's own report overwrite it later.
  ATTENDANCE_ABANDON_AFTER_SECONDS: z.coerce.number().int().positive().default(2_700),

  BROWSER_SUMMARY_JOB_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  BROWSER_SUMMARY_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  // Hard ceiling on how long any attendance session may stay open, however healthy the device
  // looks. A row this old is a bug or a missed rotation, not a shift - and left alone it
  // reports one employee as permanently signed in and drags every day's totals with it.
  // Sized above the longest plausible working day so it can never truncate a real one.
  ATTENDANCE_MAX_OPEN_SECONDS: z.coerce.number().int().positive().default(57_600),

  // Sessions examined per sweep. Bounds the work of the first run after an outage - a fleet
  // that was dark for a week can present a large backlog at once - without letting it hold a
  // transaction open for minutes. Whatever is left over is picked up next interval.
  ATTENDANCE_REAP_MAX_SESSIONS: z.coerce.number().int().positive().default(500),

  // Ceiling on one reaper sweep. It holds an advisory lock for its duration, so a wedged
  // sweep must not be able to block every later one.
  ATTENDANCE_REAP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // How often the batch-idempotency ledger is pruned. It only grows by one row per device per
  // channel per sync, so daily is ample.
  INGEST_BATCH_PRUNE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(86_400),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error("X Invalid environment variables:", _env.error.format());
  throw new Error("Invalid environment configuration");
}

export const env = _env.data;

// The schema default exists only so local dev works without a .env file. Shipping it in
// production would let anyone forge a device API key hash offline, so fail closed instead.
if (
  env.NODE_ENV === "production" &&
  env.DEVICE_TOKEN_PEPPER === "dev-only-device-token-pepper-change-me"
) {
  throw new Error(
    "DEVICE_TOKEN_PEPPER must be set to a unique secret in production (see .env.example)",
  );
}

if (env.SCREENSHOT_STORAGE_PROVIDER === "s3" && !env.SCREENSHOT_S3_BUCKET) {
  throw new Error(
    "SCREENSHOT_S3_BUCKET must be set when SCREENSHOT_STORAGE_PROVIDER=s3 (see .env.example)",
  );
}
