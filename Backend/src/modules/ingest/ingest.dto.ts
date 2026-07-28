import { z } from 'zod';

export const rawSampleSchema = z.object({
  appName: z.string().nullable().optional(),
  windowTitle: z.string().nullable().optional(),
  domain: z.string().nullable().optional(),
  isIdle: z.boolean(),
  capturedAt: z.string().datetime().or(z.date()).transform((val) => new Date(val)),
});

export const ingestBatchSchema = z.object({
  samples: z.array(rawSampleSchema).min(1, 'Samples array cannot be empty'),
});

export type RawSampleDto = z.infer<typeof rawSampleSchema>;
export type IngestBatchDto = z.infer<typeof ingestBatchSchema>;

// Agent API PascalCase Schemas
export const agentActivityLogSchema = z.object({
  DeviceId: z.string(),
  AppName: z.string().nullable().optional(),
  WindowTitle: z.string().nullable().optional(),
  Domain: z.string().nullable().optional(),
  IsIdle: z.boolean(),
  ActivityScore: z.number().int(),
  CapturedAt: z.string().datetime().or(z.date()).transform((val) => new Date(val)),
});

export const agentScreenshotSchema = z.object({
  DeviceId: z.string(),
  CapturedAt: z.string().datetime().or(z.date()).transform((val) => new Date(val)),
  EncryptedImageData: z.string(),
});

export const agentUsbLogSchema = z.object({
  DeviceId: z.string(),
  DeviceName: z.string(),
  Action: z.string(),
  CapturedAt: z.string().datetime().or(z.date()).transform((val) => new Date(val)),
});

export const agentAttendanceRecordSchema = z.object({
  DeviceId: z.string(),
  Date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  FirstLogin: z.string().datetime().or(z.date()).transform((val) => new Date(val)),
  LastLogout: z.string().datetime().or(z.date()).nullable().optional().transform((val) => val ? new Date(val) : null),
  TotalActiveSeconds: z.number().int(),
});

export const agentIngestSchema = z.object({
  DeviceId: z.string(),
  ActivityLogs: z.array(agentActivityLogSchema).optional().default([]),
  Screenshots: z.array(agentScreenshotSchema).optional().default([]),
  UsbLogs: z.array(agentUsbLogSchema).optional().default([]),
  AttendanceRecords: z.array(agentAttendanceRecordSchema).optional().default([]),
});

export type AgentActivityLogDto = z.infer<typeof agentActivityLogSchema>;
export type AgentScreenshotDto = z.infer<typeof agentScreenshotSchema>;
export type AgentUsbLogDto = z.infer<typeof agentUsbLogSchema>;
export type AgentAttendanceRecordDto = z.infer<typeof agentAttendanceRecordSchema>;
export type AgentIngestDto = z.infer<typeof agentIngestSchema>;
