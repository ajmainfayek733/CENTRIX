import { Router } from 'express';
import { reportController } from './reportController';
import { userAuth } from '../../middleware/userAuth';
import { requireRole } from '../../middleware/rbac';
import { auditLogger } from '../../middleware/auditLogger';

const router = Router();

router.use(userAuth as any);

router.get(
  '/overview',
  requireRole('super_admin', 'manager', 'auditor'),
  auditLogger('VIEW_OVERVIEW'),
  reportController.getOverview
);

router.get(
  '/roster',
  requireRole('super_admin', 'manager', 'auditor'),
  auditLogger('VIEW_EMPLOYEE_ROSTER'),
  reportController.getEmployeeRoster
);

router.get(
  '/employees/:employeeId',
  requireRole('super_admin', 'manager', 'auditor'),
  auditLogger('VIEW_EMPLOYEE_DETAIL_REPORT', (req) => `Employee:${req.params.employeeId}`),
  reportController.getEmployeeDetail
);

// Paged timeline behind the detail screen's scroll window. Separate from the detail endpoint so
// scrolling fetches rows only, not the totals and leaderboards that never change between pages.
router.get(
  '/employees/:employeeId/activity',
  requireRole('super_admin', 'manager', 'auditor'),
  auditLogger('VIEW_EMPLOYEE_ACTIVITY_LOG', (req) => `Employee:${req.params.employeeId}`),
  reportController.getActivityLog
);

router.get('/alerts', requireRole('super_admin', 'manager', 'auditor'), auditLogger('VIEW_ALERTS'), reportController.getAlerts);

router.get(
  '/usb-events',
  requireRole('super_admin', 'manager', 'auditor'),
  auditLogger('VIEW_USB_EVENTS'),
  reportController.getUsbEvents
);

// Per-employee slice of the same trail, behind the detail screen's scroll window. Audited
// against the employee so the log answers whose history was read, not merely that some was.
router.get(
  '/employees/:employeeId/usb-events',
  requireRole('super_admin', 'manager', 'auditor'),
  auditLogger('VIEW_EMPLOYEE_USB_EVENTS', (req) => `Employee:${req.params.employeeId}`),
  reportController.getEmployeeUsbEvents
);

// Screenshots are the most invasive surface in the product, so per spec section 6 the Auditor role
// is deliberately excluded from both the index and the image itself - they get aggregate
// reports and the audit log, never a picture of someone's desktop.

router.get(
  '/employees/:employeeId/screenshots',
  requireRole('super_admin', 'manager'),
  auditLogger('VIEW_SCREENSHOT_INDEX', (req) => `Employee:${req.params.employeeId}`),
  reportController.getScreenshots
);

router.get(
  '/screenshots/:deviceId/:file',
  requireRole('super_admin', 'manager'),
  auditLogger('VIEW_SCREENSHOT', (req) => `Screenshot:${req.params.deviceId}/${req.params.file}`),
  reportController.getScreenshotFile
);

export default router;
