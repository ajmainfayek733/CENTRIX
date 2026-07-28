import { Router } from 'express';
import { employeeController } from './employeeController';
import { userAuth } from '../../middleware/userAuth';
import { requireRole } from '../../middleware/rbac';
import { auditLogger } from '../../middleware/auditLogger';
import { validate } from '../../middleware/validate';
import { createEmployeeSchema, registerDeviceSchema, deviceStatusSchema } from './employee.dto';

const router = Router();

// Protect all employee routes with userAuth
router.use(userAuth as any);

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

router.post(
  '/devices',
  requireRole('super_admin'),
  validate(registerDeviceSchema),
  auditLogger('REGISTER_DEVICE'),
  employeeController.registerDevice
);

router.patch(
  '/devices/:deviceId/status',
  requireRole('super_admin'),
  validate(deviceStatusSchema),
  auditLogger('SET_DEVICE_STATUS', (req) => `Device:${req.params.deviceId}`),
  employeeController.setDeviceActive
);

export default router;
