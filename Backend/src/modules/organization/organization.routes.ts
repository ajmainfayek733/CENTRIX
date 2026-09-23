import { Router } from "express";
import { organizationController } from "./organizationController";
import { userAuth } from "../../middleware/userAuth";
import { requireRole } from "../../middleware/rbac";
import { auditLogger } from "../../middleware/auditLogger";
import { validate } from "../../middleware/validate";
import {
  addDepartmentMembersSchema,
  createDepartmentSchema,
  createOrganizationSchema,
  updateDepartmentSchema,
  updatePolicySchema,
  upsertCategorySchema,
} from "./organization.dto";

const router = Router();

router.use(userAuth as any);

router.get(
  "/",
  requireRole("super_admin", "manager", "auditor"),
  auditLogger("VIEW_ALL_ORGANIZATIONS"),
  organizationController.getAllOrganizations,
);

router.get(
  "/:id",
  requireRole("super_admin", "manager", "auditor"),
  auditLogger("VIEW_ORGANIZATION_DETAIL", (req) => `Organization:${req.params.id}`),
  organizationController.getOrganizationById,
);

router.post(
  "/",
  requireRole("super_admin"),
  validate(createOrganizationSchema),
  auditLogger("CREATE_ORGANIZATION"),
  organizationController.createOrganization,
);

// Minting a credential that lets a new machine join the fleet is super_admin only.
router.post(
  "/:id/enrollment-token",
  requireRole("super_admin"),
  auditLogger("ROTATE_ENROLLMENT_TOKEN", (req) => `Organization:${req.params.id}`),
  organizationController.rotateEnrollmentToken,
);

// -- Policy settings --------------------------------------------------------
router.get(
  "/:id/policy",
  requireRole("super_admin", "manager", "auditor"),
  auditLogger("VIEW_POLICY", (req) => `Organization:${req.params.id}`),
  organizationController.getPolicy,
);

router.patch(
  "/:id/policy",
  requireRole("super_admin"),
  validate(updatePolicySchema),
  auditLogger("UPDATE_POLICY", (req) => `Organization:${req.params.id}`),
  organizationController.updatePolicy,
);

// -- Departments ------------------------------------------------------------
router.get(
  "/:id/departments",
  requireRole("super_admin", "manager", "auditor"),
  auditLogger("VIEW_DEPARTMENTS", (req) => `Organization:${req.params.id}`),
  organizationController.listDepartments,
);

router.get(
  "/:id/departments/:deptId",
  requireRole("super_admin", "manager", "auditor"),
  auditLogger("VIEW_DEPARTMENT_DETAIL", (req) => `Department:${req.params.deptId}`),
  organizationController.getDepartmentById,
);

router.post(
  "/:id/departments",
  requireRole("super_admin"),
  validate(createDepartmentSchema),
  auditLogger("CREATE_DEPARTMENT", (req) => `Organization:${req.params.id}`),
  organizationController.createDepartment,
);

router.patch(
  "/:id/departments/:deptId",
  requireRole("super_admin"),
  validate(updateDepartmentSchema),
  auditLogger("UPDATE_DEPARTMENT", (req) => `Department:${req.params.deptId}`),
  organizationController.updateDepartment,
);

router.delete(
  "/:id/departments/:deptId",
  requireRole("super_admin"),
  auditLogger("DELETE_DEPARTMENT", (req) => `Department:${req.params.deptId}`),
  organizationController.deleteDepartment,
);

router.post(
  "/:id/departments/:deptId/members",
  requireRole("super_admin"),
  validate(addDepartmentMembersSchema),
  auditLogger("ADD_DEPARTMENT_MEMBERS", (req) => `Department:${req.params.deptId}`),
  organizationController.addDepartmentMembers,
);

router.delete(
  "/:id/departments/:deptId/members/:employeeId",
  requireRole("super_admin"),
  auditLogger(
    "REMOVE_DEPARTMENT_MEMBER",
    (req) => `Department:${req.params.deptId}:Employee:${req.params.employeeId}`,
  ),
  organizationController.removeDepartmentMember,
);

// -- Categories (Org-wide & Department-scoped) -------------------------------
router.get(
  "/:id/categories",
  requireRole("super_admin", "manager", "auditor"),
  auditLogger("VIEW_CATEGORIES", (req) => `Organization:${req.params.id}`),
  organizationController.listCategories,
);

router.post(
  "/:id/categories",
  requireRole("super_admin"),
  validate(upsertCategorySchema),
  auditLogger("UPSERT_CATEGORY", (req) => `Organization:${req.params.id}`),
  organizationController.upsertCategory,
);

router.put(
  "/:id/categories",
  requireRole("super_admin"),
  validate(upsertCategorySchema),
  auditLogger("UPSERT_CATEGORY", (req) => `Organization:${req.params.id}`),
  organizationController.upsertCategory,
);

router.delete(
  "/:id/categories/:categoryId",
  requireRole("super_admin"),
  auditLogger("DELETE_CATEGORY", (req) => `Category:${req.params.categoryId}`),
  organizationController.deleteCategory,
);

// Department-scoped category sub-routes
router.get(
  "/:id/departments/:deptId/categories",
  requireRole("super_admin", "manager", "auditor"),
  auditLogger("VIEW_DEPARTMENT_CATEGORIES", (req) => `Department:${req.params.deptId}`),
  organizationController.listCategories,
);

router.post(
  "/:id/departments/:deptId/categories",
  requireRole("super_admin"),
  validate(upsertCategorySchema),
  auditLogger("UPSERT_DEPARTMENT_CATEGORY", (req) => `Department:${req.params.deptId}`),
  organizationController.upsertCategory,
);

router.put(
  "/:id/departments/:deptId/categories",
  requireRole("super_admin"),
  validate(upsertCategorySchema),
  auditLogger("UPSERT_DEPARTMENT_CATEGORY", (req) => `Department:${req.params.deptId}`),
  organizationController.upsertCategory,
);

router.delete(
  "/:id/departments/:deptId/categories/:categoryId",
  requireRole("super_admin"),
  auditLogger("DELETE_DEPARTMENT_CATEGORY", (req) => `Category:${req.params.categoryId}`),
  organizationController.deleteCategory,
);

export default router;
