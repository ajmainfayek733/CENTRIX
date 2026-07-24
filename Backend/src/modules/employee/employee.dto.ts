import { z } from 'zod';

export const createEmployeeSchema = z.object({
  name: z.string().min(2, 'Name is required'),
  email: z.string().email('Invalid email address'),
  department: z.string().optional(),
});

export const registerDeviceSchema = z.object({
  employeeId: z.string().uuid('Invalid employee ID'),
  hostname: z.string().min(1, 'Hostname is required'),
  os: z.string().min(1, 'OS is required'),
  agentVersion: z.string().min(1, 'Agent version is required'),
});

export type CreateEmployeeDto = z.infer<typeof createEmployeeSchema>;
export type RegisterDeviceDto = z.infer<typeof registerDeviceSchema>;
