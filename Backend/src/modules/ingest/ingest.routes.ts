import { Router } from 'express';
import { ingestController } from './ingestController';
import { deviceAuth } from '../../middleware/deviceAuth';
import { validate } from '../../middleware/validate';
import { rateLimiter } from '../../middleware/rateLimiter';
import { ingestBatchSchema, agentIngestSchema } from './ingest.dto';

const router = Router();

// Write path for Windows Agents ONLY (Legacy Endpoint)
router.post(
  '/activity',
  rateLimiter(200, 60 * 1000),
  deviceAuth as any,
  validate(ingestBatchSchema),
  ingestController.ingestActivityBatch
);

// Agent API config endpoint: GET /config (mapped to /api/v1/config)
router.get(
  '/config',
  rateLimiter(200, 60 * 1000),
  deviceAuth as any,
  ingestController.getAgentConfig
);

// Agent API ingest endpoint: POST /ingest (mapped to /api/v1/ingest)
router.post(
  '/ingest',
  rateLimiter(200, 60 * 1000),
  deviceAuth as any,
  validate(agentIngestSchema),
  ingestController.ingestAgentBatch
);

export default router;
