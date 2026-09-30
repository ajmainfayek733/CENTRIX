import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db";

/** Rebuilds one completed work date from the immutable browser log. */
export async function summarizeBrowserDay(
  tx: Prisma.TransactionClient,
  workDate: string,
  organizationId?: string,
): Promise<number> {
  await tx.$executeRaw`
    DELETE FROM browser_daily_summaries
    WHERE "workDate" = ${workDate}::date
      ${organizationId ? Prisma.sql`AND "organizationId" = ${organizationId}` : Prisma.empty}
  `;

  return Number(
    await tx.$executeRaw`
    INSERT INTO browser_daily_summaries (
      id, "organizationId", "employeeId", "workDate", "domain",
      "durationSeconds", "visitCount", "productiveSeconds", "unproductiveSeconds",
      "neutralSeconds", "blacklistedSeconds", "createdAt", "updatedAt"
    )
    SELECT
      gen_random_uuid(),
      device."organizationId",
      device."employeeId",
      COALESCE(attendance."workDate", browser."startTime"::date),
      LOWER(browser."domain"),
      SUM(browser."durationSeconds"),
      COUNT(*),
      COALESCE(SUM(browser."durationSeconds") FILTER (WHERE browser."productivityTag" = 'Productive'), 0),
      COALESCE(SUM(browser."durationSeconds") FILTER (WHERE browser."productivityTag" = 'Unproductive'), 0),
      COALESCE(SUM(browser."durationSeconds") FILTER (WHERE browser."productivityTag" = 'Neutral'), 0),
      COALESCE(SUM(browser."durationSeconds") FILTER (WHERE browser."productivityTag" = 'Blacklisted'), 0),
      NOW(), NOW()
    FROM browser_activity browser
    JOIN devices device ON device.id = browser."deviceId"
    LEFT JOIN activity_sessions activity ON activity."activitySessionId" = browser."activitySessionId"
    LEFT JOIN attendance_sessions attendance ON attendance."sessionId" = activity."sessionId"
    WHERE COALESCE(attendance."workDate", browser."startTime"::date) = ${workDate}::date
      ${organizationId ? Prisma.sql`AND device."organizationId" = ${organizationId}` : Prisma.empty}
    GROUP BY
      device."organizationId", device."employeeId",
      COALESCE(attendance."workDate", browser."startTime"::date),
      LOWER(browser."domain")
  `,
  );
}

/** Rebuilds one completed work date from the immutable activity metric log. */
export async function summarizeActivityMetricDay(
  tx: Prisma.TransactionClient,
  workDate: string,
  organizationId?: string,
): Promise<number> {
  await tx.$executeRaw`
    DELETE FROM activity_metric_daily_summaries
    WHERE "workDate" = ${workDate}::date
      ${organizationId ? Prisma.sql`AND "organizationId" = ${organizationId}` : Prisma.empty}
  `;

  return Number(
    await tx.$executeRaw`
      INSERT INTO activity_metric_daily_summaries (
        id, "organizationId", "employeeId", "workDate", "sampleCount", "keyCount", "mouseCount",
        "mouseLeftKeyCount", "mouseRightKeyCount", "mouseMiddleKeyCount", "mouseOtherKeyCount",
        "createdAt", "updatedAt"
      )
      SELECT
        gen_random_uuid(),
        device."organizationId",
        device."employeeId",
        COALESCE(attendance."workDate", metric."windowEndUtc"::date),
        COUNT(*),
        COALESCE(SUM(metric."keyCount"), 0),
        COALESCE(SUM(metric."mouseCount"), 0),
        COALESCE(SUM(metric."mouseLeftKeyCount"), 0),
        COALESCE(SUM(metric."mouseRightKeyCount"), 0),
        COALESCE(SUM(metric."mouseMiddleKeyCount"), 0),
        COALESCE(SUM(metric."mouseOtherKeyCount"), 0),
        NOW(), NOW()
      FROM activity_metrics metric
      JOIN devices device ON device.id = metric."deviceId"
      LEFT JOIN attendance_sessions attendance ON attendance."sessionId" = metric."sessionId"
      WHERE COALESCE(attendance."workDate", metric."windowEndUtc"::date) = ${workDate}::date
        ${organizationId ? Prisma.sql`AND device."organizationId" = ${organizationId}` : Prisma.empty}
      GROUP BY
        device."organizationId", device."employeeId",
        COALESCE(attendance."workDate", metric."windowEndUtc"::date)
    `,
  );
}

/** Rebuilds one completed work date from application activity sessions. */
export async function summarizeActivitySessionDay(
  tx: Prisma.TransactionClient,
  workDate: string,
  organizationId?: string,
): Promise<number> {
  await tx.$executeRaw`
    DELETE FROM activity_session_daily_summaries
    WHERE "workDate" = ${workDate}::date
      ${organizationId ? Prisma.sql`AND "organizationId" = ${organizationId}` : Prisma.empty}
  `;

  return Number(
    await tx.$executeRaw`
      INSERT INTO activity_session_daily_summaries (
        id, "organizationId", "employeeId", "workDate", "appName", "durationSeconds", "sessionCount",
        "productiveSeconds", "unproductiveSeconds", "neutralSeconds", "blacklistedSeconds",
        "createdAt", "updatedAt"
      )
      SELECT
        gen_random_uuid(),
        device."organizationId",
        device."employeeId",
        COALESCE(attendance."workDate", activity."startTime"::date),
        COALESCE(activity."appName", '__unknown_application__'),
        SUM(activity."durationSeconds"),
        COUNT(*),
        COALESCE(SUM(activity."durationSeconds") FILTER (WHERE activity."productivityTag" = 'Productive'), 0),
        COALESCE(SUM(activity."durationSeconds") FILTER (WHERE activity."productivityTag" = 'Unproductive'), 0),
        COALESCE(SUM(activity."durationSeconds") FILTER (WHERE activity."productivityTag" = 'Neutral'), 0),
        COALESCE(SUM(activity."durationSeconds") FILTER (WHERE activity."productivityTag" = 'Blacklisted'), 0),
        NOW(), NOW()
      FROM activity_sessions activity
      JOIN devices device ON device.id = activity."deviceId"
      LEFT JOIN attendance_sessions attendance ON attendance."sessionId" = activity."sessionId"
      WHERE activity."type" = 'Application'
        AND COALESCE(attendance."workDate", activity."startTime"::date) = ${workDate}::date
        ${organizationId ? Prisma.sql`AND device."organizationId" = ${organizationId}` : Prisma.empty}
      GROUP BY
        device."organizationId", device."employeeId",
        COALESCE(attendance."workDate", activity."startTime"::date),
        COALESCE(activity."appName", '__unknown_application__')
    `,
  );
}

/**
 * Scans for past work dates (< CURRENT_DATE) that have activity records but lack summaries,
 * and automatically rebuilds them. This guarantees fault tolerance if the server was offline
 * or experiencing load shedding during scheduled summary times.
 */
export async function backfillMissingDailySummaries(
  clientOrOrgId?: Prisma.TransactionClient | string,
  organizationId?: string,
): Promise<number> {
  const isTx =
    typeof clientOrOrgId === "object" && clientOrOrgId !== null && "$queryRaw" in clientOrOrgId;
  const tx = isTx ? clientOrOrgId : (prisma as any);
  const targetOrgId = isTx
    ? organizationId
    : typeof clientOrOrgId === "string"
      ? clientOrOrgId
      : undefined;

  const missingDates = await tx.$queryRaw<{ workDateStr: string; organizationId: string }[]>`
    WITH raw_dates AS (
      SELECT DISTINCT
        device."organizationId",
        COALESCE(attendance."workDate", activity."startTime"::date)::text AS "workDateStr"
      FROM activity_sessions activity
      JOIN devices device ON device.id = activity."deviceId"
      LEFT JOIN attendance_sessions attendance ON attendance."sessionId" = activity."sessionId"
      WHERE COALESCE(attendance."workDate", activity."startTime"::date) < CURRENT_DATE
        ${targetOrgId ? Prisma.sql`AND device."organizationId" = ${targetOrgId}` : Prisma.empty}

      UNION

      SELECT DISTINCT
        device."organizationId",
        COALESCE(attendance."workDate", browser."startTime"::date)::text AS "workDateStr"
      FROM browser_activity browser
      JOIN devices device ON device.id = browser."deviceId"
      LEFT JOIN activity_sessions activity ON activity."activitySessionId" = browser."activitySessionId"
      LEFT JOIN attendance_sessions attendance ON attendance."sessionId" = activity."sessionId"
      WHERE COALESCE(attendance."workDate", browser."startTime"::date) < CURRENT_DATE
        ${targetOrgId ? Prisma.sql`AND device."organizationId" = ${targetOrgId}` : Prisma.empty}
    )
    SELECT rd."workDateStr", rd."organizationId"
    FROM raw_dates rd
    LEFT JOIN activity_session_daily_summaries summ
      ON summ."workDate" = rd."workDateStr"::date AND summ."organizationId" = rd."organizationId"
    WHERE summ.id IS NULL
    ORDER BY rd."workDateStr" ASC
    LIMIT 30;
  `;

  let totalRebuilt = 0;
  for (const entry of missingDates) {
    totalRebuilt += await summarizeBrowserDay(tx, entry.workDateStr, entry.organizationId);
    totalRebuilt += await summarizeActivityMetricDay(tx, entry.workDateStr, entry.organizationId);
    totalRebuilt += await summarizeActivitySessionDay(tx, entry.workDateStr, entry.organizationId);
  }

  return totalRebuilt;
}

/**
 * Runs daily summary generation. Handles both the configured local clock match
 * and automatic catch-up of any previously unsummarized historical dates.
 */
export async function runBrowserSummarySchedule(
  tx: Prisma.TransactionClient,
  now = new Date(),
): Promise<string | null> {
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const policies = await tx.policy.findMany({
    where: { reportSummaryScheduleTimeLocal: currentTime },
    select: { organizationId: true },
  });

  const previousWorkDate = new Date(now);
  previousWorkDate.setDate(previousWorkDate.getDate() - 1);
  const workDate = previousWorkDate.toISOString().slice(0, "YYYY-MM-DD".length);
  let rows = 0;

  for (const policy of policies) {
    rows += await summarizeBrowserDay(tx, workDate, policy.organizationId);
    rows += await summarizeActivityMetricDay(tx, workDate, policy.organizationId);
    rows += await summarizeActivitySessionDay(tx, workDate, policy.organizationId);
  }

  // Also backfill any unsummarized historical days (e.g. from server downtime / load shedding)
  const backfilled = await backfillMissingDailySummaries(tx);
  rows += backfilled;

  if (rows === 0) return null;
  return `summarized ${rows} daily summary row(s) (including ${backfilled} backfilled)`;
}
