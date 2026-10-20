import { Request } from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import app from '../app';
import { createUserSession } from '../services/session.service';

import prisma from '../config/prisma';

/**
 * Defect 2 — `UserSession` rows were never pruned.
 *
 * `createUserSession` (src/services/session.service.ts) minted a row with
 * `expiresAt = now + 7d` on every login/refresh and nothing ever removed it.
 * Logout only stamped `revokedAt`, so the table grew without bound and retained
 * device names, user agents and masked IPs long after they had any purpose —
 * a data-retention problem and a storage problem at the same time.
 *
 * The contract pinned here:
 *   1. creating a session also removes rows whose `expiresAt` has passed;
 *   2. only expired rows go — live sessions, revoked-but-unexpired sessions,
 *      and other users' rows are untouched;
 *   3. it is idempotent, and safe when two processes run it at the same time.
 *
 * Tests 1 and 4 fail against the pre-fix code: the expired rows survive.
 *
 * Phone budget: this file owns 01000000940 (the subject) and 01000000941 (an
 * unrelated bystander whose rows must never be collected).
 */

const PHONES = {
  SUBJECT: '01000000940',
  BYSTANDER: '01000000941',
} as const;

const PASSWORD = 'SessionPrune@2026';

const ids: Record<string, string> = {};

// Offsets chosen far from "now" so no assertion can be decided by the millisecond
// a test happens to run on.
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const ids_seeded: string[] = [];

/**
 * A minimal stand-in for the Express request. `createUserSession` only reads
 * `req.headers['x-device-name']`, `req.headers['user-agent']` and `req.ip`, so
 * this exercises the real production code path without an HTTP round-trip —
 * which matters because `/api/auth/login` is rate limited to 10 attempts per
 * 15 minutes and a concurrency test needs far more than that.
 */
const fakeReq = (deviceName = 'pruning-fixture'): Request =>
  ({
    headers: { 'x-device-name': deviceName },
    ip: '10.11.12.13',
  }) as unknown as Request;

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const upsertUser = async (key: keyof typeof PHONES) => {
  const phone = PHONES[key];
  const row = await prisma.user.upsert({
    where: { phone },
    update: {
      role: 'STUDENT',
      status: 'approved',
      isApproved: true,
      isVerified: true,
      password: await bcrypt.hash(PASSWORD, 10),
    },
    create: {
      name: `Session Prune ${key}`,
      phone,
      email: `session-prune-${phone}@example.com`,
      password: await bcrypt.hash(PASSWORD, 10),
      role: 'STUDENT',
      status: 'approved',
      isApproved: true,
      isVerified: true,
    },
  });
  ids[key] = row.id;
  return row;
};

/**
 * Seeds a session directly so the expiry state is exact and independent of any
 * production code under test.
 */
const seedSession = async (userId: string, expiresAt: Date, revokedAt: Date | null = null) => {
  const row = await prisma.userSession.create({
    data: {
      userId,
      deviceName: 'seeded-fixture',
      userAgent: 'seeded-fixture/1.0',
      ipHint: '10.0.0.*',
      lastSeenAt: new Date(),
      expiresAt,
      revokedAt,
    },
    select: { id: true },
  });
  ids_seeded.push(row.id);
  return row.id;
};

const countSessions = (userId: string) =>
  prisma.userSession.count({ where: { userId } });

const countById = (idsToCount: string[]) =>
  prisma.userSession.count({ where: { id: { in: idsToCount } } });

const clearSessions = async (): Promise<void> => {
  ids_seeded.length = 0;
  const userIds = Object.values(ids).filter(Boolean);
  if (userIds.length > 0) {
    // Scoped to this suite's own fixtures. Never an unfiltered deleteMany.
    await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  }
};

beforeAll(async () => {
  await upsertUser('SUBJECT');
  await upsertUser('BYSTANDER');
});

afterAll(async () => {
  await clearSessions();
  const userIds = Object.values(ids).filter(Boolean);
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

beforeEach(async () => {
  await clearSessions();
});

describe('creating a session prunes the expired ones', () => {
  it('removes expired rows while leaving every unexpired row in place', async () => {
    // Guard the premise: the rows below really are in the table before the
    // session creation under test runs.
    const longExpired = await seedSession(ids.SUBJECT, new Date(Date.now() - 30 * DAY_MS));
    const justExpired = await seedSession(ids.SUBJECT, new Date(Date.now() - DAY_MS));
    const barelyExpired = await seedSession(
      ids.SUBJECT,
      new Date(Date.now() - 60 * 1000),
    );
    expect(await countById([longExpired, justExpired, barelyExpired])).toBe(3);

    await createUserSession(prisma, fakeReq(), ids.SUBJECT);

    // Only the expired ones go.
    expect(await countById([longExpired, justExpired, barelyExpired])).toBe(0);
    // ...and the session that was just created survived.
    expect(await countSessions(ids.SUBJECT)).toBe(1);
  });

  it('is reachable through the real login route, not only the service function', async () => {
    const first = await request(app)
      .post('/api/auth/login')
      .set('X-Device-Name', 'prune-e2e-first')
      .send({ identifier: PHONES.SUBJECT, password: PASSWORD });
    expect(first.status).toBe(200);
    const firstToken = first.body.token as string;

    const expired = await seedSession(ids.SUBJECT, new Date(Date.now() - 7 * DAY_MS));
    expect(await countById([expired])).toBe(1);

    // A second login is what a real user does next.
    const second = await request(app)
      .post('/api/auth/login')
      .set('X-Device-Name', 'prune-e2e-second')
      .send({ identifier: PHONES.SUBJECT, password: PASSWORD });
    expect(second.status).toBe(200);

    expect(await countById([expired])).toBe(0);
    expect(await countSessions(ids.SUBJECT)).toBe(2);

    // Pruning is not logout: the already-issued token still authenticates.
    const me = await request(app).get('/api/auth/me').set(bearer(firstToken));
    expect(me.status).toBe(200);
  });
});

describe('pruning cannot delete anything it is not entitled to', () => {
  it('keeps an unexpired session and a revoked-but-unexpired session', async () => {
    // Negative test: an over-eager prune is as much a defect as no prune. Only
    // `expiresAt` in the past is in scope — revocation is logout's business and
    // its row is still useful for "signed out on this device" history.
    const live = await seedSession(ids.SUBJECT, new Date(Date.now() + 6 * DAY_MS));
    const revokedButLive = await seedSession(
      ids.SUBJECT,
      new Date(Date.now() + 6 * DAY_MS),
      new Date(Date.now() - DAY_MS),
    );
    const expired = await seedSession(ids.SUBJECT, new Date(Date.now() - 1));

    await createUserSession(prisma, fakeReq(), ids.SUBJECT);

    expect(await countById([live, revokedButLive])).toBe(2);
    expect(await countById([expired])).toBe(0);
  });

  it('never touches an unexpired session, whoever owns it', async () => {
    const mineExpired = await seedSession(ids.SUBJECT, new Date(Date.now() - 10 * DAY_MS));
    const theirsExpired = await seedSession(ids.BYSTANDER, new Date(Date.now() - 10 * DAY_MS));
    const theirsLive = await seedSession(ids.BYSTANDER, new Date(Date.now() + 5 * DAY_MS));

    await createUserSession(prisma, fakeReq(), ids.SUBJECT);

    expect(await countById([mineExpired, theirsExpired])).toBe(0);
    // The sweep is deliberately table-wide, not scoped to the user who happened
    // to log in: a per-user prune would let every dormant account's rows
    // accumulate forever, which is the defect being fixed. What it must respect
    // is the expiry boundary, and it does so for every owner equally.
    expect(await countById([theirsLive])).toBe(1);
    expect(await countSessions(ids.BYSTANDER)).toBe(1);
  });
});

describe('pruning is idempotent and concurrency safe', () => {
  it('can be run repeatedly without erroring or changing a stable answer', async () => {
    await seedSession(ids.SUBJECT, new Date(Date.now() - 2 * HOUR_MS));

    await createUserSession(prisma, fakeReq('run-1'), ids.SUBJECT);
    const afterFirst = await countSessions(ids.SUBJECT);
    expect(afterFirst).toBe(1);

    // Three more runs: nothing left to collect, so the count must not drift and
    // nothing may throw.
    await createUserSession(prisma, fakeReq('run-2'), ids.SUBJECT);
    await createUserSession(prisma, fakeReq('run-3'), ids.SUBJECT);
    await createUserSession(prisma, fakeReq('run-4'), ids.SUBJECT);
    expect(await countSessions(ids.SUBJECT)).toBe(4);
  });

  it('survives many overlapping prunes at once, deleting each expired row exactly once', async () => {
    const expiredIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      expiredIds.push(await seedSession(ids.SUBJECT, new Date(Date.now() - (i + 1) * HOUR_MS)));
    }
    const liveIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      liveIds.push(await seedSession(ids.SUBJECT, new Date(Date.now() + (i + 1) * DAY_MS)));
    }

    // This is the multi-instance case: every one of these runs its own prune,
    // and they overlap in time on the same rows. None may reject.
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_unused, i) =>
        createUserSession(prisma, fakeReq(`concurrent-${i}`), ids.SUBJECT),
      ),
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.map((r) => (r as PromiseRejectedResult).reason?.message)).toEqual([]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    // Every expired row is gone exactly once — no survivor, and no partial
    // state left behind by a loser of a lock race.
    expect(await countById(expiredIds)).toBe(0);
    // Every unexpired row survived the stampede.
    expect(await countById(liveIds)).toBe(5);
    // 25 fresh sessions + 5 pre-existing live ones.
    expect(await countSessions(ids.SUBJECT)).toBe(30);
  });
});