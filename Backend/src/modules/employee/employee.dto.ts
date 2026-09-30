import { z } from 'zod';

const MAX_BULK_EMPLOYEES = 1000;

/**
 * One roster entry. `departmentId` is the authoritative reference (picked from the org's
 * departments). `department` is a plain name, used by the paste-import; it is matched to an
 * existing department case-insensitively and never creates one. Anything that does not resolve
 * leaves the employee unassigned - the admin creates the department and assigns them later.
 */
const employeeRowSchema = z.object({
  name: z.string().trim().min(2, 'Name is required'),
  email: z.string().trim().email('Invalid email address'),
  departmentId: z.string().uuid('Invalid department ID').nullish(),
  department: z.string().trim().optional(),
});

export const createEmployeeSchema = employeeRowSchema.extend({
  organizationId: z.string().uuid('Invalid organization ID'),
});

/**
 * Bulk roster insert. Onboarding 30-100+ people one POST at a time is the difference between a
 * ten-minute rollout and an afternoon, so this takes the whole roster in one request.
 *
 * Capped well below the JSON body limit - a thousand rows is already far past any single-site
 * deployment this backend targets, and an unbounded array would let one request hold a database
 * transaction open indefinitely.
 */
export const bulkCreateEmployeesSchema = z.object({
  organizationId: z.string().uuid('Invalid organization ID'),
  employees: z
    .array(employeeRowSchema)
    .min(1, 'At least one employee is required')
    .max(MAX_BULK_EMPLOYEES, `At most ${MAX_BULK_EMPLOYEES} employees per request`),
});

export const updateEmployeeSchema = z.object({
  name: z.string().min(2).optional(),
  department: z.string().nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

/**
 * Devices enroll themselves (Features.md "Device Auth") and land on the org's "Unassigned
 * Devices" placeholder. This is how an admin then attaches one to a real person - there is no
 * manual device-registration endpoint any more, because the agent mints its own credential.
 */
export const assignDeviceSchema = z.object({
  employeeId: z.string().uuid('Invalid employee ID'),
});

export const deviceStatusSchema = z.object({
  isActive: z.boolean(),
});

export type CreateEmployeeDto = z.infer<typeof createEmployeeSchema>;
export type BulkCreateEmployeesDto = z.infer<typeof bulkCreateEmployeesSchema>;
export type UpdateEmployeeDto = z.infer<typeof updateEmployeeSchema>;
export type AssignDeviceDto = z.infer<typeof assignDeviceSchema>;
export type DeviceStatusDto = z.infer<typeof deviceStatusSchema>;
