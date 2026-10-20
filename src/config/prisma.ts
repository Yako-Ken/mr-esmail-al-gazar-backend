import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__prisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === '1' ? ['warn', 'error'] : ['error'],
  });

globalForPrisma.__prisma = prisma;

export default prisma;
