import { Router, Request, Response, NextFunction } from 'express';
import { ingestController } from './ingestController';
import { deviceAuth } from '../../middleware/deviceAuth';
import { validate } from '../../middleware/validate';
import { rateLimiter } from '../../middleware/rateLimiter';
import { uploadScreenshotFile } from './upload';
import {
  batchSchemaFor,
  channelParamSchema,
  consentSchema,
  deviceRegisterSchema,
  screenshotFieldsSchema,
  type Channel,
} from './ingest.dto';

const router = Router();

/**
 * The batch body schema depends on which channel the request is for, so it can't be a
 * static `validate(...)`. Runs after `channelParamSchema` has proven the channel is one we
 * know about.
 */
const validateEventBatch = async (req: Request, res: Response, next: NextFunction) => {
  const channel = req.params.channel as Channel;
  const result = await batchSchemaFor(channel).safeParseAsync(req.body);

  if (!result.success) {
    return res.status(400).json({
      error: 'Validation failed',
      channel,
      details: result.error.issues.map((e) => ({ field: e.path.join('.'), message: e.message })),
    });
  }

  req.body = result.data;
  next();
};

// -- Enrollment (Features.md "Device Auth") ---------------------------------
// No device credential yet — authorized by the install-time org enrollment token instead.
// Rate limited hard because this endpoint mints credentials.

router.post(
  '/device/enroll',
  rateLimiter(10, 60 * 1000),
  validate(deviceRegisterSchema),
  ingestController.enroll
);

// -- Everything below requires the per-device API key ------------------------

router.get('/heartbeat', rateLimiter(120, 60 * 1000), deviceAuth, ingestController.heartbeat);

router.post(
  '/events/:channel',
  rateLimiter(200, 60 * 1000),
  deviceAuth,
  validate(channelParamSchema, 'params'),
  validateEventBatch,
  ingestController.pushEvents
);

router.get('/policy', rateLimiter(200, 60 * 1000), deviceAuth, ingestController.getPolicy);

router.post(
  '/screenshots',
  rateLimiter(60, 60 * 1000),
  deviceAuth,
  uploadScreenshotFile,
  validate(screenshotFieldsSchema, 'body'),
  ingestController.uploadScreenshot
);

router.post('/consent', rateLimiter(60, 60 * 1000), deviceAuth, validate(consentSchema), ingestController.recordConsent);

export default router;
