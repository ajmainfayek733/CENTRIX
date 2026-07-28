import { Router } from 'express';
import { reportController } from './reportController';
import { userAuth } from '../../middleware/userAuth';
import { requireRole } from '../../middleware/rbac';
import { auditLogger } from '../../middleware/auditLogger';

const router = Router();

router.use(userAuth as any);

router.get(
  '/team',
  requireRole('super_admin', 'manager', 'auditor'),
  auditLogger('VIEW_TEAM_SUMMARY_REPORT'),
  reportController.getTeamSummary
);

router.get(
  '/employee/:employeeId',
  requireRole('super_admin', 'manager', 'auditor'),
  auditLogger('VIEW_EMPLOYEE_TIMELINE_REPORT', (req) => `EmployeeTimeline:${req.params.employeeId}`),
  reportController.getEmployeeTimeline
);

export default router;
