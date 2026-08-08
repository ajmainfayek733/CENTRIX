import { Request, Response, NextFunction } from 'express';
import { employeeService } from './employeeService';

export class EmployeeController {
  async createEmployee(req: Request, res: Response, next: NextFunction) {
    try {
      const employee = await employeeService.createEmployee(req.body);
      return res.status(201).json({
        message: 'Employee created successfully',
        data: employee,
      });
    } catch (error) {
      next(error);
    }
  }

  async getAllEmployees(req: Request, res: Response, next: NextFunction) {
    try {
      const employees = await employeeService.getAllEmployees();
      return res.status(200).json({ data: employees });
    } catch (error) {
      next(error);
    }
  }

  async getEmployeeById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const employee = await employeeService.getEmployeeById(id);
      return res.status(200).json({ data: employee });
    } catch (error) {
      next(error);
    }
  }

  async updateEmployee(req: Request, res: Response, next: NextFunction) {
    try {
      const employee = await employeeService.updateEmployee(req.params.id as string, req.body);
      return res.status(200).json({ message: 'Employee updated successfully', data: employee });
    } catch (error) {
      next(error);
    }
  }

  async listDevices(req: Request, res: Response, next: NextFunction) {
    try {
      return res.status(200).json({ data: await employeeService.listDevices() });
    } catch (error) {
      next(error);
    }
  }

  async assignDevice(req: Request, res: Response, next: NextFunction) {
    try {
      const device = await employeeService.assignDevice(req.params.deviceId as string, req.body);
      return res.status(200).json({ message: 'Device assigned successfully', data: device });
    } catch (error) {
      next(error);
    }
  }

  async setDeviceActive(req: Request, res: Response, next: NextFunction) {
    try {
      const device = await employeeService.setDeviceActive(req.params.deviceId as string, req.body.isActive);
      return res.status(200).json({
        message: `Device ${device.isActive ? 'reactivated' : 'deactivated'} successfully`,
        data: device,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const employeeController = new EmployeeController();
