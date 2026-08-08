import { z } from 'zod';

export const createEmployeeSchema = z.object({
  organizationId: z.string().uuid('Invalid organization ID'),
  name: z.string().min(2, 'Name is required'),
  email: z.string().email('Invalid email address'),
  department: z.string().optional(),
});

export const updateEmployeeSchema = z.object({
  name: z.string().min(2).optional(),
  department: z.string().nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

/**
 * Devices enroll themselves (Features.md "Device Auth") and land on the org's "Unassigned
 * Devices" placeholder. This is how an admin then attaches one to a real person — there is no
 * manual device-registration endpoint any more, because the agent mints its own credential.
 */
export const assignDeviceSchema = z.object({
  employeeId: z.string().uuid('Invalid employee ID'),
});

export const deviceStatusSchema = z.object({
  isActive: z.boolean(),
});

export type CreateEmployeeDto = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeDto = z.infer<typeof updateEmployeeSchema>;
export type AssignDeviceDto = z.infer<typeof assignDeviceSchema>;
export type DeviceStatusDto = z.infer<typeof deviceStatusSchema>;
