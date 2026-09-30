import { Request, Response, NextFunction } from "express";
import path from "path";
import { reportService } from "./reportService";
import { getScreenshot } from "../ingest/screenshotStorage";

/**
 * A `limit` query parameter, or undefined to let policy decide.
 *
 * Anything unparseable is treated as absent rather than as zero: `?limit=abc` should serve a
 * normal page, not an empty one, and NaN silently flowing into a take() is the kind of bug that
 * only shows up as "the table is blank sometimes".
 */
function parseLimit(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
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

  async getTeamAttendance(_req: Request, res: Response, next: NextFunction) {
    try {
      const data = await reportService.getTeamAttendance();
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
        endDate as string,
      );
      return res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /v1/dashboard/reports/employees/:employeeId/pdf
   *
   * Streams a formatted PDF report for the employee over the given date range.
   */
  async getEmployeePdfReport(req: Request, res: Response, next: NextFunction) {
    try {
      const { startDate, endDate } = req.query;
      const data = await reportService.getEmployeeDetail(
        req.params.employeeId as string,
        startDate as string,
        endDate as string,
      );

      const sanitizedName = data.employee.name.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
      const dateTag = (startDate as string) || new Date().toISOString().slice(0, 10);
      const filename = `report_${sanitizedName}_${dateTag}.pdf`;

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

      const { generateEmployeeReportPdf } = await import("./pdfReportService");
      const pdfStream = generateEmployeeReportPdf(data as any);
      pdfStream.pipe(res);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /v1/dashboard/reports/departments/:departmentId
   */
  async getDepartmentDetail(req: Request, res: Response, next: NextFunction) {
    try {
      const { startDate, endDate } = req.query;
      const data = await reportService.getDepartmentDetail(
        req.params.departmentId as string,
        startDate as string | undefined,
        endDate as string | undefined,
      );
      return res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /v1/dashboard/reports/departments/:departmentId/pdf
   */
  async getDepartmentPdfReport(req: Request, res: Response, next: NextFunction) {
    try {
      const { startDate, endDate } = req.query;
      const data = await reportService.getDepartmentDetail(
        req.params.departmentId as string,
        startDate as string | undefined,
        endDate as string | undefined,
      );

      const sanitizedName = data.department.name.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
      const dateTag = (startDate as string) || new Date().toISOString().slice(0, 10);
      const filename = `department_performance_${sanitizedName}_${dateTag}.pdf`;

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

      const { generateDepartmentReportPdf } = await import("./pdfReportService");
      const pdfStream = generateDepartmentReportPdf(data as any);
      pdfStream.pipe(res);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /v1/dashboard/reports/departments/:departmentId/batch-zip
   */
  async getDepartmentBatchZipReport(req: Request, res: Response, next: NextFunction) {
    try {
      const { startDate, endDate } = req.query;
      const { generateDepartmentBatchZipBuffer } = await import("./pdfReportService");
      const zipBuffer = await generateDepartmentBatchZipBuffer(
        req.params.departmentId as string,
        startDate as string | undefined,
        endDate as string | undefined,
      );

      const dateTag = (startDate as string) || new Date().toISOString().slice(0, 10);
      const filename = `department_bundle_${req.params.departmentId.slice(0, 8)}_${dateTag}.zip`;

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", zipBuffer.length.toString());
      res.send(zipBuffer);
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
        includeResolved: req.query.includeResolved === "true",
      });
      return res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  }

  async getAlertCount(req: Request, res: Response, next: NextFunction) {
    try {
      const rawSince = req.query.since;
      let since: Date | undefined;

      if (typeof rawSince === "string" && rawSince) {
        since = new Date(rawSince);
        if (Number.isNaN(since.getTime())) {
          return res.status(400).json({ error: "since must be an ISO 8601 timestamp" });
        }
      }

      const data = await reportService.getAlertCount(since);
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
   * GET /v1/dashboard/reports/employees/:employeeId/usb-events
   *
   * The same trail as above, narrowed to one person's machines. A separate route rather than a
   * query parameter on the org-wide feed, so the audit log records *whose* removable-device
   * history was read - "someone listed USB events" and "someone read this employee's USB
   * history" are different acts, and only the second is answerable from the route.
   */
  async getEmployeeUsbEvents(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await reportService.getUsbEvents({
        employeeId: req.params.employeeId as string,
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
      const clientEventId = path.basename(req.params.file as string, ".jpg");
      const storagePath = await reportService.getScreenshotPath(deviceId, clientEventId);
      const screenshot = await getScreenshot(deviceId, storagePath);
      res.type(screenshot.contentType);
      if (screenshot.contentLength !== undefined)
        res.setHeader("Content-Length", screenshot.contentLength);
      screenshot.body.once("error", next);
      screenshot.body.pipe(res);
      return;
    } catch (error) {
      next(error);
    }
  }
}

export const reportController = new ReportController();
