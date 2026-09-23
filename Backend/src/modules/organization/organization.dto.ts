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

    browserUrlRefreshSeconds: seconds.min(1).max(300),
    reportSummaryScheduleTimeLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm"),

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
    syncMaxBatchSize: z.number().int().min(1).max(env.INGEST_MAX_BATCH_EVENTS),
    syncMinRetryBackoffSeconds: seconds.min(1),
    syncMaxRetryBackoffSeconds: seconds.min(1),

    realtimeEnabled: z.boolean(),
    presenceHeartbeatSeconds: seconds.min(5).max(300),

    logPageSize: z.number().int().min(10).max(500),
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

export const createDepartmentSchema = z.object({
  name: z.string().min(1, "Department name is required").max(100),
  description: z.string().max(255).optional(),
});

export const updateDepartmentSchema = z.object({
  name: z.string().min(1, "Department name is required").max(100).optional(),
  description: z.string().max(255).nullish(),
});

export const addDepartmentMembersSchema = z.object({
  employeeIds: z.array(z.string().uuid()).min(1, "At least one employeeId is required"),
});

export const upsertCategorySchema = z.object({
  pattern: z.string().min(1, "Pattern is required").max(255),
  target: z.enum(["Application", "Domain"]),
  tag: z.enum(["Productive", "Unproductive", "Blacklisted", "Neutral"]),
  isBlacklisted: z.boolean().default(false),
  departmentId: z.string().uuid().nullish(),
});

export type CreateOrganizationDto = z.infer<typeof createOrganizationSchema>;
export type UpdatePolicyDto = z.infer<typeof updatePolicySchema>;
export type CreateDepartmentDto = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentDto = z.infer<typeof updateDepartmentSchema>;
export type AddDepartmentMembersDto = z.infer<typeof addDepartmentMembersSchema>;
export type UpsertCategoryDto = z.infer<typeof upsertCategorySchema>;
