import { Router } from 'express';
import { ingestController } from '../controllers/ingestController';
import { deviceAuth } from '../middleware/deviceAuth';
import { validate } from '../middleware/validate';
import { rateLimiter } from '../middleware/rateLimiter';
import { ingestBatchSchema } from '../dtos/ingest.dto';

const router = Router();

// Write path for Windows Agents ONLY
// Protected by deviceAuth (tokenHash comparison), rate limiting, and zod schema validation
router.post(
  '/activity',
  rateLimiter(200, 60 * 1000),
  deviceAuth as any,
  validate(ingestBatchSchema),
  ingestController.ingestActivityBatch
);

export default router;
