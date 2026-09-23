import { Request, Response, NextFunction } from "express";
import { organizationService } from "./organizationService";

export class OrganizationController {
  async createOrganization(req: Request, res: Response, next: NextFunction) {
    try {
      const org = await organizationService.createOrganization(req.body);
      return res.status(201).json({ message: "Organization created successfully", data: org });
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

  async rotateEnrollmentToken(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await organizationService.rotateEnrollmentToken(req.params.id as string);
      return res.status(200).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  async getPolicy(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await organizationService.getPolicy(req.params.id as string);
      return res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  }

  async updatePolicy(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await organizationService.updatePolicy(req.params.id as string, req.body);
      return res.status(200).json({ message: "Policy updated", data });
    } catch (error) {
      next(error);
    }
  }

  // -------------------------------------------------------------------------
  // Departments
  // -------------------------------------------------------------------------

  async listDepartments(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await organizationService.listDepartments(req.params.id as string);
      return res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  }

  async getDepartmentById(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await organizationService.getDepartmentById(
        req.params.id as string,
        req.params.deptId as string,
      );
      return res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  }

  async createDepartment(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await organizationService.createDepartment(req.params.id as string, req.body);
      return res.status(201).json({ message: "Department created", data });
    } catch (error) {
      next(error);
    }
  }

  async updateDepartment(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await organizationService.updateDepartment(
        req.params.id as string,
        req.params.deptId as string,
        req.body,
      );
      return res.status(200).json({ message: "Department updated", data });
    } catch (error) {
      next(error);
    }
  }

  async deleteDepartment(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await organizationService.deleteDepartment(
        req.params.id as string,
        req.params.deptId as string,
      );
      return res.status(200).json({ message: "Department deleted", data });
    } catch (error) {
      next(error);
    }
  }

  async addDepartmentMembers(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await organizationService.addDepartmentMembers(
        req.params.id as string,
        req.params.deptId as string,
        req.body,
      );
      return res.status(200).json({ message: "Department members assigned", data });
    } catch (error) {
      next(error);
    }
  }

  async removeDepartmentMember(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await organizationService.removeDepartmentMember(
        req.params.id as string,
        req.params.deptId as string,
        req.params.employeeId as string,
      );
      return res.status(200).json({ message: "Member removed from department", data });
    } catch (error) {
      next(error);
    }
  }

  // -------------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------------

  async listCategories(req: Request, res: Response, next: NextFunction) {
    try {
      const departmentId =
        (req.params.deptId as string | undefined) ||
        (req.query.departmentId as string | undefined);
      const data = await organizationService.listCategories(req.params.id as string, departmentId);
      return res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  }

  async upsertCategory(req: Request, res: Response, next: NextFunction) {
    try {
      if (req.params.deptId && !req.body.departmentId) {
        req.body.departmentId = req.params.deptId;
      }
      const data = await organizationService.upsertCategory(req.params.id as string, req.body);
      return res.status(200).json({ message: "Category rule saved", data });
    } catch (error) {
      next(error);
    }
  }

  async deleteCategory(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await organizationService.deleteCategory(
        req.params.id as string,
        req.params.categoryId as string,
      );
      return res.status(200).json({ message: "Category rule deleted", data });
    } catch (error) {
      next(error);
    }
  }
}

export const organizationController = new OrganizationController();
