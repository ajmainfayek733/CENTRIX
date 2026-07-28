import { z } from 'zod';

export const createEmployeeSchema = z.object({
  organizationId: z.string().uuid('Invalid organization ID'),
  name: z.string().min(2, 'Name is required'),
  email: z.string().email('Invalid email address'),
  department: z.string().optional(),
});

export const registerDeviceSchema = z.object({
  employeeId: z.string().uuid('Invalid employee ID'),
  // Windows MachineGuid (spec §5.1) — the device's stable identity across the life of the OS install.
  machineId: z.string().min(1, 'machineId is required'),
  hostname: z.string().min(1, 'Hostname is required'),
  os: z.string().min(1, 'OS is required'),
  agentVersion: z.string().optional(),
});

export const deviceStatusSchema = z.object({
  isActive: z.boolean(),
});

export type CreateEmployeeDto = z.infer<typeof createEmployeeSchema>;
export type RegisterDeviceDto = z.infer<typeof registerDeviceSchema>;
export type DeviceStatusDto = z.infer<typeof deviceStatusSchema>;
