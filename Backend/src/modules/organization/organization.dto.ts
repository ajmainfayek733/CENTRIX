import { z } from "zod";
import { env } from "../../config/env";

export const createOrganizationSchema = z.object({
  name: z.string().min(2, "Organization name is required"),
});

const seconds = z.number().int().min(0);

/**
 * Policy settings screen (spec section 5). Every field is optional - the screen PATCHes only what
 * changed, and the service bumps `version` on any write so agents notice.
 */
export const updatePolicySchema = z
  .object({
    attendanceEnabled: z.boolean(),

    activityEnabled: z.boolean(),
    idleThresholdSeconds: seconds.min(30).max(3600),

    appSessionEnabled: z.boolean(),
    appSessionPollSeconds: seconds.min(1).max(60),

    browserMonitorEnabled: z.boolean(),
    browserUiaTimeoutMs: seconds.min(100).max(10_000),
    browserMaxRetryAttempts: z.number().int().min(0).max(10),

    // Bounded on both ends for the same reason: this is what a browser costs the workstation.
    // One second is a UI Automation call per tick on every machine with a browser open, which is
    // the behaviour this setting exists to prevent; beyond five minutes, time-per-site stops
    // being a measurement and becomes a sample.
    browserUrlRefreshSeconds: seconds.min(1).max(300),
    browserSummaryScheduleTimeLocal: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm"),

    screenshotEnabled: z.boolean(),
    screenshotIntervalSeconds: seconds.min(60).max(86_400),
    screenshotJpegQuality: z.number().int().min(10).max(100),

    usbEnabled: z.boolean(),
    usbReconciliationIntervalSeconds: seconds.min(1).max(300),
    usbAlertOnInsertion: z.boolean(),

    alertEnabled: z.boolean(),
    alertIdleEnabled: z.boolean(),
    alertIdleNormalSeconds: seconds.min(60),
    alertIdleModerateSeconds: seconds.min(60),
    alertIdleSevereSeconds: seconds.min(60),
    alertIdleRenotifySeconds: seconds.min(60),
    alertBlacklistEnabled: z.boolean(),
    alertOutsideWorkingHours: z.boolean(),

    syncBatchIntervalSeconds: seconds.min(10).max(3600),
    // Capped at the server's own per-request ceiling. Allowing a larger value would let an admin
    // configure the fleet to send batches this server is guaranteed to answer with a 400, which
    // strands every agent's queue until someone works out why.
    syncMaxBatchSize: z.number().int().min(1).max(env.INGEST_MAX_BATCH_EVENTS),
    syncMinRetryBackoffSeconds: seconds.min(1),
    syncMaxRetryBackoffSeconds: seconds.min(1),

    realtimeEnabled: z.boolean(),

    // Bounded on both ends: below ~5s a fleet of 100 becomes a needless frame storm, and above a
    // minute "active now" stops being a useful answer to the question it claims to answer.
    presenceHeartbeatSeconds: seconds.min(5).max(300),

    // Rows per page in the dashboard's log tables. Bounded on both ends: too small and scrolling
    // becomes a request storm, too large and the fixed-height window it feeds stops being a
    // bounded read.
    logPageSize: z.number().int().min(10).max(500),

    // Captures per page in the screenshot gallery. A much lower ceiling than logPageSize because
    // the cost is image bytes, not rows: at roughly half a megabyte a capture, 60 is already ~30 MB
    // in flight for one page. The floor is one row of the 3-across grid.
    screenshotPageSize: z.number().int().min(3).max(60),

    retentionDays: z.number().int().min(1).max(3650),
    undeliveredRetentionDays: z.number().int().min(1).max(365),

    workingHoursStartLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm"),
    workingHoursEndLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm"),
    workingDays: z.array(
      z.enum(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
    ),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "No settings supplied" })
  .refine(
    (v) =>
      v.alertIdleNormalSeconds === undefined ||
      v.alertIdleModerateSeconds === undefined ||
      v.alertIdleNormalSeconds < v.alertIdleModerateSeconds,
    { message: "Idle escalation thresholds must increase: normal < moderate < severe" },
  )
  .refine(
    (v) =>
      v.alertIdleModerateSeconds === undefined ||
      v.alertIdleSevereSeconds === undefined ||
      v.alertIdleModerateSeconds < v.alertIdleSevereSeconds,
    { message: "Idle escalation thresholds must increase: normal < moderate < severe" },
  );

export const upsertCategorySchema = z.object({
  pattern: z.string().min(1, "Pattern is required").max(255),
  target: z.enum(["Application", "Domain"]),
  tag: z.enum(["Productive", "Unproductive", "Blacklisted", "Neutral"]),
  isBlacklisted: z.boolean().default(false),
});

export type CreateOrganizationDto = z.infer<typeof createOrganizationSchema>;
export type UpdatePolicyDto = z.infer<typeof updatePolicySchema>;
export type UpsertCategoryDto = z.infer<typeof upsertCategorySchema>;
