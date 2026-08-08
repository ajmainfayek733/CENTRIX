import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { env } from './env';

const pool = new Pool({ connectionString: env.DATABASE_URL });
const adapter = new PrismaPg(pool);

/**
 * Query logging is opt-in via PRISMA_LOG_QUERIES rather than on for the whole dev
 * environment: every telemetry write is a wide multi-column INSERT now, so leaving it on
 * buries application output under SQL.
 */
const log: Array<'query' | 'error' | 'warn'> =
  process.env.PRISMA_LOG_QUERIES === 'true'
    ? ['query', 'error', 'warn']
    : env.NODE_ENV === 'development'
      ? ['error', 'warn']
      : ['error'];

export const prisma = new PrismaClient({ adapter, log });
