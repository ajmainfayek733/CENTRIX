import crypto from 'crypto';
import { env } from '../config/env';

/**
 * Device API keys (spec §9) are long-lived bearer credentials issued once at enrollment and
 * sent by the Agent as `Authorization: Bearer <key>` on every request. Only the HMAC is ever
 * persisted — the raw key is returned to the caller once, at enrollment time, and never again.
 */
export function hashDeviceApiKey(rawKey: string): string {
  return crypto.createHmac('sha256', env.DEVICE_TOKEN_PEPPER).update(rawKey).digest('hex');
}

export function generateDeviceApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * The org-wide enrollment token from the agent's install-time config (spec §11). Hashed with
 * the same pepper but a distinct domain-separation prefix, so an enrollment token can never
 * collide with — or be replayed as — a device API key.
 */
export function hashEnrollmentToken(rawToken: string): string {
  return crypto.createHmac('sha256', env.DEVICE_TOKEN_PEPPER).update(`enrollment:${rawToken}`).digest('hex');
}

export function generateEnrollmentToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Constant-time comparison for credential digests. `crypto.timingSafeEqual` throws on a length
 * mismatch, so guard that before calling it.
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
