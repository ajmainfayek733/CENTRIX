import { prisma } from '../../config/db';
import { categoryService } from '../report/categoryService';
import { toAgentPolicy } from '../ingest/policyService';
import { generateEnrollmentToken, hashEnrollmentToken } from '../../utils/token';
import { CreateOrganizationDto, UpdatePolicyDto, UpsertCategoryDto } from './organization.dto';

export class OrganizationService {
  /**
   * Creates the organization together with its policy row, so GET /api/v1/policy always has
   * something to read. Every policy column carries a database default matching Features.md,
   * so an empty `create` produces a complete, valid policy.
   *
   * The enrollment token is returned exactly once, here — it goes into the agent's
   * install-time config (spec §11) and only its HMAC is stored.
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
      note: 'Store this enrollment token in the agent installer config. It will not be shown again.',
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

    return { enrollmentToken, note: 'Existing device API keys are unaffected.' };
  }

  async getAllOrganizations() {
    return prisma.organization.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, createdAt: true },
    });
  }

  async getOrganizationById(id: string) {
    const org = await prisma.organization.findUnique({
      where: { id },
      select: { id: true, name: true, createdAt: true },
    });
    if (!org) {
      throw { statusCode: 404, message: 'Organization not found' };
    }
    return org;
  }

  // -------------------------------------------------------------------------
  // Policy — Features.md "Configuring Policies"
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
   * Applies a partial settings change. `version` is incremented on every write — agents use it
   * to decide whether to re-prompt for consent, so an update that left it alone would silently
   * skip that prompt.
   */
  async updatePolicy(organizationId: string, dto: UpdatePolicyDto) {
    await this.getOrganizationById(organizationId);

    const updated = await prisma.policy.upsert({
      where: { organizationId },
      create: { organizationId, ...dto },
      update: { ...dto, version: { increment: 1 } },
    });

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
      orderBy: [{ target: 'asc' }, { pattern: 'asc' }],
    });
  }

  /** Upsert on (org, target, pattern) so re-adding an existing rule edits it instead of 409ing. */
  async upsertCategory(organizationId: string, dto: UpsertCategoryDto) {
    await this.getOrganizationById(organizationId);
    const pattern = dto.pattern.trim().toLowerCase();

    const row = await prisma.category.upsert({
      where: { organizationId_target_pattern: { organizationId, target: dto.target, pattern } },
      create: { organizationId, pattern, target: dto.target, tag: dto.tag, isBlacklisted: dto.isBlacklisted },
      update: { tag: dto.tag, isBlacklisted: dto.isBlacklisted },
    });

    // Agents pull categories with the policy, and ingest re-categorizes against the cache —
    // both must see the new rule immediately, so drop the cache and bump the policy version.
    categoryService.invalidate(organizationId);
    await this.touchPolicyVersion(organizationId);

    return row;
  }

  async deleteCategory(organizationId: string, categoryId: string) {
    const existing = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!existing || existing.organizationId !== organizationId) {
      throw { statusCode: 404, message: 'Category not found' };
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
