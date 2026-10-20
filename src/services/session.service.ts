import { PrismaClient, UserSession } from '@prisma/client';
import { Request } from 'express';
import { logger } from '../utils/logger';

const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Rows collected per call. Bounds both the lock set and the statement's runtime,
 * so one login can never turn into an unbounded delete during a backlog.
 */
const PRUNE_BATCH_SIZE = 500;

const sanitizeHeader = (value: unknown, maxLength: number): string | null => {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\r\n\0]/g, ' ').trim();
  return clean ? clean.slice(0, maxLength) : null;
};

export const maskIpAddress = (rawIp: string | undefined): string | null => {
  if (!rawIp) return null;
  const ip = rawIp.replace(/^::ffff:/, '').trim();
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.*`;
  if (ip.includes(':')) {
    const parts = ip.split(':').filter(Boolean);
    return `${parts.slice(0, 3).join(':')}::*`;
  }
  return null;
};

export const describeDevice = (req: Request): string => {
  const supplied = sanitizeHeader(req.headers['x-device-name'], 80);
  if (supplied) return supplied;

  const agent = sanitizeHeader(req.headers['user-agent'], 300)?.toLowerCase() ?? '';
  if (agent.includes('android')) return 'Android';
  if (agent.includes('iphone') || agent.includes('ipad')) return 'iPhone / iPad';
  if (agent.includes('windows')) return 'Windows';
  if (agent.includes('mac os') || agent.includes('macintosh')) return 'macOS';
  if (agent.includes('linux')) return 'Linux';
  if (agent.includes('dart')) return 'تطبيق الموبايل';
  return 'جهاز غير معروف';
};

export const createUserSession = async (
  prisma: PrismaClient,
  req: Request,
  userId: string,
): Promise<UserSession> => {
  const now = new Date();
  const session = await prisma.userSession.create({
    data: {
      userId,
      deviceName: describeDevice(req),
      userAgent: sanitizeHeader(req.headers['user-agent'], 500),
      ipHint: maskIpAddress(req.ip),
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS),
    },
  });

  // Retire what this write path has been manufacturing. Login is the only place
  // a UserSession is created, so it is the only place that can be held
  // responsible for collecting them; a timer would only move the same problem
  // somewhere no test can reach. Ordering: the new row is created first, so it
  // can never be a prune candidate even if the clock is skewed.
  await pruneExpiredUserSessions(prisma, now);

  return session;
};

/**
 * Deletes sessions whose `expiresAt` has passed.
 *
 * Everything about this statement is chosen so that a second process running it
 * at the same instant is a non-event rather than an error:
 *
 *   - `FOR UPDATE SKIP LOCKED` means an overlapping run skips rows another run
 *     is already holding instead of blocking behind them, which is also what
 *     removes the deadlock risk two concurrent DELETEs would otherwise carry;
 *   - `ORDER BY "id"` gives every runner the same lock acquisition order;
 *   - `LIMIT` caps the work and the lock footprint of any single call;
 *   - it is one statement, so it is atomic — a partial prune is not observable;
 *   - deleting by a primary key that another runner may already have removed is
 *     not an error, so the overlap is naturally idempotent.
 *
 * Runs on the `now` captured before the new session existed, so "expired" means
 * expired as of this request.
 *
 * Never throws. Pruning is housekeeping; failing it must not turn a successful
 * sign-in into a 500. The next login retries whatever was skipped.
 */
export const pruneExpiredUserSessions = async (
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> => {
  try {
    const deleted = await prisma.$queryRaw<{ id: string }[]>`
      DELETE FROM "UserSession"
      WHERE "id" IN (
        SELECT "id"
        FROM "UserSession"
        WHERE "expiresAt" <= ${now}
        ORDER BY "id"
        FOR UPDATE SKIP LOCKED
        LIMIT ${PRUNE_BATCH_SIZE}
      )
      RETURNING "id"
    `;
    return Array.isArray(deleted) ? deleted.length : 0;
  } catch (error) {
    logger.warn('Session prune skipped:', (error as Error)?.message);
    return 0;
  }
};
