import { Request, Response, NextFunction } from 'express';
import fs from 'fs/promises';
import { EnrollmentError, ingestService } from './ingestService';
import { DeviceAuthenticatedRequest } from '../../middleware/deviceAuth';
import { Channel } from './ingest.dto';

export class IngestController {
  /** POST /api/v1/device/enroll — Features.md "Device Auth". */
  async enroll(req: Request, res: Response, next: NextFunction) {
    try {
      const token = req.header('x-enrollment-token');
      if (!token) {
        return res.status(401).json({ error: 'Missing X-Enrollment-Token header' });
      }

      const result = await ingestService.enrollDevice(token, req.body);

      // The API key is returned exactly once, here. Only its HMAC is persisted, so a lost key
      // can only be recovered by re-enrolling.
      return res.status(result.enrolled ? 201 : 200).json({
        authenticated: true,
        apiKey: result.apiKey,
        deviceId: result.deviceId,
        employeeId: result.employeeId,
      });
    } catch (error) {
      if (error instanceof EnrollmentError) {
        return res.status(error.statusCode).json({ authenticated: false, error: error.message });
      }
      next(error);
    }
  }

  /** GET /api/v1/heartbeat — availability + authorization check before the agent starts syncing. */
  async heartbeat(req: DeviceAuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      return res.status(200).json(await ingestService.heartbeat(req.device!));
    } catch (error) {
      next(error);
    }
  }

  /** POST /api/v1/events/:channel */
  async pushEvents(req: DeviceAuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const channel = req.params.channel as Channel;
      const acknowledgedEventIds = await ingestService.pushEvents(req.device!, channel, req.body.events);
      return res.status(200).json({ acknowledgedEventIds });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/v1/policy */
  async getPolicy(req: DeviceAuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      return res.status(200).json(await ingestService.getPolicy(req.device!.organizationId));
    } catch (error) {
      next(error);
    }
  }

  /** POST /api/v1/screenshots */
  async uploadScreenshot(req: DeviceAuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const result = await ingestService.storeScreenshot(req.device!, req.body, req.file!.path);
      return res.status(200).json(result);
    } catch (error) {
      // Best-effort cleanup of the temp upload if persisting failed after multer wrote it.
      if (req.file?.path) {
        await fs.unlink(req.file.path).catch(() => undefined);
      }
      next(error);
    }
  }

  /** POST /api/v1/consent */
  async recordConsent(req: DeviceAuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      await ingestService.recordConsent(req.device!, req.body);
      return res.status(200).json({ status: 'ok' });
    } catch (error) {
      next(error);
    }
  }
}

export const ingestController = new IngestController();
