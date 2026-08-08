import { Request, Response, NextFunction } from 'express';
import path from 'path';
import { reportService } from './reportService';

export class ReportController {
  async getOverview(req: Request, res: Response, next: NextFunction) {
    try {
      const { startDate, endDate } = req.query;
      const data = await reportService.getOverview(startDate as string, endDate as string);
      return res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  }

  async getEmployeeRoster(req: Request, res: Response, next: NextFunction) {
    try {
      const { startDate, endDate } = req.query;
      const data = await reportService.getEmployeeRoster(startDate as string, endDate as string);
      return res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  }

  async getEmployeeDetail(req: Request, res: Response, next: NextFunction) {
    try {
      const { startDate, endDate } = req.query;
      const data = await reportService.getEmployeeDetail(
        req.params.employeeId as string,
        startDate as string,
        endDate as string
      );
      return res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  }

  async getAlerts(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 100;
      const includeResolved = req.query.includeResolved === 'true';
      const data = await reportService.getAlerts(limit, includeResolved);
      return res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  }

  async getUsbEvents(req: Request, res: Response, next: NextFunction) {
    try {
      const { startDate, endDate } = req.query;
      const data = await reportService.getUsbEvents(startDate as string, endDate as string);
      return res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  }

  async getScreenshots(req: Request, res: Response, next: NextFunction) {
    try {
      const { startDate, endDate } = req.query;
      const data = await reportService.getScreenshots(
        req.params.employeeId as string,
        startDate as string,
        endDate as string
      );
      return res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  }

  /** Serves the stored image itself. Every hit is written to the audit log by the route. */
  async getScreenshotFile(req: Request, res: Response, next: NextFunction) {
    try {
      const deviceId = req.params.deviceId as string;
      const clientEventId = path.basename(req.params.file as string, '.jpg');
      const storagePath = await reportService.getScreenshotPath(deviceId, clientEventId);
      return res.sendFile(path.resolve(storagePath));
    } catch (error) {
      next(error);
    }
  }
}

export const reportController = new ReportController();
