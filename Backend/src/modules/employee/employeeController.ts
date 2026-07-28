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

  async registerDevice(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await employeeService.registerDevice(req.body);
      return res.status(201).json({
        message: 'Device registered successfully',
        data: result,
      });
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
