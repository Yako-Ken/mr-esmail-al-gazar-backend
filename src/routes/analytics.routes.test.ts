import request from 'supertest';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import app from '../app';

import prisma from '../config/prisma';

// Distinct phones so the role matrix never inherits another test's user.
const ROLE_USERS = [
  { role: 'STUDENT', phone: '01000000101' },
  { role: 'TEACHER', phone: '01000000102' },
  { role: 'SUPER_ADMIN', phone: '01000000103' },
] as const;

const loginAs = async (phone: string) => {
  const res = await request(app)
    .post('/api/auth/login')
    .set('X-Device-Name', 'analytics-role-matrix')
    .send({ identifier: phone, password: 'Analytics@2026' });
  expect(res.status).toBe(200);
  return res.body.token as string;
};

beforeAll(async () => {
  for (const { role, phone } of ROLE_USERS) {
    await prisma.user.deleteMany({ where: { phone } });
    await prisma.user.create({
      data: {
        name: `Analytics ${role}`,
        phone,
        email: `analytics-${role.toLowerCase()}@example.com`,
        password: await bcrypt.hash('Analytics@2026', 10),
        role,
        status: 'approved',
        isApproved: true,
      },
    });
  }
});

afterAll(async () => {
  for (const { phone } of ROLE_USERS) {
    await prisma.user.deleteMany({ where: { phone } });
  }
  await prisma.$disconnect();
});

/**
 * Analytics Routes — behavioral contract tests
 * 
 * These tests verify the PUBLIC contract, not the DB internals. Analytics 
 * is fire-and-forget by design — the important thing is that the HTTP 
 * endpoint accepts or rejects the right inputs and never blocks on DB 
 * availability.
 */
describe('Analytics Routes', () => {
  describe('POST /api/analytics/track', () => {
    it('accepts and persists a valid event', async () => {
      const before = await prisma.analyticsEvent.count();
      const res = await request(app)
        .post('/api/analytics/track')
        .send({
          eventType: 'course_view',
          metadata: { courseId: 'crs_001', source: 'store' },
        });

      expect(res.status).toBe(204);
      expect(await prisma.analyticsEvent.count()).toBe(before + 1);

      const saved = await prisma.analyticsEvent.findFirst({
        orderBy: { timestamp: 'desc' },
      });
      expect(saved?.metadata).toBe(
        JSON.stringify({ courseId: 'crs_001', source: 'store' }),
      );
    });

    it('rejects invalid eventType', async () => {
      const res = await request(app)
        .post('/api/analytics/track')
        .send({ eventType: 'crack_da_endpoint' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid event');
    });

    it('rejects missing eventType', async () => {
      const res = await request(app)
        .post('/api/analytics/track')
        .send({ metadata: { foo: 'bar' } });

      expect(res.status).toBe(400);
    });

    it('works with anonymous (no auth header) traffic', async () => {
      // Students on the onboarding screen are not logged in yet — must still work
      const res = await request(app)
        .post('/api/analytics/track')
        .send({ eventType: 'onboarding_complete' });

      expect(res.status).toBe(204);
    });
  });

  describe('GET /api/analytics/funnel', () => {
    it('requires auth (returns 401 without token)', async () => {
      const res = await request(app).get('/api/analytics/funnel');
      expect(res.status).toBe(401);
    });

    // The funnel aggregates platform-wide conversion counts. It is admin-only,
    // so a STUDENT or TEACHER token must be rejected rather than silently
    // receiving a 200 with a redacted body.
    it.each(['STUDENT', 'TEACHER'] as const)(
      'rejects a logged-in %s with 403 and exposes no funnel data',
      async (role) => {
        const phone = ROLE_USERS.find((u) => u.role === role)!.phone;
        const token = await loginAs(phone);

        const res = await request(app)
          .get('/api/analytics/funnel')
          .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(403);
        expect(JSON.stringify(res.body)).not.toMatch(/stats/i);
      },
    );

    it('allows SUPER_ADMIN through and returns funnel stats', async () => {
      const token = await loginAs(
        ROLE_USERS.find((u) => u.role === 'SUPER_ADMIN')!.phone,
      );

      const res = await request(app)
        .get('/api/analytics/funnel')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('stats');
    });

    it('rejects a token whose role claim was tampered with', async () => {
      // auth.middleware rebuilds req.user from the database row, so a forged
      // role inside an otherwise well-formed token must not grant access.
      const jwt = require('jsonwebtoken');
      const studentToken = await loginAs(ROLE_USERS[0].phone);
      const decoded = jwt.decode(studentToken) as Record<string, unknown>;
      // Drop the original exp/iat so jwt.sign can set a fresh one.
      const { exp: _exp, iat: _iat, ...claims } = decoded;

      const forged = jwt.sign(
        { ...claims, role: 'SUPER_ADMIN' },
        process.env.JWT_SECRET as string,
        { expiresIn: '1h' },
      );

      const res = await request(app)
        .get('/api/analytics/funnel')
        .set('Authorization', `Bearer ${forged}`);

      expect(res.status).toBe(403);
    });
  });
});
