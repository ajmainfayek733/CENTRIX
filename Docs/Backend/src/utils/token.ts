import crypto from 'crypto';
import { env } from '../config/env';

export function hashDeviceToken(rawToken: string): string {
  return crypto
    .createHmac('sha256', env.DEVICE_TOKEN_PEPPER)
    .update(rawToken)
    .digest('hex');
}

export function generateDeviceToken(): string {
  return crypto.randomBytes(32).toString('hex');
}
