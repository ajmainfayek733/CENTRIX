import { z } from 'zod';
import { env } from '../../config/env';

/**
 * Wire contract for POST /api/v1/events/:channel.
 *
 * v3 change: there is no `payloadJson` envelope any more. Each channel declares a fully
 * typed schema and the fields land in their own columns, so a malformed field is a 400 at
 * the door rather than an unqueryable blob in the database.
 *
 * Field names mirror "Docs/agent/features.md" and the Agent's C# DTOs in
 * Agent.Core/Contracts. A change here is a two-repo commit.
 */

export const CHANNELS = [
  'attendance',
  'activity-metric',
  'activity-session',
  'browser-activity',
  'usb-event',
  'alert',
] as const;

export type Channel = (typeof CHANNELS)[number];

export const channelParamSchema = z.object({
  channel: z.enum(CHANNELS),
});

/**
 * Sanity ceiling, kept well above the policy default MaxBatchSize (100) so we never reject a
 * batch the agent was configured to send, while still bounding request size against abuse.
 * Configurable because the right value depends on fleet size - see INGEST_MAX_BATCH_EVENTS.
 */
const MAX_EVENTS_PER_PUSH = env.INGEST_MAX_BATCH_EVENTS;

const uuid = z.string().uuid();
const utc = z.coerce.date();

/** Non-negative integer second/count field. */
const count = z.number().int().min(0);

// ---------------------------------------------------------------------------
// Attendance - Features.md "Attendace report".
// Upserted on sessionId: the agent re-sends the row as logoutTime firms up across
// lock -> sleep -> shutdown, and the highest `revision` wins.
// ---------------------------------------------------------------------------

export const attendanceEventSchema = z.object({
  clientEventId: uuid,
  sessionId: uuid,
  /// The agent's revision of this session, bumped on every rewrite of the row. It is what
  /// orders the several reports one session produces, so a batch delayed by an outage cannot
  /// overwrite a newer one that got through. Defaults to 0 - meaning "this agent does not
  /// number its reports" - so a fleet mid-rollout keeps ingesting on the older rules.
  revision: count.default(0),
  userSid: z.string().min(1),
  loginTime: utc,
  logoutTime: utc.nullish(),
  endReason: z
    .enum(['Logout', 'Lock', 'Shutdown', 'Restart', 'Hibernate', 'Sleep', 'PowerLoss', 'Disconnect', 'Recovered'])
    .nullish(),
  /// Local calendar date (YYYY-MM-DD) the session is attributed to. Sent by the agent
  /// because only the workstation knows its own timezone.
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'workDate must be YYYY-MM-DD'),
  totalActiveSeconds: count.default(0),
  totalIdleSeconds: count.default(0),
});

// ---------------------------------------------------------------------------
// Activity level metric - Features.md "Activity Level Metric".
// PRIVACY: counts only, never content. There is no field here for a key or character.
// ---------------------------------------------------------------------------

export const activityMetricEventSchema = z.object({
  clientEventId: uuid,
  sessionId: uuid,
  keyCount: count.default(0),
  mouseCount: count.default(0),
  mouseLeftKeyCount: count.default(0),
  mouseRightKeyCount: count.default(0),
  mouseMiddleKeyCount: count.default(0),
  mouseOtherKeyCount: count.default(0),
  windowStartUtc: utc,
  windowEndUtc: utc,
});

// ---------------------------------------------------------------------------
// Activity log - Features.md "Activity Logs".
// ---------------------------------------------------------------------------

export const activitySessionEventSchema = z.object({
  clientEventId: uuid,
  activitySessionId: uuid,
  sessionId: uuid,
  appName: z.string().nullish(),
  processName: z.string().nullish(),
  executablePath: z.string().nullish(),
  type: z.enum(['Application', 'Desktop', 'Locked', 'Idle', 'Sleeping', 'Disconnected']),
  windowTitle: z.string().nullish(),
  startTime: utc,
  endTime: utc,
  durationSeconds: count,
  reason: z.enum(['UserInactivity', 'ScreenLock', 'Sleep', 'Disconnect', 'AppSwitch', 'SessionEnd']).nullish(),
  productivityTag: z.enum(['Productive', 'Unproductive', 'Blacklisted', 'Neutral']).default('Neutral'),
});

// ---------------------------------------------------------------------------
// Browser activity - Features.md "Browser Activity log".
// ---------------------------------------------------------------------------

export const browserActivityEventSchema = z.object({
  clientEventId: uuid,
  browserActivityId: uuid,
  /// Links the visit to its owning foreground-app session, per Features.md.
  activitySessionId: uuid.nullish(),
  browser: z.enum(['Chrome', 'Edge', 'Firefox', 'Brave', 'Opera', 'Vivaldi', 'Other']),
  browserVersion: z.string().nullish(),
  profileName: z.string().nullish(),
  domain: z.string().min(1),
  rawUrl: z.string().min(1),
  windowTitle: z.string().nullish(),
  pageTitle: z.string().nullish(),
  protocol: z.enum(['Http', 'Https']).default('Https'),
  startTime: utc,
  endTime: utc,
  durationSeconds: count,
  productivityTag: z.enum(['Productive', 'Unproductive', 'Blacklisted', 'Neutral']).default('Neutral'),
});

// ---------------------------------------------------------------------------
// USB events - Features.md "USB Logs".
// ---------------------------------------------------------------------------

export const usbEventSchema = z.object({
  clientEventId: uuid,
  sessionId: uuid.nullish(),
  eventType: z.enum(['Connected', 'Disconnected']),
  deviceType: z.enum(['UsbStorage', 'MobileDevice', 'Hid', 'Other']),
  friendlyName: z.string().nullish(),
  manufacturer: z.string().nullish(),
  model: z.string().nullish(),
  serialNumber: z.string().nullish(),
  vendorId: z.string().nullish(),
  productId: z.string().nullish(),
  driveLetter: z.string().nullish(),
  volumeLabel: z.string().nullish(),
  /// Sent as a decimal string: drive capacities exceed the safe integer range in JSON.
  capacityBytes: z
    .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
    .nullish()
    .transform((v) => (v === null || v === undefined ? null : BigInt(v))),
  fileSystem: z.string().nullish(),
  eventTime: utc,
});

// ---------------------------------------------------------------------------
// Alerts - Features.md "Alert Notification".
// Upserted on clientEventId: an escalating incident reuses its id.
// ---------------------------------------------------------------------------

export const alertEventSchema = z.object({
  clientEventId: uuid,
  userSid: z.string().min(1),
  type: z.enum(['IdleThreshold', 'BlacklistedApp', 'BlacklistedWebsite', 'UsbDeviceConnected']),
  severity: z.enum(['Information', 'Warning', 'High', 'Critical']),
  state: z.enum(['New', 'Shown', 'Acknowledged', 'Resolved', 'Archived']).default('New'),
  title: z.string().min(1),
  message: z.string().min(1),

  // Typed replacement for the old free-form contextJson string. Which of these is populated
  // depends on `type` - see the Alert model comment in schema.prisma.
  idleSeconds: count.nullish(),
  thresholdSeconds: count.nullish(),
  contextAppName: z.string().nullish(),
  contextProcessName: z.string().nullish(),
  contextDomain: z.string().nullish(),
  contextUrl: z.string().nullish(),
  contextUsbSerialNumber: z.string().nullish(),
  contextUsbFriendlyName: z.string().nullish(),

  triggeredAt: utc,
  acknowledgedAt: utc.nullish(),
  resolvedAt: utc.nullish(),
  lastNotifiedAt: utc.nullish(),
  escalationLevel: count.default(0),
  notificationCount: count.default(0),
});

// ---------------------------------------------------------------------------

/** Per-channel event schema lookup, used to build the batch validator for a request. */
export const EVENT_SCHEMA_BY_CHANNEL = {
  attendance: attendanceEventSchema,
  'activity-metric': activityMetricEventSchema,
  'activity-session': activitySessionEventSchema,
  'browser-activity': browserActivityEventSchema,
  'usb-event': usbEventSchema,
  alert: alertEventSchema,
} as const;

/**
 * `{ batchId, events: [...] }` validator for one channel.
 *
 * `batchId` identifies this push so a replay is recognized as one and answered without redoing
 * the work - see IngestBatch in the Prisma schema. Optional so an older agent that predates it
 * still ingests: those batches fall back to per-event deduplication, which is correct but does
 * the expensive work again on every replay.
 */
export function batchSchemaFor(channel: Channel) {
  return z.object({
    batchId: uuid.optional(),
    events: z.array(EVENT_SCHEMA_BY_CHANNEL[channel]).min(1).max(MAX_EVENTS_PER_PUSH),
  });
}

export type AttendanceEventDto = z.infer<typeof attendanceEventSchema>;
export type ActivityMetricEventDto = z.infer<typeof activityMetricEventSchema>;
export type ActivitySessionEventDto = z.infer<typeof activitySessionEventSchema>;
export type BrowserActivityEventDto = z.infer<typeof browserActivityEventSchema>;
export type UsbEventDto = z.infer<typeof usbEventSchema>;
export type AlertEventDto = z.infer<typeof alertEventSchema>;

// ---------------------------------------------------------------------------
// Non-event endpoints
// ---------------------------------------------------------------------------

export const screenshotFieldsSchema = z.object({
  clientEventId: uuid,
  capturedAtUtc: z.coerce.date(),
  userSid: z.string().min(1).optional(),
  width: z.coerce.number().int().positive().optional(),
  height: z.coerce.number().int().positive().optional(),
});

export const consentSchema = z.object({
  userSid: z.string().min(1),
  policyVersion: z.number().int().nonnegative(),
  acknowledgedAt: z.coerce.date(),
});

export type ScreenshotFieldsDto = z.infer<typeof screenshotFieldsSchema>;
export type ConsentDto = z.infer<typeof consentSchema>;

/**
 * Hardware addresses arrive in whichever notation the source used - `00:11:22:33:44:55`,
 * `00-11-22-33-44-55`, `00.11.22.33.44.55` or bare hex. They are normalized to one canonical
 * uppercase colon form here so the same NIC cannot appear as several distinct values, which
 * would make the `devices.macAddress` index useless for finding a machine.
 *
 * The all-zero address is normalized to null rather than stored. It is not an address: it is
 * what an enumeration returns when it found nothing, and persisting it makes every such device
 * look identical in the dashboard while quietly hiding the fact that detection failed. Null says
 * "unknown", which is the truth. The agent has its own fix for producing it - see
 * Agent.Core/DeviceIdentity.cs - but the server must not depend on every agent being current.
 */
const MAC_HEX_DIGITS = 12;
const ALL_ZERO_MAC = '0'.repeat(MAC_HEX_DIGITS);

export const macAddressSchema = z
  .string()
  .nullish()
  .transform((value) => {
    if (!value) return null;

    const hex = value.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (hex.length !== MAC_HEX_DIGITS) return null;
    if (hex === ALL_ZERO_MAC) return null;

    return hex.match(/.{2}/g)!.join(':');
  });

/**
 * Device self-registration - Features.md "Device Auth".
 * Identity is the Windows MachineGuid in `deviceId`; the MAC is reported metadata.
 */
export const deviceRegisterSchema = z.object({
  deviceId: z.string().min(1),
  deviceName: z.string().min(1),
  systemType: z.string().nullish(),
  edition: z.string().nullish(),
  version: z.string().nullish(),
  macAddress: macAddressSchema,
  agentVersion: z.string().nullish(),
});

export type DeviceRegisterDto = z.infer<typeof deviceRegisterSchema>;
