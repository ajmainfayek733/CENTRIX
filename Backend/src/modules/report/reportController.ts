import { Request, Response, NextFunction } from 'express';
import path from 'path';
import { reportService } from './reportService';

/**
 * A `limit` query parameter, or undefined to let policy decide.
 *
 * Anything unparseable is treated as absent rather than as zero: `?limit=abc` should serve a
 * normal page, not an empty one, and NaN silently flowing into a take() is the kind of bug that
 * only shows up as "the table is blank sometimes".
 */
function parseLimit(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

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

  /**
   * GET /v1/dashboard/reports/employees/:employeeId/activity
   *
   * The paging endpoint behind the timeline's scroll window. `cursor` is opaque to the client -
   * it hands back whatever `nextCursor` the previous page returned.
   */
  async getActivityLog(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await reportService.getActivityLog(req.params.employeeId as string, {
        startDate: req.query.startDate as string | undefined,
        endDate: req.query.endDate as string | undefined,
        cursor: req.query.cursor as string | undefined,
        limit: parseLimit(req.query.limit),
      });
      return res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  }

  async getAlerts(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await reportService.getAlerts({
        cursor: req.query.cursor as string | undefined,
        limit: parseLimit(req.query.limit),
        includeResolved: req.query.includeResolved === 'true',
      });
      return res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  }

  async getUsbEvents(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await reportService.getUsbEvents({
        startDate: req.query.startDate as string | undefined,
        endDate: req.query.endDate as string | undefined,
        cursor: req.query.cursor as string | undefined,
        limit: parseLimit(req.query.limit),
      });
      return res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /v1/dashboard/reports/employees/:employeeId/screenshots
   *
   * Index only - the images themselves come from getScreenshotFile, one audited request each.
   */
  async getScreenshots(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await reportService.getScreenshots(req.params.employeeId as string, {
        startDate: req.query.startDate as string | undefined,
        endDate: req.query.endDate as string | undefined,
        cursor: req.query.cursor as string | undefined,
        limit: parseLimit(req.query.limit),
      });
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
