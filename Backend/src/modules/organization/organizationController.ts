import { Request, Response, NextFunction } from 'express';
import { organizationService } from './organizationService';

export class OrganizationController {
  async createOrganization(req: Request, res: Response, next: NextFunction) {
    try {
      const org = await organizationService.createOrganization(req.body);
      return res.status(201).json({ message: 'Organization created successfully', data: org });
    } catch (error) {
      next(error);
    }
  }

  async getAllOrganizations(req: Request, res: Response, next: NextFunction) {
    try {
      const orgs = await organizationService.getAllOrganizations();
      return res.status(200).json({ data: orgs });
    } catch (error) {
      next(error);
    }
  }

  async getOrganizationById(req: Request, res: Response, next: NextFunction) {
    try {
      const org = await organizationService.getOrganizationById(req.params.id as string);
      return res.status(200).json({ data: org });
    } catch (error) {
      next(error);
    }
  }
}

export const organizationController = new OrganizationController();
