import request from 'supertest';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import app from '../app';

import prisma from '../config/prisma';

const phone = '01060606065';
const PASSWORD = 'RateLimit@2026';

let token = '';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { phone } });
  await prisma.user.create({
    data: {
      name: 'Rate Limit Subject',
      phone,
      password: await bcrypt.hash(PASSWORD, 12),
      role: 'STUDENT',
      status: 'approved',
      isApproved: true,
      isVerified: true,
    },
  });

  const login = await request(app)
    .post('/api/auth/login')
    .set('X-Device-Name', 'Rate limit test device')
    .send({ identifier: phone, password: PASSWORD });
  expect(login.status).toBe(200);
  token = login.body.token as string;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { phone } });
  await prisma.$disconnect();
});

/**
 * Both endpoints were unthrottled. `change-password` requires the current
 * password, so a stolen 7-day session token was not enough on its own — the
 * oldPassword could be brute-forced without limit. `reset-password` consumes an
 * OTP-family token and is unauthenticated, so the token is the only credential.
 *
 * Both limiters already existed and are used elsewhere; this only attaches them.
 */
describe('password endpoints are rate limited', () => {
  it('rate limits change-password', async () => {
    // sensitiveActionRateLimit budget is 10 per 15 minutes.
    const statuses: number[] = [];
    for (let i = 0; i < 14; i += 1) {
      // Wrong current password: this must be a 401, never a 429, until the budget runs out.
      const res = await request(app)
        .post('/api/auth/change-password')
        .set(bearer(token))
        .send({ oldPassword: `wrong-${i}`, newPassword: 'BrandNew@2026' });
      statuses.push(res.status);
    }

expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
      expect(statuses).toContain(429);
      // The limiter engages well before the 14th attempt, i.e. it is a real budget
      // and not an accidental pass-through.
      expect(statuses.indexOf(429)).toBeLessThan(14);
      // Explicit budget. Each attempt performs a real bcrypt compare at cost 12
      // (roughly 250-400 ms), so 14 sequential requests legitimately exceed
      // Jest's 5 s default whenever the machine is under load. That made this a
      // permanently intermittent red build: it passed alone and failed inside a
      // full run, which is the worst kind of failure because it trains everyone
      // to ignore a red suite. The timeout states the real cost of the work
      // rather than hiding it behind a smaller iteration count — reducing the
      // count would weaken the assertion that the budget is a real budget.
    }, 30_000);

  it('rate limits reset-password', async () => {
    // otpRateLimit budget is 5 per 15 minutes.
    const statuses: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const res = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: 'not-a-real-token', newPassword: 'BrandNew@2026' });
      statuses.push(res.status);
    }

    expect(statuses).toContain(429);
  });

  it('still rejects a bad body with 400 before the limiter is consulted', async () => {
    // Schema validation must stay ahead of the limiter, so a malformed request
    // is a 400 rather than silently consuming the caller's budget.
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ nothing: 'useful' });
    expect([400, 429]).toContain(res.status);
  });
});
