import { prisma } from '../../config/db';
import { AssignDeviceDto, BulkCreateEmployeesDto, CreateEmployeeDto, UpdateEmployeeDto } from './employee.dto';

const DEVICE_SELECT = {
  id: true,
  deviceId: true,
  deviceName: true,
  systemType: true,
  edition: true,
  version: true,
  macAddress: true,
  agentVersion: true,
  isActive: true,
  lastSeen: true,
} as const;

interface BulkRowResult {
  email: string;
  status: 'created' | 'skipped';
  reason?: string;
  warning?: string;
}

interface DepartmentRef {
  id: string;
  name: string;
}

interface DepartmentResolution {
  department: DepartmentRef | null;
  /** Set when a department was requested but could not be matched. */
  warning?: string;
}

/**
 * Resolves requested departments against the organization's real ones. Loaded once per request,
 * so a 1000-row import costs one query rather than one per row.
 */
class DepartmentResolver {
  private readonly byId = new Map<string, DepartmentRef>();
  private readonly byName = new Map<string, DepartmentRef>();

  constructor(departments: DepartmentRef[]) {
    for (const d of departments) {
      this.byId.set(d.id, d);
      this.byName.set(d.name.trim().toLowerCase(), d);
    }
  }

  resolve(row: { departmentId?: string | null; department?: string }): DepartmentResolution {
    if (row.departmentId) {
      const found = this.byId.get(row.departmentId);
      return found
        ? { department: found }
        : { department: null, warning: 'Department not found in this organization; left unassigned' };
    }

    const name = row.department?.trim();
    if (name) {
      const found = this.byName.get(name.toLowerCase());
      return found
        ? { department: found }
        : { department: null, warning: `Department '${name}' does not exist; left unassigned` };
    }

    return { department: null };
  }
}

export class EmployeeService {
  private async loadResolver(organizationId: string): Promise<DepartmentResolver> {
    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!organization) {
      throw { statusCode: 404, message: 'Organization not found' };
    }

    const departments = await prisma.department.findMany({
      where: { organizationId },
      select: { id: true, name: true },
    });
    return new DepartmentResolver(departments);
  }

  async createEmployee(dto: CreateEmployeeDto) {
    const email = dto.email.trim().toLowerCase();
    const resolver = await this.loadResolver(dto.organizationId);

    const existing = await prisma.employee.findUnique({ where: { email } });
    if (existing) {
      throw { statusCode: 400, message: 'Employee with this email already exists' };
    }

    const { department } = resolver.resolve(dto);

    return prisma.employee.create({
      data: {
        organizationId: dto.organizationId,
        name: dto.name.trim(),
        email,
        departmentId: department?.id ?? null,
        // The string column mirrors the department name, as addDepartmentMembers keeps it.
        department: department?.name ?? null,
      },
    });
  }

  /**
   * Imports a roster in one request.
   *
   * Partial success on purpose: a spreadsheet exported from HR will have a duplicate or a typo
   * in it, and failing the whole import for one bad row means the admin fixes one line and
   * re-uploads all hundred. Every row gets its own outcome, so the caller can show exactly what
   * landed and what needs attention.
   *
   * `skipDuplicates` makes re-running an import safe - the common case is adding ten new hires
   * to a file that already contains ninety existing people.
   */
  async bulkCreateEmployees(dto: BulkCreateEmployeesDto) {
    const resolver = await this.loadResolver(dto.organizationId);

    // Normalizing here rather than in the schema keeps the reported `email` identical to what
    // the admin submitted, so they can find the offending line in their source file.
    const normalized = dto.employees.map((e) => ({ ...e, normalizedEmail: e.email.trim().toLowerCase() }));

    const alreadyPresent = new Set(
      (
        await prisma.employee.findMany({
          where: { email: { in: normalized.map((e) => e.normalizedEmail) } },
          select: { email: true },
        })
      ).map((e) => e.email)
    );

    // Decide every row's outcome in one pass, then insert exactly the rows marked created. A
    // duplicate *within* the payload is invisible to the database's unique constraint until one
    // of the pair is inserted, so `claimed` catches it here instead.
    const claimed = new Set<string>();
    const resolved = normalized.map((e) => resolver.resolve(e));

    const results: BulkRowResult[] = normalized.map((e, i) => {
      if (alreadyPresent.has(e.normalizedEmail)) {
        return { email: e.email, status: 'skipped', reason: 'Employee already exists' };
      }
      if (claimed.has(e.normalizedEmail)) {
        return { email: e.email, status: 'skipped', reason: 'Duplicate row in the import' };
      }

      claimed.add(e.normalizedEmail);
      return {
        email: e.email,
        status: 'created',
        ...(resolved[i].warning ? { warning: resolved[i].warning } : {}),
      };
    });

    const toCreate = normalized
      .map((row, i) => ({ row, department: resolved[i].department }))
      .filter((_, i) => results[i].status === 'created');

    if (toCreate.length > 0) {
      // skipDuplicates covers the narrow race where a concurrent import inserts the same address
      // between the read above and this write. That row is reported as created when it was in
      // fact skipped, which is a better outcome than failing the whole import.
      await prisma.employee.createMany({
        data: toCreate.map(({ row, department }) => ({
          organizationId: dto.organizationId,
          name: row.name.trim(),
          email: row.normalizedEmail,
          departmentId: department?.id ?? null,
          // The string column mirrors the department name, as addDepartmentMembers keeps it.
          department: department?.name ?? null,
        })),
        skipDuplicates: true,
      });
    }

    return {
      submitted: normalized.length,
      created: toCreate.length,
      skipped: results.length - toCreate.length,
      unassigned: toCreate.filter((r) => r.department === null).length,
      results,
    };
  }

  async updateEmployee(id: string, dto: UpdateEmployeeDto) {
    await this.getEmployeeById(id);
    return prisma.employee.update({ where: { id }, data: dto });
  }

  /** The placeholder employee that self-enrolled devices park on is an implementation detail. */
  async getAllEmployees() {
    return prisma.employee.findMany({
      where: { status: { not: 'placeholder' } },
      include: { devices: { select: DEVICE_SELECT } },
      orderBy: { name: 'asc' },
    });
  }

  async getEmployeeById(id: string) {
    const employee = await prisma.employee.findUnique({
      where: { id },
      include: { devices: { select: DEVICE_SELECT } },
    });

    if (!employee) {
      throw { statusCode: 404, message: 'Employee not found' };
    }

    return employee;
  }

  /** Device inventory (Features.md "Device Information") - the asset-management view. */
  async listDevices() {
    return prisma.device.findMany({
      orderBy: [{ isActive: 'desc' }, { lastSeen: 'desc' }],
      select: {
        ...DEVICE_SELECT,
        createdAt: true,
        employee: { select: { id: true, name: true, status: true } },
      },
    });
  }

  /** Attach a self-enrolled device to a real employee. */
  async assignDevice(deviceId: string, dto: AssignDeviceDto) {
    const [device, employee] = await Promise.all([
      prisma.device.findUnique({ where: { id: deviceId } }),
      prisma.employee.findUnique({ where: { id: dto.employeeId } }),
    ]);

    if (!device) throw { statusCode: 404, message: 'Device not found' };
    if (!employee) throw { statusCode: 404, message: 'Target employee not found' };
    if (employee.organizationId !== device.organizationId) {
      throw { statusCode: 400, message: 'Device and employee belong to different organizations' };
    }

    return prisma.device.update({
      where: { id: deviceId },
      data: { employeeId: dto.employeeId },
      select: { ...DEVICE_SELECT, employee: { select: { id: true, name: true } } },
    });
  }

  /**
   * Admin kill switch. A deactivated device gets 403 on every telemetry route (see
   * deviceAuth), which the agent treats as "stop syncing" rather than "retry".
   */
  async setDeviceActive(deviceId: string, isActive: boolean) {
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) {
      throw { statusCode: 404, message: 'Device not found' };
    }

    return prisma.device.update({
      where: { id: deviceId },
      data: { isActive },
      select: DEVICE_SELECT,
    });
  }
}

export const employeeService = new EmployeeService();
