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
