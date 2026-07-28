import { Router } from 'express';
import { organizationController } from './organizationController';
import { userAuth } from '../../middleware/userAuth';
import { requireRole } from '../../middleware/rbac';
import { auditLogger } from '../../middleware/auditLogger';
import { validate } from '../../middleware/validate';
import { createOrganizationSchema } from './organization.dto';

const router = Router();

router.use(userAuth as any);

router.get(
  '/',
  requireRole('super_admin', 'manager', 'auditor'),
  auditLogger('VIEW_ALL_ORGANIZATIONS'),
  organizationController.getAllOrganizations
);

router.get(
  '/:id',
  requireRole('super_admin', 'manager', 'auditor'),
  auditLogger('VIEW_ORGANIZATION_DETAIL', (req) => `Organization:${req.params.id}`),
  organizationController.getOrganizationById
);

router.post(
  '/',
  requireRole('super_admin'),
  validate(createOrganizationSchema),
  auditLogger('CREATE_ORGANIZATION'),
  organizationController.createOrganization
);

export default router;
