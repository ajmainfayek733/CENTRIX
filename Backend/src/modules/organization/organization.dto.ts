import { z } from 'zod';

export const createOrganizationSchema = z.object({
  name: z.string().min(2, 'Name is required'),
});

export type CreateOrganizationDto = z.infer<typeof createOrganizationSchema>;
