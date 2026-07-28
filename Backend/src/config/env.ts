import { z } from 'zod';
import dotenv from 'dotenv';

// quiet: dotenv prints a randomized promotional "tip" line on every load otherwise (harmless,
// just log noise — see dotenv's own lib/main.js TIPS array).
dotenv.config({ quiet: true });

const envSchema = z.object({
  PORT: z.string().default('5000').transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  BETTER_AUTH_SECRET: z.string().min(16, 'BETTER_AUTH_SECRET must be at least 16 characters'),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:3000'),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  // Pepper for hashing Agent device API keys (HMAC-SHA256). Required in production — a default
  // is provided only so local dev works out of the box; never rely on it beyond that.
  DEVICE_TOKEN_PEPPER: z.string().min(16).default('dev-only-device-token-pepper-change-me'),
  // Local filesystem root for uploaded screenshots (spec §6). Swap for blob storage (S3/Azure
  // Blob) behind the same ScreenshotStorage interface if volume grows beyond the ~30-device
  // deployment this was built for (spec §7.1).
  SCREENSHOT_STORAGE_DIR: z.string().default('./storage/screenshots'),
  // Base URL used to build the `remoteUri` returned from POST /api/v1/screenshots. The Agent
  // only logs this value locally — it is never read back — so it does not need to be publicly
  // resolvable, just stable.
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:5000'),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Invalid environment variables:', _env.error.format());
  throw new Error('Invalid environment configuration');
}

export const env = _env.data;
