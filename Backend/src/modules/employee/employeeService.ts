import { prisma } from '../../config/db';
import { AssignDeviceDto, CreateEmployeeDto, UpdateEmployeeDto } from './employee.dto';

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

export class EmployeeService {
  async createEmployee(dto: CreateEmployeeDto) {
    const existing = await prisma.employee.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw { statusCode: 400, message: 'Employee with this email already exists' };
    }

    return prisma.employee.create({
      data: {
        organizationId: dto.organizationId,
        name: dto.name,
        email: dto.email,
        department: dto.department || null,
      },
    });
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

  /** Device inventory (Features.md "Device Information") — the asset-management view. */
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
