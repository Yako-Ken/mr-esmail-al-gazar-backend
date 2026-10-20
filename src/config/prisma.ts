import { PrismaClient } from '@prisma/client';

/**
 * One PrismaClient for the whole process.
 *
 * Every module used to call `new PrismaClient()` — 52 call sites across
 * controllers, routes, services, middlewares and test files. Each instance opens
 * its own connection pool, so a single `ts-jest` run tried to hold more pools
 * than PostgreSQL had `max_connections` and died with:
 *
 *   FATAL: sorry, too many clients already
 *
 * That surfaced as tests that passed in isolation and failed in a full run, in
 * numbers that changed every run — which reads as flaky product behaviour but is
 * purely connection exhaustion. In production the same exhaustion happens on load.
 *
 * Cached on globalThis so ts-jest's module registry reset between suites does
 * not spawn a fresh client (and a fresh pool) for every test file.
 */
const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__prisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === '1' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

export default prisma;