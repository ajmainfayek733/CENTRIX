import { Prisma } from "@prisma/client";
import { prisma } from "../src/config/db";
import {
  summarizeActivityMetricDay,
  summarizeActivitySessionDay,
  summarizeBrowserDay,
} from "../src/modules/report/browserSummaryService";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1_000;

interface Options {
  from?: string;
  to?: string;
  organizationId?: string;
  type: "browser" | "activity-metrics" | "activity-sessions";
}

function parseOptions(args: string[]): Options {
  const options: Options = { type: "browser" };

  for (const arg of args) {
    const separator = arg.indexOf("=");
    if (separator < 0) throw new Error(`Invalid argument '${arg}'. Expected --name=value.`);

    const name = arg.slice(0, separator);
    const value = arg.slice(separator + 1);
    if (!value) throw new Error(`Argument '${name}' requires a value.`);

    switch (name) {
      case "--from":
        options.from = value;
        break;
      case "--to":
        options.to = value;
        break;
      case "--organization-id":
        options.organizationId = value;
        break;
      case "--type":
        if (value !== "browser" && value !== "activity-metrics" && value !== "activity-sessions") {
          throw new Error("--type must be browser, activity-metrics, or activity-sessions.");
        }
        options.type = value;
        break;
      default:
        throw new Error(`Unknown argument '${name}'.`);
    }
  }

  return options;
}

function parseDate(value: string, name: string): Date {
  if (!DATE_PATTERN.test(value)) {
    throw new Error(`${name} must use YYYY-MM-DD format.`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} is not a valid calendar date.`);
  }
  return date;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function yesterdayUtc(): Date {
  const today = new Date();
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

async function historicalBounds(type: Options["type"], organizationId?: string) {
  const table =
    type === "browser"
      ? "browser_activity"
      : type === "activity-metrics"
        ? "activity_metrics"
        : "activity_sessions";
  const alias =
    type === "browser" ? "browser" : type === "activity-metrics" ? "metric" : "activity";
  const timestamp = type === "activity-metrics" ? 'metric."windowEndUtc"' : `${alias}."startTime"`;
  const sessionJoin =
    type === "browser"
      ? Prisma.sql`LEFT JOIN activity_sessions activity ON activity."activitySessionId" = browser."activitySessionId"
                   LEFT JOIN attendance_sessions attendance ON attendance."sessionId" = activity."sessionId"`
      : Prisma.sql`LEFT JOIN attendance_sessions attendance ON attendance."sessionId" = metric."sessionId"`;

  const joins =
    type === "browser"
      ? sessionJoin
      : type === "activity-metrics"
        ? sessionJoin
        : Prisma.sql`LEFT JOIN attendance_sessions attendance ON attendance."sessionId" = activity."sessionId"`;

  return prisma.$queryRaw<{ minDate: string | null; maxDate: string | null }[]>`
    SELECT
      MIN(COALESCE(attendance."workDate", ${Prisma.raw(timestamp)}::date))::text AS "minDate",
      MAX(COALESCE(attendance."workDate", ${Prisma.raw(timestamp)}::date))::text AS "maxDate"
    FROM ${Prisma.raw(table)} ${Prisma.raw(alias)}
    JOIN devices device ON device.id = ${Prisma.raw(`${alias}."deviceId"`)}
    ${joins}
    WHERE ${organizationId ? Prisma.sql`device."organizationId" = ${organizationId}` : Prisma.sql`TRUE`}
      AND COALESCE(attendance."workDate", ${Prisma.raw(timestamp)}::date) < CURRENT_DATE
  `;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const yesterday = yesterdayUtc();
  const bounds = await historicalBounds(options.type, options.organizationId);
  const firstStoredDate = bounds[0]?.minDate
    ? parseDate(bounds[0].minDate, "stored minimum date")
    : null;

  const from = options.from ? parseDate(options.from, "--from") : firstStoredDate;
  const to = options.to ? parseDate(options.to, "--to") : yesterday;

  if (!from) {
    console.log(`No previous ${options.type} dates found. Nothing to aggregate.`);
    return;
  }
  if (from > to) throw new Error("--from must be on or before --to.");
  if (to > yesterday) throw new Error("--to cannot be today or a future date.");

  console.log(`Aggregating ${options.type} from ${formatDate(from)} through ${formatDate(to)}`);
  if (options.organizationId) console.log(`Organization: ${options.organizationId}`);

  let date = from;
  let totalRows = 0;
  let days = 0;

  while (date <= to) {
    const workDate = formatDate(date);
    const rows = await prisma.$transaction((tx) =>
      options.type === "browser"
        ? summarizeBrowserDay(tx, workDate, options.organizationId)
        : options.type === "activity-metrics"
          ? summarizeActivityMetricDay(tx, workDate, options.organizationId)
          : summarizeActivitySessionDay(tx, workDate, options.organizationId),
    );
    totalRows += rows;
    days += 1;
    console.log(`  ${workDate}: ${rows} summary row(s)`);
    date = addDays(date, 1);
  }

  console.log(`Completed ${days} day(s), rebuilding ${totalRows} summary row(s).`);
}

main()
  .catch((error) => {
    console.error("Browser history aggregation failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
