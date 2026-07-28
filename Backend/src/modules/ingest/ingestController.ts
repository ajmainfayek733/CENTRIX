import { Response, NextFunction } from 'express';
import fs from 'fs/promises';
import { ingestService } from './ingestService';
import { DeviceAuthenticatedRequest } from '../../middleware/deviceAuth';
import { Channel } from './ingest.dto';

export class IngestController {
  /** POST /api/v1/events/{channel} — spec §4.1 */
  async pushEvents(req: DeviceAuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const channel = req.params.channel as Channel;
      const acknowledgedEventIds = await ingestService.pushEvents(req.device!, channel, req.body.events);
      return res.status(200).json({ acknowledgedEventIds });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/v1/policy — spec §4.2 */
  async getPolicy(req: DeviceAuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const policy = await ingestService.getPolicy(req.device!.organizationId);
      return res.status(200).json(policy);
    } catch (error) {
      next(error);
    }
  }

  /** POST /api/v1/screenshots — spec §4.3 / §6 */
  async uploadScreenshot(req: DeviceAuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { clientEventId, capturedAtUtc } = req.body;
      const result = await ingestService.storeScreenshot(req.device!, { clientEventId, capturedAtUtc }, req.file!.path);
      return res.status(200).json({ remoteUri: result.remoteUri });
    } catch (error) {
      // Best-effort cleanup of the temp upload if persisting failed after multer wrote it.
      if (req.file?.path) {
        await fs.unlink(req.file.path).catch(() => undefined);
      }
      next(error);
    }
  }

  /** POST /api/v1/consent — spec §8 */
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
