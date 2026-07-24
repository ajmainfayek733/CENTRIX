import { prisma } from '../../config/db';
import { CreateEmployeeDto, RegisterDeviceDto } from './employee.dto';
import { generateDeviceToken, hashDeviceToken } from '../../utils/token';

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
        name: dto.name,
        email: dto.email,
        department: dto.department || null,
      },
    });
  }

  async getAllEmployees() {
    return prisma.employee.findMany({
      include: {
        devices: {
          select: {
            id: true,
            hostname: true,
            os: true,
            agentVersion: true,
            lastSeen: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getEmployeeById(id: string) {
    const employee = await prisma.employee.findUnique({
      where: { id },
      include: {
        devices: {
          select: {
            id: true,
            hostname: true,
            os: true,
            agentVersion: true,
            lastSeen: true,
          },
        },
      },
    });

    if (!employee) {
      throw { statusCode: 404, message: 'Employee not found' };
    }

    return employee;
  }

  /**
   * Register a new device for an employee and return the unhashed device token once.
   */
  async registerDevice(dto: RegisterDeviceDto) {
    const employee = await prisma.employee.findUnique({
      where: { id: dto.employeeId },
    });

    if (!employee) {
      throw { statusCode: 404, message: 'Target employee not found' };
    }

    const rawToken = generateDeviceToken();
    const tokenHash = hashDeviceToken(rawToken);

    const device = await prisma.device.create({
      data: {
        employeeId: dto.employeeId,
        hostname: dto.hostname,
        os: dto.os,
        agentVersion: dto.agentVersion,
        tokenHash,
      },
    });

    return {
      deviceId: device.id,
      employeeId: device.employeeId,
      hostname: device.hostname,
      rawDeviceToken: rawToken, // Displayed ONLY once upon registration
      note: 'Save this device token securely. It will not be shown again.',
    };
  }
}

export const employeeService = new EmployeeService();
