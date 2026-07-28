import { z } from 'zod';

// Path segments as documented in spec §4.1, mapped 1:1 onto the Prisma TelemetryChannel enum
// (via @map) for the five insert-only channels. `alert` is handled separately (upsert, §4.1.6).
export const STORABLE_CHANNELS = [
  'attendance',
  'app-session',
  'activity-session',
  'browser-navigation',
  'usb-device',
] as const;

export const ALL_CHANNELS = [...STORABLE_CHANNELS, 'alert'] as const;
export type Channel = (typeof ALL_CHANNELS)[number];

export const channelParamSchema = z.object({
  channel: z.enum(ALL_CHANNELS),
});

// Sanity ceiling well above the documented default MaxBatchSize (500, admin-configurable per
// policy §3.1) so we never reject a batch the Agent is configured to send, while still bounding
// request size against abuse.
const MAX_EVENTS_PER_PUSH = 2000;

export const pushEventItemSchema = z.object({
  clientEventId: z.string().uuid('clientEventId must be a GUID'),
  payloadJson: z.string().min(1, 'payloadJson must be a non-empty JSON string'),
});

export const pushEventsSchema = z.object({
  events: z.array(pushEventItemSchema).min(1).max(MAX_EVENTS_PER_PUSH),
});

export type PushEventItemDto = z.infer<typeof pushEventItemSchema>;
export type PushEventsDto = z.infer<typeof pushEventsSchema>;

// Minimal shape every channel payload must carry, per spec §5.1. Everything else in the parsed
// payload is stored verbatim in TelemetryEvent.payload / folded into the Alert row.
export const commonPayloadSchema = z.object({
  MachineId: z.string().min(1).optional(),
  UserSid: z.string().min(1, 'payload.UserSid is required'),
});

export const alertPayloadSchema = z.object({
  MachineId: z.string().min(1).optional(),
  UserSid: z.string().min(1),
  Type: z.string().min(1),
  Severity: z.enum(['Information', 'Warning', 'High', 'Critical']),
  State: z.enum(['New', 'Shown', 'Acknowledged', 'Resolved', 'Archived']),
  Title: z.string().min(1),
  Message: z.string().min(1),
  ContextJson: z.string(),
  TriggeredAtUtc: z.string().datetime({ offset: true }).or(z.string().datetime()),
  AcknowledgedAtUtc: z.string().nullable().optional(),
  ResolvedAtUtc: z.string().nullable().optional(),
  LastNotifiedAtUtc: z.string().nullable().optional(),
  EscalationLevel: z.number().int(),
  NotificationCount: z.number().int(),
});

export const screenshotFieldsSchema = z.object({
  clientEventId: z.string().uuid('clientEventId must be a GUID'),
  machineId: z.string().min(1),
  capturedAtUtc: z.string().min(1),
});

export const consentSchema = z.object({
  userSid: z.string().min(1),
  machineId: z.string().min(1),
  policyVersion: z.number().int(),
  acknowledgedAtUtc: z.string().min(1),
});

export type ConsentDto = z.infer<typeof consentSchema>;
