import { prisma } from "../../config/db";
import { categoryService } from "../report/categoryService";
import { toAgentPolicy } from "../ingest/policyService";
import { generateEnrollmentToken, hashEnrollmentToken } from "../../utils/token";
import { broadcastPolicyUpdated } from "../../realtime";
import {
  AddDepartmentMembersDto,
  CreateDepartmentDto,
  CreateOrganizationDto,
  UpdateDepartmentDto,
  UpdatePolicyDto,
  UpsertCategoryDto,
} from "./organization.dto";

const DEFAULT_WORKING_HOURS_START = "09:00";
const DEFAULT_WORKING_HOURS_END = "17:00";

function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function isWithinWorkingHours(time: string, start: string, end: string): boolean {
  const value = timeToMinutes(time);
  const startMinutes = timeToMinutes(start);
  const endMinutes = timeToMinutes(end);

  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) return value >= startMinutes && value < endMinutes;
  return value >= startMinutes || value < endMinutes;
}

export class OrganizationService {
  /**
   * Creates the organization together with its policy row, so GET /api/v1/policy always has
   * something to read. Every policy column carries a database default matching Features.md,
   * so an empty `create` produces a complete, valid policy.
   *
   * The enrollment token is returned exactly once, here - it goes into the agent's
   * install-time config (spec section 11) and only its HMAC is stored.
   */
  async createOrganization(dto: CreateOrganizationDto) {
    const enrollmentToken = generateEnrollmentToken();

    const organization = await prisma.organization.create({
      data: {
        name: dto.name,
        enrollmentTokenHash: hashEnrollmentToken(enrollmentToken),
        policy: { create: {} },
      },
    });

    return {
      ...organization,
      enrollmentTokenHash: undefined,
      enrollmentToken,
      note: "Store this enrollment token in the agent installer config. It will not be shown again.",
    };
  }

  /** Invalidates every agent's ability to re-enroll; already-issued device keys keep working. */
  async rotateEnrollmentToken(organizationId: string) {
    await this.getOrganizationById(organizationId);
    const enrollmentToken = generateEnrollmentToken();

    await prisma.organization.update({
      where: { id: organizationId },
      data: { enrollmentTokenHash: hashEnrollmentToken(enrollmentToken) },
    });

    return { enrollmentToken, note: "Existing device API keys are unaffected." };
  }

  async getAllOrganizations() {
    return prisma.organization.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, createdAt: true },
    });
  }

  async getOrganizationById(id: string) {
    const org = await prisma.organization.findUnique({
      where: { id },
      select: { id: true, name: true, createdAt: true },
    });
    if (!org) {
      throw { statusCode: 404, message: "Organization not found" };
    }
    return org;
  }

  // -------------------------------------------------------------------------
  // Policy - Features.md "Configuring Policies"
  // -------------------------------------------------------------------------

  async getPolicy(organizationId: string) {
    await this.getOrganizationById(organizationId);
    const [policy, categories] = await Promise.all([
      prisma.policy.upsert({ where: { organizationId }, create: { organizationId }, update: {} }),
      categoryService.getEffectiveRules(organizationId),
    ]);
    return toAgentPolicy(
      policy,
      categories.map((c) => ({
        pattern: c.pattern,
        target: c.target === "Application" ? "Application" : "Domain",
        tag: c.tag,
        isBlacklisted: c.isBlacklisted,
      })),
    );
  }

  /**
   * Applies a partial settings change. `version` is incremented on every write - agents use it
   * to decide whether to re-prompt for consent, so an update that left it alone would silently
   * skip that prompt.
   */
  async updatePolicy(organizationId: string, dto: UpdatePolicyDto) {
    await this.getOrganizationById(organizationId);

    if (
      dto.reportSummaryScheduleTimeLocal ||
      dto.workingHoursStartLocal ||
      dto.workingHoursEndLocal
    ) {
      const current = await prisma.policy.findUnique({
        where: { organizationId },
        select: {
          workingHoursStartLocal: true,
          workingHoursEndLocal: true,
          reportSummaryScheduleTimeLocal: true,
        },
      });
      const start =
        dto.workingHoursStartLocal ??
        current?.workingHoursStartLocal ??
        DEFAULT_WORKING_HOURS_START;
      const end =
        dto.workingHoursEndLocal ?? current?.workingHoursEndLocal ?? DEFAULT_WORKING_HOURS_END;
      const schedule =
        dto.reportSummaryScheduleTimeLocal ?? current?.reportSummaryScheduleTimeLocal ?? "23:00";
      if (isWithinWorkingHours(schedule, start, end)) {
        throw {
          statusCode: 400,
          message: "Browser summary schedule must be outside working hours",
        };
      }
    }

    const updated = await prisma.policy.upsert({
      where: { organizationId },
      create: { organizationId, ...dto },
      update: { ...dto, version: { increment: 1 } },
    });

    broadcastPolicyUpdated(organizationId, updated.version);

    const categories = await categoryService.getEffectiveRules(organizationId);

    return toAgentPolicy(
      updated,
      categories.map((c) => ({
        pattern: c.pattern,
        target: c.target === "Application" ? "Application" : "Domain",
        tag: c.tag,
        isBlacklisted: c.isBlacklisted,
      })),
    );
  }

  // -------------------------------------------------------------------------
  // Departments & Membership
  // -------------------------------------------------------------------------

  async listDepartments(organizationId: string) {
    await this.getOrganizationById(organizationId);
    return prisma.department.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
      include: {
        _count: {
          select: { employees: true, categories: true },
        },
        categories: {
          orderBy: [{ target: "asc" }, { pattern: "asc" }],
        },
      },
    });
  }

  async getDepartmentById(organizationId: string, departmentId: string) {
    const dept = await prisma.department.findUnique({
      where: { id: departmentId },
      include: {
        employees: {
          select: { id: true, name: true, email: true, status: true },
          orderBy: { name: "asc" },
        },
        categories: {
          orderBy: [{ target: "asc" }, { pattern: "asc" }],
        },
      },
    });

    if (!dept || dept.organizationId !== organizationId) {
      throw { statusCode: 404, message: "Department not found" };
    }

    return dept;
  }

  async createDepartment(organizationId: string, dto: CreateDepartmentDto) {
    await this.getOrganizationById(organizationId);
    const name = dto.name.trim();

    const existing = await prisma.department.findUnique({
      where: { organizationId_name: { organizationId, name } },
    });
    if (existing) {
      throw { statusCode: 409, message: `Department with name '${name}' already exists` };
    }

    return prisma.department.create({
      data: {
        organizationId,
        name,
        description: dto.description?.trim() || null,
      },
    });
  }

  async updateDepartment(organizationId: string, departmentId: string, dto: UpdateDepartmentDto) {
    await this.getDepartmentById(organizationId, departmentId);

    if (dto.name) {
      const name = dto.name.trim();
      const duplicate = await prisma.department.findFirst({
        where: { organizationId, name, id: { not: departmentId } },
      });
      if (duplicate) {
        throw { statusCode: 409, message: `Department with name '${name}' already exists` };
      }
    }

    const updated = await prisma.department.update({
      where: { id: departmentId },
      data: {
        name: dto.name ? dto.name.trim() : undefined,
        description: dto.description !== undefined ? dto.description?.trim() || null : undefined,
      },
    });

    // Also sync the string `department` column on employees in this department
    if (dto.name) {
      await prisma.employee.updateMany({
        where: { departmentId },
        data: { department: dto.name.trim() },
      });
    }

    return updated;
  }

  async deleteDepartment(organizationId: string, departmentId: string) {
    await this.getDepartmentById(organizationId, departmentId);

    await prisma.$transaction(async (tx) => {
      // Unassign members
      await tx.employee.updateMany({
        where: { departmentId },
        data: { departmentId: null, department: null },
      });
      // Delete department (categories cascade)
      await tx.department.delete({ where: { id: departmentId } });
    });

    categoryService.invalidate(organizationId);
    await this.touchPolicyVersion(organizationId);

    return { id: departmentId, deleted: true };
  }

  async addDepartmentMembers(
    organizationId: string,
    departmentId: string,
    dto: AddDepartmentMembersDto,
  ) {
    const dept = await this.getDepartmentById(organizationId, departmentId);

    // Verify all employees belong to this organization
    const employees = await prisma.employee.findMany({
      where: { id: { in: dto.employeeIds }, organizationId },
      select: { id: true },
    });

    if (employees.length === 0) {
      throw { statusCode: 400, message: "No matching employees found in this organization" };
    }

    const validIds = employees.map((e) => e.id);

    await prisma.employee.updateMany({
      where: { id: { in: validIds } },
      data: { departmentId: dept.id, department: dept.name },
    });

    categoryService.invalidate(organizationId);
    await this.touchPolicyVersion(organizationId);

    return { departmentId, assignedCount: validIds.length };
  }

  async removeDepartmentMember(organizationId: string, departmentId: string, employeeId: string) {
    await this.getDepartmentById(organizationId, departmentId);

    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (
      !employee ||
      employee.organizationId !== organizationId ||
      employee.departmentId !== departmentId
    ) {
      throw { statusCode: 404, message: "Employee not found in this department" };
    }

    await prisma.employee.update({
      where: { id: employeeId },
      data: { departmentId: null, department: null },
    });

    categoryService.invalidate(organizationId);
    await this.touchPolicyVersion(organizationId);

    return { employeeId, removed: true };
  }

  // -------------------------------------------------------------------------
  // Productivity categories / blacklist (Org-wide & Department-scoped)
  // -------------------------------------------------------------------------

  async listCategories(organizationId: string, departmentId?: string) {
    await this.getOrganizationById(organizationId);
    return prisma.category.findMany({
      where: {
        organizationId,
        ...(departmentId !== undefined ? { departmentId: departmentId || null } : {}),
      },
      include: {
        department: { select: { id: true, name: true } },
      },
      orderBy: [{ target: "asc" }, { pattern: "asc" }],
    });
  }

  /** Upsert on (org, departmentId, target, pattern) so re-adding an existing rule edits it. */
  async upsertCategory(organizationId: string, dto: UpsertCategoryDto) {
    await this.getOrganizationById(organizationId);
    const pattern = dto.pattern.trim().toLowerCase();
    const departmentId = dto.departmentId || null;

    if (departmentId) {
      const dept = await prisma.department.findUnique({ where: { id: departmentId } });
      if (!dept || dept.organizationId !== organizationId) {
        throw { statusCode: 404, message: "Department not found in this organization" };
      }
    }

    // Find existing rule matching target + pattern for this department/org
    const existing = await prisma.category.findFirst({
      where: {
        organizationId,
        departmentId,
        target: dto.target,
        pattern,
      },
    });

    let row;
    if (existing) {
      row = await prisma.category.update({
        where: { id: existing.id },
        data: { tag: dto.tag, isBlacklisted: dto.isBlacklisted },
      });
    } else {
      row = await prisma.category.create({
        data: {
          organizationId,
          departmentId,
          pattern,
          target: dto.target,
          tag: dto.tag,
          isBlacklisted: dto.isBlacklisted,
        },
      });
    }

    // Drop cache and bump policy version so agents and ingest immediately see the update
    categoryService.invalidate(organizationId);
    await this.touchPolicyVersion(organizationId);

    return row;
  }

  async deleteCategory(organizationId: string, categoryId: string) {
    const existing = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!existing || existing.organizationId !== organizationId) {
      throw { statusCode: 404, message: "Category not found" };
    }

    await prisma.category.delete({ where: { id: categoryId } });
    categoryService.invalidate(organizationId);
    await this.touchPolicyVersion(organizationId);

    return { id: categoryId, deleted: true };
  }

  private async touchPolicyVersion(organizationId: string) {
    await prisma.policy.upsert({
      where: { organizationId },
      create: { organizationId },
      update: { version: { increment: 1 } },
    });
  }
}

export const organizationService = new OrganizationService();
