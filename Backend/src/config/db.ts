import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { env } from './env';

// Pool size is configurable because the right value depends on where this runs: a single
// container against a managed Postgres wants a modest pool, several replicas behind a load
// balancer must divide the database's own connection ceiling between them.
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  // A telemetry write is a short transaction. Reaping idle connections keeps a fleet that syncs
  // in bursts from holding the pool open between cycles.
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

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
