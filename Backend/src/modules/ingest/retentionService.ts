import { Prisma } from "@prisma/client";
import { env } from "../../config/env";
import { deleteScreenshots } from "./screenshotStorage";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Used for an organization that has no Policy row yet; mirrors the schema default. */
const DEFAULT_RETENTION_DAYS = 90;

/**
 * One table the sweep ages out.
 *
 * `selectExpired` returns the ids of at most `take` rows older than the cutoff for one
 * organization; `deleteByIds` removes exactly those rows. Selecting ids first and deleting by id
 * keeps every statement bounded - Prisma's deleteMany has no LIMIT.
 */
interface RetentionTarget {
  name: string;
  selectExpired: (
    tx: Prisma.TransactionClient,
    organizationId: string,
    cutoff: Date,
    take: number,
  ) => Promise<string[]>;
  deleteByIds: (tx: Prisma.TransactionClient, ids: string[]) => Promise<number>;
}

const toIds = (rows: { id: string }[]): string[] => rows.map((row) => row.id);

/**
 * Raw telemetry and daily summaries.
 *
 * Deliberately absent: attendance sessions, consent records, audit logs and the device / employee
 * registry. Those are the record of who worked when and who agreed to what, and they are never
 * aged out by a telemetry retention window.
 */
const TELEMETRY_TARGETS: RetentionTarget[] = [
  {
    name: "activityMetrics",
    selectExpired: async (tx, organizationId, cutoff, take) =>
      toIds(
        await tx.activityMetric.findMany({
          where: { windowEndUtc: { lt: cutoff }, device: { organizationId } },
          select: { id: true },
          take,
        }),
      ),
    deleteByIds: async (tx, ids) =>
      (await tx.activityMetric.deleteMany({ where: { id: { in: ids } } })).count,
  },
  {
    name: "activitySessions",
    selectExpired: async (tx, organizationId, cutoff, take) =>
      toIds(
        await tx.activitySession.findMany({
          where: { endTime: { lt: cutoff }, device: { organizationId } },
          select: { id: true },
          take,
        }),
      ),
    deleteByIds: async (tx, ids) =>
      (await tx.activitySession.deleteMany({ where: { id: { in: ids } } })).count,
  },
  {
    name: "browserActivities",
    selectExpired: async (tx, organizationId, cutoff, take) =>
      toIds(
        await tx.browserActivity.findMany({
          where: { endTime: { lt: cutoff }, device: { organizationId } },
          select: { id: true },
          take,
        }),
      ),
    deleteByIds: async (tx, ids) =>
      (await tx.browserActivity.deleteMany({ where: { id: { in: ids } } })).count,
  },
  {
    name: "usbEvents",
    selectExpired: async (tx, organizationId, cutoff, take) =>
      toIds(
        await tx.usbEvent.findMany({
          where: { eventTime: { lt: cutoff }, device: { organizationId } },
          select: { id: true },
          take,
        }),
      ),
    deleteByIds: async (tx, ids) =>
      (await tx.usbEvent.deleteMany({ where: { id: { in: ids } } })).count,
  },
  {
    name: "alerts",
    selectExpired: async (tx, organizationId, cutoff, take) =>
      toIds(
        await tx.alert.findMany({
          where: { triggeredAt: { lt: cutoff }, device: { organizationId } },
          select: { id: true },
          take,
        }),
      ),
    deleteByIds: async (tx, ids) =>
      (await tx.alert.deleteMany({ where: { id: { in: ids } } })).count,
  },
  {
    name: "dailyActivityRollups",
    selectExpired: async (tx, organizationId, cutoff, take) =>
      toIds(
        await tx.dailyActivityRollup.findMany({
          where: { workDate: { lt: cutoff }, organizationId },
          select: { id: true },
          take,
        }),
      ),
    deleteByIds: async (tx, ids) =>
      (await tx.dailyActivityRollup.deleteMany({ where: { id: { in: ids } } })).count,
  },
  {
    name: "browserDailySummaries",
    selectExpired: async (tx, organizationId, cutoff, take) =>
      toIds(
        await tx.browserDailySummary.findMany({
          where: { workDate: { lt: cutoff }, organizationId },
          select: { id: true },
          take,
        }),
      ),
    deleteByIds: async (tx, ids) =>
      (await tx.browserDailySummary.deleteMany({ where: { id: { in: ids } } })).count,
  },
  {
    name: "activityMetricDailySummaries",
    selectExpired: async (tx, organizationId, cutoff, take) =>
      toIds(
        await tx.activityMetricDailySummary.findMany({
          where: { workDate: { lt: cutoff }, organizationId },
          select: { id: true },
          take,
        }),
      ),
    deleteByIds: async (tx, ids) =>
      (await tx.activityMetricDailySummary.deleteMany({ where: { id: { in: ids } } })).count,
  },
  {
    name: "activitySessionDailySummaries",
    selectExpired: async (tx, organizationId, cutoff, take) =>
      toIds(
        await tx.activitySessionDailySummary.findMany({
          where: { workDate: { lt: cutoff }, organizationId },
          select: { id: true },
          take,
        }),
      ),
    deleteByIds: async (tx, ids) =>
      (await tx.activitySessionDailySummary.deleteMany({ where: { id: { in: ids } } })).count,
  },
];

export type RetentionReport = Record<string, number>;

/**
 * Removes expired screenshots for one organization: stored bytes first, then the row.
 *
 * Order is the point. Dropping the row first would leave an unreachable file that nothing ever
 * cleans up; dropping the file first and failing on the row is harmless, because the next sweep
 * finds the row again and the delete of an absent file counts as success.
 */
async function sweepScreenshots(
  tx: Prisma.TransactionClient,
  organizationId: string,
  cutoff: Date,
): Promise<number> {
  let removedRows = 0;

  for (let batch = 0; batch < env.RETENTION_MAX_BATCHES_PER_TABLE; batch++) {
    const rows = await tx.screenshot.findMany({
      where: { capturedAt: { lt: cutoff }, device: { organizationId } },
      select: { id: true, storagePath: true },
      take: env.RETENTION_BATCH_SIZE,
    });
    if (rows.length === 0) break;

    const gone = await deleteScreenshots(rows.map((row) => row.storagePath));
    const deletableIds = rows.filter((row) => gone.has(row.storagePath)).map((row) => row.id);

    // Nothing in this batch could be removed (storage outage). Stop rather than re-select the
    // same rows for the rest of the budget.
    if (deletableIds.length === 0) break;

    const { count } = await tx.screenshot.deleteMany({ where: { id: { in: deletableIds } } });
    removedRows += count;

    if (rows.length < env.RETENTION_BATCH_SIZE) break;
  }

  return removedRows;
}

/** Deletes expired rows of one target in bounded batches, returning how many were removed. */
async function sweepTarget(
  tx: Prisma.TransactionClient,
  target: RetentionTarget,
  organizationId: string,
  cutoff: Date,
): Promise<number> {
  let removed = 0;

  for (let batch = 0; batch < env.RETENTION_MAX_BATCHES_PER_TABLE; batch++) {
    const ids = await target.selectExpired(tx, organizationId, cutoff, env.RETENTION_BATCH_SIZE);
    if (ids.length === 0) break;

    removed += await target.deleteByIds(tx, ids);

    if (ids.length < env.RETENTION_BATCH_SIZE) break;
  }

  return removed;
}

/**
 * Enforces every organization's `Policy.retentionDays`.
 *
 * Runs inside the scheduler's advisory-locked transaction. A database error aborts that
 * transaction, so it propagates to the scheduler, which logs it and retries next interval; the
 * work is idempotent, so a rolled-back sweep loses nothing. Storage errors do not abort it -
 * `deleteScreenshots` reports them by omission and those rows are simply kept.
 *
 * @returns rows removed per table across all organizations (empty when nothing expired).
 */
export async function runRetentionSweep(tx: Prisma.TransactionClient): Promise<RetentionReport> {
  const report: RetentionReport = {};
  const add = (name: string, count: number) => {
    if (count > 0) report[name] = (report[name] ?? 0) + count;
  };

  const organizations = await tx.organization.findMany({
    select: { id: true, policy: { select: { retentionDays: true } } },
  });

  const now = Date.now();

  for (const organization of organizations) {
    const days = organization.policy?.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const cutoff = new Date(now - days * MS_PER_DAY);

    add("screenshots", await sweepScreenshots(tx, organization.id, cutoff));

    for (const target of TELEMETRY_TARGETS) {
      add(target.name, await sweepTarget(tx, target, organization.id, cutoff));
    }
  }

  return report;
}

/** One log line for a sweep, or null when there was nothing to remove. */
export function describeRetention(report: RetentionReport): string | null {
  const entries = Object.entries(report);
  if (entries.length === 0) return null;
  return `removed ${entries.map(([name, count]) => `${count} ${name}`).join(", ")}`;
}
