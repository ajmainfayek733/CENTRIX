import { Request, Response, NextFunction } from 'express';
import { reportService } from './reportService';

export class ReportController {
  async getTeamSummary(req: Request, res: Response, next: NextFunction) {
    try {
      const { startDate, endDate } = req.query;
      const summary = await reportService.getTeamSummary(startDate as string, endDate as string);
      return res.status(200).json({ data: summary });
    } catch (error) {
      next(error);
    }
  }

  async getEmployeeTimeline(req: Request, res: Response, next: NextFunction) {
    try {
      const employeeId = req.params.employeeId as string;
      const { date } = req.query;
      const timeline = await reportService.getEmployeeTimeline(employeeId, date as string);
      return res.status(200).json({ data: timeline });
    } catch (error) {
      next(error);
    }
  }
}

export const reportController = new ReportController();
