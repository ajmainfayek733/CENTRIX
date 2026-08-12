import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('5000').transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  BETTER_AUTH_SECRET: z.string().min(16, 'BETTER_AUTH_SECRET must be at least 16 characters'),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  DEVICE_TOKEN_PEPPER: z.string().default('default_pepper_key_change_in_prod'),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('X Invalid environment variables:', _env.error.format());
  throw new Error('Invalid environment configuration');
}

export const env = _env.data;
