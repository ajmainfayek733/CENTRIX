import { Prisma } from "@prisma/client";
import { prisma } from "../config/db";
import { env } from "../config/env";

/**
 * The server's own housekeeping loop.
 *
 * Everything scheduled here exists because some piece of state can go wrong with nobody left to
 * fix it: an attendance session on a workstation that lost power, a ledger row whose agent
 * stopped retrying days ago. Those are not request-driven, so no request will ever repair them.
 *
 * TWO PROPERTIES MAKE THIS SAFE TO RUN ON EVERY INSTANCE:
 *
 *   1. Mutual exclusion. Each job takes a Postgres *transaction-scoped* advisory lock before it
 *      does anything. Transaction-scoped rather than session-scoped is not a detail: Prisma runs
 *      on a connection pool, so two consecutive queries can land on different backends and a
 *      session lock taken by one would be unreleasable by the other. `pg_try_advisory_xact_lock`
 *      is held by the transaction and released by the commit, whichever connection carried it.
 *
 *   2. Non-blocking acquisition. `try` rather than plain `pg_advisory_xact_lock`, so an instance
 *      that loses the race skips this tick instead of queueing behind the winner and running the
 *      same sweep immediately afterwards.
 *
 * A job that throws is logged and the schedule continues. Housekeeping that fails is a degraded
 * server; housekeeping that takes the process down with it is an outage.
 */

/**
 * Namespace half of every advisory lock taken here, so these can never collide with a lock some
 * other tool takes against the same database. Arbitrary but fixed - "emtk" in ASCII.
 */
const ADVISORY_LOCK_NAMESPACE = 0x656d746b;

/**
 * Second half of the lock key: one per job. Values are permanent - changing one lets an old
 * instance and a new one run the same job concurrently during a rolling deploy.
 */
const JOB_LOCK_KEY = {
  attendanceReap: 1,
  ingestBatchPrune: 2,
  browserSummary: 3,
  dataRetention: 4,
} as const;

export type JobName = keyof typeof JOB_LOCK_KEY;

/** Millisecond conversion for the interval settings, which are all expressed in seconds. */
const MS_PER_SECOND = 1_000;

interface ScheduledJob {
  name: JobName;
  intervalMs: number;
  timeoutMs: number;
  /** Runs inside the locked transaction. Returns a short line for the log, or null to stay quiet. */
  run: (tx: Prisma.TransactionClient) => Promise<string | null>;
}

/** Handles for every timer this module owns, so shutdown can stop them. */
const timers = new Set<NodeJS.Timeout>();

/**
 * Runs `job` if no other instance is already running it.
 *
 * @returns true when this instance held the lock and did the work, false when it was skipped.
 */
async function runExclusively(job: ScheduledJob): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE}::int, ${JOB_LOCK_KEY[job.name]}::int) AS locked
      `;

      if (!locked) return false;

      const summary = await job.run(tx);
      if (summary !== null) console.log(`scheduler: ${job.name} - ${summary}`);

      return true;
    },
    { timeout: job.timeoutMs },
  );
}

/** Runs a job now, swallowing and logging any failure. */
async function tick(job: ScheduledJob): Promise<void> {
  try {
    await runExclusively(job);
  } catch (error) {
    console.error(`scheduler: ${job.name} failed:`, error);
  }
}

/**
 * Starts the maintenance schedule.
 *
 * Every job runs once at startup before its interval begins. That first pass is the one that
 * matters after an outage: the backlog it clears accumulated while nothing was running, and
 * waiting a full interval to touch it would leave the dashboard wrong for that long.
 *
 * The timers are unref'd so they cannot by themselves keep the process alive - a server told to
 * exit should exit, not linger until the next sweep.
 */
export function startMaintenanceJobs(jobs: ScheduledJob[]): void {
  if (!env.MAINTENANCE_JOBS_ENABLED) {
    console.log("scheduler: maintenance jobs disabled (MAINTENANCE_JOBS_ENABLED=false)");
    return;
  }

  for (const job of jobs) {
    void tick(job);

    const timer = setInterval(() => void tick(job), job.intervalMs);
    timer.unref();
    timers.add(timer);
  }

  console.log(`scheduler: ${jobs.length} maintenance job(s) started`);
}

/** Stops every scheduled job. Idempotent - safe to call from more than one shutdown path. */
export function stopMaintenanceJobs(): void {
  for (const timer of timers) clearInterval(timer);
  timers.clear();
}

/** Builds a job definition from a name, an interval in seconds and the work itself. */
export function defineJob(
  name: JobName,
  intervalSeconds: number,
  timeoutMs: number,
  run: ScheduledJob["run"],
): ScheduledJob {
  return { name, intervalMs: intervalSeconds * MS_PER_SECOND, timeoutMs, run };
}
