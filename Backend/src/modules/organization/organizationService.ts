import { prisma } from "../../config/db";
import { categoryService } from "../report/categoryService";
import { toAgentPolicy } from "../ingest/policyService";
import { generateEnrollmentToken, hashEnrollmentToken } from "../../utils/token";
import { broadcastPolicyUpdated } from "../../realtime";
import { CreateOrganizationDto, UpdatePolicyDto, UpsertCategoryDto } from "./organization.dto";

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
      prisma.category.findMany({
        where: { organizationId },
        select: { pattern: true, target: true, tag: true, isBlacklisted: true },
      }),
    ]);
    return toAgentPolicy(policy, categories);
  }

  /**
   * Applies a partial settings change. `version` is incremented on every write - agents use it
   * to decide whether to re-prompt for consent, so an update that left it alone would silently
   * skip that prompt.
   */
  async updatePolicy(organizationId: string, dto: UpdatePolicyDto) {
    await this.getOrganizationById(organizationId);

    if (
      dto.browserSummaryScheduleTimeLocal ||
      dto.workingHoursStartLocal ||
      dto.workingHoursEndLocal
    ) {
      const current = await prisma.policy.findUnique({
        where: { organizationId },
        select: {
          workingHoursStartLocal: true,
          workingHoursEndLocal: true,
          browserSummaryScheduleTimeLocal: true,
        },
      });
      const start =
        dto.workingHoursStartLocal ??
        current?.workingHoursStartLocal ??
        DEFAULT_WORKING_HOURS_START;
      const end =
        dto.workingHoursEndLocal ?? current?.workingHoursEndLocal ?? DEFAULT_WORKING_HOURS_END;
      const schedule =
        dto.browserSummaryScheduleTimeLocal ?? current?.browserSummaryScheduleTimeLocal ?? "23:00";
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

    // Push the version bump to every connected agent instead of leaving them to discover it on
    // the next heartbeat. Agents still poll - this only shortens the window, it does not replace
    // it, because an agent that was offline for the broadcast must still converge on its own.
    broadcastPolicyUpdated(organizationId, updated.version);

    const categories = await prisma.category.findMany({
      where: { organizationId },
      select: { pattern: true, target: true, tag: true, isBlacklisted: true },
    });

    return toAgentPolicy(updated, categories);
  }

  // -------------------------------------------------------------------------
  // Productivity categories / blacklist
  // -------------------------------------------------------------------------

  async listCategories(organizationId: string) {
    await this.getOrganizationById(organizationId);
    return prisma.category.findMany({
      where: { organizationId },
      orderBy: [{ target: "asc" }, { pattern: "asc" }],
    });
  }

  /** Upsert on (org, target, pattern) so re-adding an existing rule edits it instead of 409ing. */
  async upsertCategory(organizationId: string, dto: UpsertCategoryDto) {
    await this.getOrganizationById(organizationId);
    const pattern = dto.pattern.trim().toLowerCase();

    const row = await prisma.category.upsert({
      where: { organizationId_target_pattern: { organizationId, target: dto.target, pattern } },
      create: {
        organizationId,
        pattern,
        target: dto.target,
        tag: dto.tag,
        isBlacklisted: dto.isBlacklisted,
      },
      update: { tag: dto.tag, isBlacklisted: dto.isBlacklisted },
    });

    // Agents pull categories with the policy, and ingest re-categorizes against the cache -
    // both must see the new rule immediately, so drop the cache and bump the policy version.
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
