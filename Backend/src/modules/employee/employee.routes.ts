import { Router } from 'express';
import { employeeController } from './employeeController';
import { userAuth } from '../../middleware/userAuth';
import { requireRole } from '../../middleware/rbac';
import { auditLogger } from '../../middleware/auditLogger';
import { validate } from '../../middleware/validate';
import {
  assignDeviceSchema,
  bulkCreateEmployeesSchema,
  createEmployeeSchema,
  deviceStatusSchema,
  updateEmployeeSchema,
} from './employee.dto';

const router = Router();

router.use(userAuth as any);

// -- Device inventory (Features.md "Device Information") ---------------------
// Declared before /:id so "devices" isn't captured as an employee id.

router.get(
  '/devices',
  requireRole('super_admin', 'manager', 'auditor'),
  auditLogger('VIEW_DEVICE_INVENTORY'),
  employeeController.listDevices
);

router.patch(
  '/devices/:deviceId/assignment',
  requireRole('super_admin'),
  validate(assignDeviceSchema),
  auditLogger('ASSIGN_DEVICE', (req) => `Device:${req.params.deviceId}`),
  employeeController.assignDevice
);

router.patch(
  '/devices/:deviceId/status',
  requireRole('super_admin'),
  validate(deviceStatusSchema),
  auditLogger('SET_DEVICE_STATUS', (req) => `Device:${req.params.deviceId}`),
  employeeController.setDeviceActive
);

// -- Employees ---------------------------------------------------------------

router.get(
  '/',
  requireRole('super_admin', 'manager', 'auditor'),
  auditLogger('VIEW_ALL_EMPLOYEES'),
  employeeController.getAllEmployees
);

router.get(
  '/:id',
  requireRole('super_admin', 'manager', 'auditor'),
  auditLogger('VIEW_EMPLOYEE_DETAIL', (req) => `Employee:${req.params.id}`),
  employeeController.getEmployeeById
);

router.post(
  '/',
  requireRole('super_admin'),
  validate(createEmployeeSchema),
  auditLogger('CREATE_EMPLOYEE'),
  employeeController.createEmployee
);

// Roster import — onboarding 30-100+ people one request at a time is the difference between a
// ten-minute rollout and an afternoon. Partial success is normal here; see the service.
router.post(
  '/bulk',
  requireRole('super_admin'),
  validate(bulkCreateEmployeesSchema),
  auditLogger('BULK_CREATE_EMPLOYEES'),
  employeeController.bulkCreateEmployees
);

router.patch(
  '/:id',
  requireRole('super_admin'),
  validate(updateEmployeeSchema),
  auditLogger('UPDATE_EMPLOYEE', (req) => `Employee:${req.params.id}`),
  employeeController.updateEmployee
);

export default router;
