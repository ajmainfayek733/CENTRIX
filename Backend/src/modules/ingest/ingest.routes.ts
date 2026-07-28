import { Router } from 'express';
import { ingestController } from './ingestController';
import { deviceAuth } from '../../middleware/deviceAuth';
import { validate } from '../../middleware/validate';
import { rateLimiter } from '../../middleware/rateLimiter';
import { uploadScreenshotFile } from './upload';
import { channelParamSchema, consentSchema, pushEventsSchema, screenshotFieldsSchema } from './ingest.dto';

const router = Router();

// Every route below implements docs/backend-api-specification.md §4 and requires the Agent's
// device API key (spec §2.2).

router.post(
  '/events/:channel',
  rateLimiter(200, 60 * 1000),
  deviceAuth,
  validate(channelParamSchema, 'params'),
  validate(pushEventsSchema),
  ingestController.pushEvents
);

router.get(
  '/policy',
  rateLimiter(200, 60 * 1000),
  deviceAuth,
  ingestController.getPolicy
);

router.post(
  '/screenshots',
  rateLimiter(60, 60 * 1000),
  deviceAuth,
  uploadScreenshotFile,
  validate(screenshotFieldsSchema, 'body'),
  ingestController.uploadScreenshot
);

router.post(
  '/consent',
  rateLimiter(60, 60 * 1000),
  deviceAuth,
  validate(consentSchema),
  ingestController.recordConsent
);

export default router;
