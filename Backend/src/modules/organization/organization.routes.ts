import { Router } from 'express';
import { organizationController } from './organizationController';
import { userAuth } from '../../middleware/userAuth';
import { requireRole } from '../../middleware/rbac';
import { auditLogger } from '../../middleware/auditLogger';
import { validate } from '../../middleware/validate';
import { createOrganizationSchema, updatePolicySchema, upsertCategorySchema } from './organization.dto';

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

// Minting a credential that lets a new machine join the fleet is super_admin only.
router.post(
  '/:id/enrollment-token',
  requireRole('super_admin'),
  auditLogger('ROTATE_ENROLLMENT_TOKEN', (req) => `Organization:${req.params.id}`),
  organizationController.rotateEnrollmentToken
);

// -- Policy & category settings (spec §5 "Settings", §6 "Super Admin") -------
// Managers may read the policy so they understand what is being collected, but only a
// super_admin can change what the agents do.

router.get(
  '/:id/policy',
  requireRole('super_admin', 'manager', 'auditor'),
  auditLogger('VIEW_POLICY', (req) => `Organization:${req.params.id}`),
  organizationController.getPolicy
);

router.patch(
  '/:id/policy',
  requireRole('super_admin'),
  validate(updatePolicySchema),
  auditLogger('UPDATE_POLICY', (req) => `Organization:${req.params.id}`),
  organizationController.updatePolicy
);

router.get(
  '/:id/categories',
  requireRole('super_admin', 'manager', 'auditor'),
  auditLogger('VIEW_CATEGORIES', (req) => `Organization:${req.params.id}`),
  organizationController.listCategories
);

router.put(
  '/:id/categories',
  requireRole('super_admin'),
  validate(upsertCategorySchema),
  auditLogger('UPSERT_CATEGORY', (req) => `Organization:${req.params.id}`),
  organizationController.upsertCategory
);

router.delete(
  '/:id/categories/:categoryId',
  requireRole('super_admin'),
  auditLogger('DELETE_CATEGORY', (req) => `Category:${req.params.categoryId}`),
  organizationController.deleteCategory
);

export default router;
