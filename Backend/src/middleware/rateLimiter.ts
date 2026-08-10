import { Request, Response, NextFunction } from 'express';
import type { DeviceAuthenticatedRequest } from './deviceAuth';

/**
 * Fixed-window rate limiting.
 *
 * Two things about the previous version made it wrong for a fleet:
 *
 * 1. It read `x-forwarded-for` unconditionally. That header is client-supplied, so any caller
 *    could rotate it and bypass the limit entirely. Now the app sets Express's `trust proxy`
 *    from TRUST_PROXY and this reads `req.ip`, which is only derived from the header when a
 *    proxy is actually configured.
 *
 * 2. It keyed everything on IP. Thirty to a hundred workstations behind one office NAT share a
 *    single source address, so a per-IP limit throttles the whole fleet collectively — the
 *    enrollment route allowed 10/minute *for the entire company*. Callers now choose the key,
 *    so the limit applies per device where that is the fair unit.
 *
 * Scope: counters live in this process's memory. That is correct for a single instance and for
 * the load this backend targets. Run more than one replica and each enforces its own budget
 * independently, so the effective limit multiplies by the replica count — deliberately traded
 * for not requiring Redis. See `keyByDevice` for the reason that is safe here: the authenticated
 * limits exist to stop one broken agent from monopolising the server, not to meter billing.
 */

interface Bucket {
  count: number;
  resetTime: number;
}

export interface RateLimitOptions {
  /** Requests allowed per window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /**
   * What to count against. Return `null` to skip limiting this request entirely.
   * Defaults to the client IP.
   */
  key?: (req: Request) => string | null;
  /** Included in the 429 body to make the log line self-explanatory. */
  name?: string;
}

/**
 * Buckets are swept lazily rather than on a timer: a `setInterval` would keep the event loop
 * referenced and complicate shutdown, and the sweep is O(size) over a map that only holds
 * entries seen within the last window anyway.
 */
const SWEEP_EVERY = 1000;

export function rateLimiter(options: RateLimitOptions): (req: Request, res: Response, next: NextFunction) => void;
export function rateLimiter(max?: number, windowMs?: number): (req: Request, res: Response, next: NextFunction) => void;
export function rateLimiter(
  optionsOrMax: RateLimitOptions | number = 100,
  legacyWindowMs = 60 * 1000
) {
  const options: RateLimitOptions =
    typeof optionsOrMax === 'number'
      ? { max: optionsOrMax, windowMs: legacyWindowMs }
      : optionsOrMax;

  const { max, windowMs, key = keyByIp, name = 'request' } = options;

  // Scoped per rateLimiter(...) call, not module-wide — otherwise every route sharing this
  // middleware (login at 10/min, ingest at 200/min, ...) would collide on the same counter and
  // get checked against whichever limit happened to run, instead of its own.
  const buckets = new Map<string, Bucket>();
  let sinceSweep = 0;

  return (req: Request, res: Response, next: NextFunction) => {
    const bucketKey = key(req);
    if (bucketKey === null) return next();

    const now = Date.now();

    if (++sinceSweep >= SWEEP_EVERY) {
      sinceSweep = 0;
      for (const [k, bucket] of buckets) {
        if (now > bucket.resetTime) buckets.delete(k);
      }
    }

    let bucket = buckets.get(bucketKey);
    if (!bucket || now > bucket.resetTime) {
      bucket = { count: 0, resetTime: now + windowMs };
      buckets.set(bucketKey, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', remaining);
    res.setHeader('RateLimit-Reset', Math.ceil((bucket.resetTime - now) / 1000));

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetTime - now) / 1000);
      res.setHeader('Retry-After', retryAfter);

      // The agent backs off exponentially on any non-success, so a 429 during a mass rollout
      // self-heals. Saying so in the body keeps it from reading like a failure in the logs.
      return res.status(429).json({
        error: `Too many ${name} requests; retry in ${retryAfter}s`,
        retryAfterSeconds: retryAfter,
      });
    }

    next();
  };
}

/**
 * Default key. `req.ip` honours Express's `trust proxy` setting, so `x-forwarded-for` is used
 * only when the deployment declares a proxy in front (TRUST_PROXY) and is ignored otherwise.
 */
export function keyByIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * Keys enrollment by the workstation's MachineGuid, taken from the validated request body.
 *
 * This is the fix for NAT: the point of limiting enrollment is to stop one machine from
 * hammering the credential-minting endpoint, not to cap how many *distinct* machines may join
 * per minute. A hundred workstations rolling out simultaneously from behind one public IP are a
 * hundred different keys, and each gets its own budget.
 *
 * Falls back to the IP when the body has no deviceId — a malformed request should still be
 * limited, just not able to escape limiting by omitting a field.
 */
export function keyByEnrollingDevice(req: Request): string {
  const deviceId = (req.body as { deviceId?: unknown } | undefined)?.deviceId;
  return typeof deviceId === 'string' && deviceId.length > 0
    ? `device:${deviceId}`
    : `ip:${keyByIp(req)}`;
}

/**
 * Keys authenticated agent traffic by the device row id, which `deviceAuth` has already proven.
 *
 * Per-device is the correct fairness unit here: the limit exists so a single agent stuck in a
 * retry loop cannot monopolise the server, and a shared office IP must not make one busy
 * workstation throttle its ninety-nine neighbours.
 */
export function keyByDevice(req: Request): string {
  const device = (req as DeviceAuthenticatedRequest).device;
  return device ? `device:${device.id}` : `ip:${keyByIp(req)}`;
}
