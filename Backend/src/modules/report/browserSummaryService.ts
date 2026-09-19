import { Prisma } from "@prisma/client";

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

/** Runs only for organizations whose configured time matches the server's local clock. */
export async function runBrowserSummarySchedule(
  tx: Prisma.TransactionClient,
  now = new Date(),
): Promise<string | null> {
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const policies = await tx.policy.findMany({
    where: { reportSummaryScheduleTimeLocal: currentTime },
    select: { organizationId: true },
  });
  if (policies.length === 0) return null;

  const previousWorkDate = new Date(now);
  previousWorkDate.setDate(previousWorkDate.getDate() - 1);
  const workDate = previousWorkDate.toISOString().slice(0, "YYYY-MM-DD".length);
  let rows = 0;
  for (const policy of policies) {
    rows += await summarizeBrowserDay(tx, workDate, policy.organizationId);
    rows += await summarizeActivityMetricDay(tx, workDate, policy.organizationId);
    rows += await summarizeActivitySessionDay(tx, workDate, policy.organizationId);
  }
  return `summarized ${rows} daily summary row(s) for ${workDate}`;
}
