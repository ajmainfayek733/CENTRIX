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

/** Runs only for organizations whose configured time matches the server's local clock. */
export async function runBrowserSummarySchedule(
  tx: Prisma.TransactionClient,
  now = new Date(),
): Promise<string | null> {
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const policies = await tx.policy.findMany({
    where: { browserSummaryScheduleTimeLocal: currentTime },
    select: { organizationId: true },
  });
  if (policies.length === 0) return null;

  const previousWorkDate = new Date(now);
  previousWorkDate.setDate(previousWorkDate.getDate() - 1);
  const workDate = previousWorkDate.toISOString().slice(0, "YYYY-MM-DD".length);
  let rows = 0;
  for (const policy of policies) {
    rows += await summarizeBrowserDay(tx, workDate, policy.organizationId);
  }
  return `summarized ${rows} browser domain row(s) for ${workDate}`;
}
