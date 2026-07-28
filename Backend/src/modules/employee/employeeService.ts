import { prisma } from '../../config/db';
import { CreateEmployeeDto, RegisterDeviceDto } from './employee.dto';
import { generateDeviceApiKey, hashDeviceApiKey } from '../../utils/token';

const DEVICE_SELECT = {
  id: true,
  machineId: true,
  hostname: true,
  os: true,
  agentVersion: true,
  isActive: true,
  lastSeenAt: true,
} as const;

export class EmployeeService {
  async createEmployee(dto: CreateEmployeeDto) {
    const existing = await prisma.employee.findUnique({
      where: { email: dto.email },
    });

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

  async getAllEmployees() {
    return prisma.employee.findMany({
      include: { devices: { select: DEVICE_SELECT } },
      orderBy: { createdAt: 'desc' },
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

  /**
   * Register a new device (Agent enrollment target — spec §2.2 option 1) and return the
   * unhashed device API key once. It is never recoverable after this response.
   */
  async registerDevice(dto: RegisterDeviceDto) {
    const employee = await prisma.employee.findUnique({
      where: { id: dto.employeeId },
    });

    if (!employee) {
      throw { statusCode: 404, message: 'Target employee not found' };
    }

    const existingDevice = await prisma.device.findUnique({ where: { machineId: dto.machineId } });
    if (existingDevice) {
      throw { statusCode: 400, message: 'A device with this machineId is already registered' };
    }

    const rawApiKey = generateDeviceApiKey();
    const apiKeyHash = hashDeviceApiKey(rawApiKey);

    const device = await prisma.device.create({
      data: {
        organizationId: employee.organizationId,
        employeeId: dto.employeeId,
        machineId: dto.machineId,
        hostname: dto.hostname,
        os: dto.os,
        agentVersion: dto.agentVersion || null,
        apiKeyHash,
      },
    });

    return {
      deviceId: device.id,
      employeeId: device.employeeId,
      organizationId: device.organizationId,
      machineId: device.machineId,
      hostname: device.hostname,
      rawApiKey,
      note: 'Save this device API key securely (e.g. via DPAPI on the device). It will not be shown again.',
    };
  }

  /** Admin-controlled kill switch (Rules.md "Admin is in control") — deactivating returns 403 to that device per spec §2.3. */
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
