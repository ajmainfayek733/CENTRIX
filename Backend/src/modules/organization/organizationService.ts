import { prisma } from '../../config/db';
import { DEFAULT_POLICY_DOCUMENT } from '../ingest/defaultPolicy';
import { CreateOrganizationDto } from './organization.dto';

export class OrganizationService {
  /** Every organization gets a default policy at creation so GET /api/v1/policy always has a row to read (spec §4.2). */
  async createOrganization(dto: CreateOrganizationDto) {
    return prisma.organization.create({
      data: {
        name: dto.name,
        policy: { create: { version: 1, document: DEFAULT_POLICY_DOCUMENT } },
      },
    });
  }

  async getAllOrganizations() {
    return prisma.organization.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async getOrganizationById(id: string) {
    const org = await prisma.organization.findUnique({ where: { id } });
    if (!org) {
      throw { statusCode: 404, message: 'Organization not found' };
    }
    return org;
  }
}

export const organizationService = new OrganizationService();
