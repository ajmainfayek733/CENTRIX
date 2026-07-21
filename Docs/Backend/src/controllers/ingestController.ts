import { Response, NextFunction } from 'express';
import { ingestService } from '../services/ingestService';
import { DeviceAuthenticatedRequest } from '../middleware/deviceAuth';

export class IngestController {
  async ingestActivityBatch(req: DeviceAuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.device) {
        return res.status(401).json({ error: 'Device context missing' });
      }

      const idempotencyKey = (req.headers['idempotency-key'] as string) || (req.headers['x-idempotency-key'] as string);

      if (!idempotencyKey) {
        return res.status(400).json({ error: 'Idempotency-Key header is required' });
      }

      const { samples } = req.body;
      const result = await ingestService.ingestBatch(req.device.id, idempotencyKey, samples);

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const ingestController = new IngestController();
