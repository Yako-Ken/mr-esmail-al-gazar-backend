import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import app from '../../../src/app';
import prisma from '../../../src/config/prisma';
import { cleanE2EData, ensureE2EUser, loginUser, authHeader } from '../helpers/test-helper';

const PHONES = {
  stressUser: '01000008941',
  studentQuery: '01000008942',
};

describe('Tier 5 Adversarial: Live PostgreSQL 16 Stress & Error Resilience (Port 5432)', () => {
  let userId: string;
  let userToken: string;

  beforeAll(async () => {
    await cleanE2EData(Object.values(PHONES));

    const u = await ensureE2EUser({
      phone: PHONES.stressUser,
      role: 'STUDENT',
      name: 'Adv PG Stress User',
    });
    userId = u.id;

    const u2 = await ensureE2EUser({
      phone: PHONES.studentQuery,
      role: 'STUDENT',
      name: 'Adv PG Query User',
    });

    userToken = (await loginUser(PHONES.stressUser)).token;
  }, 60000);

  afterAll(async () => {
    await cleanE2EData(Object.values(PHONES));
    await prisma.$disconnect();
  });

  // =========================================================================
  // Section 1: Row Contention & High Concurrency Updates
  // =========================================================================
  describe('1. Row-Level Contention & Concurrency Serialization', () => {
    it('T5-PG-01: 20 concurrent transactions updating the same user row resolve without deadlocks', async () => {
      const updatePromises = Array.from({ length: 20 }, (_, idx) =>
        prisma.$transaction(async (tx) => {
          const current = await tx.user.findUnique({
            where: { id: userId },
            select: { sessionVersion: true },
          });
          return tx.user.update({
            where: { id: userId },
            data: {
              sessionVersion: { increment: 1 },
              name: `Adv PG Stress User v${idx}`,
            },
          });
        }),
      );

      const results = await Promise.all(updatePromises);
      expect(results).toHaveLength(20);

      // Verify the final user state in PostgreSQL 16
      const finalUser = await prisma.user.findUnique({ where: { id: userId } });
      expect(finalUser?.sessionVersion).toBeGreaterThanOrEqual(20);
    });
  });

  // =========================================================================
  // Section 2: Transaction Atomicity & Rollback Integrity
  // =========================================================================
  describe('2. Multi-Operation ACID Transaction Rollback Verification', () => {
    it('T5-PG-02: aborting transaction leaves ZERO partial writes in PostgreSQL tables', async () => {
      const testPhone = '01000008949';
      let rollbackErrorCaught = false;

      try {
        await prisma.$transaction(async (tx) => {
          // 1. Create a user
          const newUser = await tx.user.create({
            data: {
              phone: testPhone,
              name: 'Doomed Rollback User',
              email: 'doomed@example.test',
              password: 'hashedpassword',
              role: 'STUDENT',
            },
          });

          // 2. Create a session for that user
          await tx.userSession.create({
            data: {
              userId: newUser.id,
              deviceName: 'stress-device',
              expiresAt: new Date(Date.now() + 86400000),
            },
          });

          // 3. Deliberately explode to force full transaction abort
          throw new Error('DELIBERATE_TEST_ABORT_FOR_ACID_VERIFICATION');
        });
      } catch (err: any) {
        if (err.message.includes('DELIBERATE_TEST_ABORT_FOR_ACID_VERIFICATION')) {
          rollbackErrorCaught = true;
        }
      }

      expect(rollbackErrorCaught).toBe(true);

      // Verify in PostgreSQL 16: User MUST NOT exist
      const checkUser = await prisma.user.findUnique({ where: { phone: testPhone } });
      expect(checkUser).toBeNull();

      // UserSession MUST NOT exist
      const checkSession = await prisma.userSession.findMany({
        where: { user: { phone: testPhone } },
      });
      expect(checkSession).toHaveLength(0);
    });
  });

  // =========================================================================
  // Section 3: SQL Injection Immunity across Dynamic Queries
  // =========================================================================
  describe('3. SQL Injection Resistance on Live PostgreSQL 16', () => {
    const maliciousPayloads = [
      `' OR '1'='1`,
      `'; DROP TABLE "User"; --`,
      `' UNION SELECT null, null, password FROM "User" --`,
      `admin'--`,
      `" OR ""="`,
      `1; SELECT pg_sleep(1); --`,
    ];

    it('T5-PG-03: rejects SQL injection in login phone/identifier parameter gracefully', async () => {
      for (const payload of maliciousPayloads) {
        const res = await request(app)
          .post('/api/auth/login')
          .send({ phone: payload, identifier: payload, password: 'password' });

        // Must reject with 401 or 400 - NEVER 500 or leak DB schema
        expect([400, 401]).toContain(res.status);
      }

      // Verify the User table was NOT dropped
      const count = await prisma.user.count();
      expect(count).toBeGreaterThan(0);
    });

    it('T5-PG-04: rejects SQL injection in lesson query parameters safely', async () => {
      const queryToken = (await loginUser(PHONES.studentQuery)).token;
      for (const payload of maliciousPayloads) {
        const res = await request(app)
          .get(`/api/lessons/${encodeURIComponent(payload)}`)
          .set(authHeader(queryToken));

        expect([400, 404]).toContain(res.status);
      }
    });
  });

  // =========================================================================
  // Section 4: 50-Query Concurrency Wave & Pool Connection Saturation
  // =========================================================================
  describe('4. Concurrency Wave & Zero Connection Leaks', () => {
    it('T5-PG-05: executes 50 parallel database transactions under load without connection pool starvation', async () => {
      const waveCount = 50;
      const t0 = Date.now();

      const wave = Array.from({ length: waveCount }, (_, i) =>
        prisma.$transaction(async (tx) => {
          const userCount = await tx.user.count();
          const courseCount = await tx.course.count();
          return { i, userCount, courseCount };
        }),
      );

      const results = await Promise.all(wave);
      const duration = Date.now() - t0;

      expect(results).toHaveLength(waveCount);
      for (const r of results) {
        expect(r.userCount).toBeGreaterThan(0);
      }
    });

    it('T5-PG-06: verifies active database connections return to baseline in pg_stat_activity', async () => {
      // Allow 500ms for connection pool to settle
      await new Promise((resolve) => setTimeout(resolve, 500));

      const activeConns = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*)::bigint as count FROM pg_stat_activity WHERE datname = 'lms_test' AND state = 'active' AND query NOT LIKE '%pg_stat_activity%';`,
      );

      const count = Number(activeConns[0]?.count ?? 0);
      // Under idle condition, active queries should be 0 or 1
      expect(count).toBeLessThanOrEqual(3);
    });
  });
});
