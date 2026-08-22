import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import app from '../app';

const prisma = new PrismaClient();

afterAll(async () => {
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
  });
});
