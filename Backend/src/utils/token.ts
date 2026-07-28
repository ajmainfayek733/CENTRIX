import crypto from 'crypto';
import { env } from '../config/env';

/**
 * Device API keys (spec §2.2) are long-lived bearer credentials issued once at enrollment and
 * sent by the Agent as `Authorization: Bearer <key>` on every request. Only the HMAC is ever
 * persisted — the raw key is returned to the caller once, at registration time, and never again.
 */
export function hashDeviceApiKey(rawKey: string): string {
  return crypto.createHmac('sha256', env.DEVICE_TOKEN_PEPPER).update(rawKey).digest('hex');
}

export function generateDeviceApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}
