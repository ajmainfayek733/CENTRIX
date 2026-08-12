import { Router, Request, Response, NextFunction } from 'express';
import { ingestController } from './ingestController';
import { deviceAuth } from '../../middleware/deviceAuth';
import { validate } from '../../middleware/validate';
import { rateLimiter, keyByDevice, keyByEnrollingDevice } from '../../middleware/rateLimiter';
import { env } from '../../config/env';
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

const MINUTE = 60 * 1000;

/**
 * Per-IP backstop, applied before authentication so an unauthenticated flood cannot force a
 * credential lookup per request. Deliberately generous: an entire office can share one source
 * address, so this must never be the limit a healthy fleet runs into. The per-device limits
 * below are the ones that actually shape agent behaviour.
 */
const unauthenticatedBackstop = rateLimiter({
  max: env.RATE_LIMIT_UNAUTHENTICATED_PER_MIN,
  windowMs: MINUTE,
  name: 'agent',
});

/** Per authenticated device. Must run after deviceAuth, which is what proves the key. */
const perDevice = (max: number, name: string) =>
  rateLimiter({ max, windowMs: MINUTE, key: keyByDevice, name });

router.use(unauthenticatedBackstop);

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
// No device credential yet - authorized by the install-time org enrollment token instead.
// Rate limited hard because this endpoint mints credentials, but keyed on the MachineGuid in
// the body rather than the source IP: capping *distinct machines joining per minute* would
// throttle a whole fleet rolling out from behind one NAT, which is the opposite of the intent.
// A hundred workstations enrolling at once are a hundred keys with a budget each.

router.post(
  '/device/enroll',
  rateLimiter({
    max: env.RATE_LIMIT_ENROLL_PER_MIN,
    windowMs: MINUTE,
    key: keyByEnrollingDevice,
    name: 'enrollment',
  }),
  validate(deviceRegisterSchema),
  ingestController.enroll
);

// -- Everything below requires the per-device API key ------------------------
// deviceAuth runs *before* the per-device limiter, because the limiter keys on the device it
// resolves. The unauthenticated backstop above already covers the pre-auth surface.

router.get('/heartbeat', deviceAuth, perDevice(120, 'heartbeat'), ingestController.heartbeat);

router.post(
  '/events/:channel',
  deviceAuth,
  perDevice(env.RATE_LIMIT_INGEST_PER_MIN, 'ingest'),
  validate(channelParamSchema, 'params'),
  validateEventBatch,
  ingestController.pushEvents
);

router.get('/policy', deviceAuth, perDevice(env.RATE_LIMIT_INGEST_PER_MIN, 'policy'), ingestController.getPolicy);

router.post(
  '/screenshots',
  deviceAuth,
  perDevice(env.RATE_LIMIT_SCREENSHOT_PER_MIN, 'screenshot'),
  uploadScreenshotFile,
  validate(screenshotFieldsSchema, 'body'),
  ingestController.uploadScreenshot
);

router.post('/consent', deviceAuth, perDevice(60, 'consent'), validate(consentSchema), ingestController.recordConsent);

export default router;
