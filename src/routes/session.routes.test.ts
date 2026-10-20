import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import app from '../app';

import prisma from '../config/prisma';
const phone = '01090909090';

const login = async (deviceName: string) => {
  const response = await request(app)
    .post('/api/auth/login')
    .set('X-Device-Name', deviceName)
    .send({ identifier: phone, password: 'Session@2026' });
  expect(response.status).toBe(200);
  return response.body.token as string;
};

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const sessionId = (token: string): string => {
  const payload = jwt.decode(token) as jwt.JwtPayload;
  expect(typeof payload.sid).toBe('string');
  return payload.sid as string;
};

describe('persistent account sessions', () => {
  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { phone } });
    await prisma.user.create({
      data: {
        name: 'Session Test',
        phone,
        email: 'session-test@example.com',
        password: await bcrypt.hash('Session@2026', 12),
        role: 'STUDENT',
        status: 'approved',
        isApproved: true,
      },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { phone } });
    await prisma.$disconnect();
  });

  it('lists sessions, identifies current, and revokes another device', async () => {
    const first = await login('Android test device');
    const second = await login('Chrome test device');

    const list = await request(app).get('/api/auth/sessions').set(bearer(second));
    expect(list.status).toBe(200);
    expect(list.body.sessions).toHaveLength(2);
    expect(list.body.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: sessionId(second), current: true }),
        expect.objectContaining({ id: sessionId(first), current: false }),
      ]),
    );
    expect(JSON.stringify(list.body)).not.toContain('userAgent');

    const revoke = await request(app)
      .delete(`/api/auth/sessions/${sessionId(first)}`)
      .set(bearer(second));
    expect(revoke.status).toBe(200);

    const revokedRequest = await request(app).get('/api/auth/me').set(bearer(first));
    expect(revokedRequest.status).toBe(401);

    const currentRevoke = await request(app)
      .delete(`/api/auth/sessions/${sessionId(second)}`)
      .set(bearer(second));
    expect(currentRevoke.status).toBe(409);
    expect(currentRevoke.body.code).toBe('CURRENT_SESSION_REQUIRES_LOGOUT');
  });

  it('revokes every other session while preserving the caller', async () => {
    const current = await login('Current iPhone');
    const other = await login('Other browser');

    const response = await request(app)
      .post('/api/auth/sessions/revoke-others')
      .set(bearer(current));
    expect(response.status).toBe(200);
    expect(response.body.revokedCount).toBeGreaterThanOrEqual(1);

    expect((await request(app).get('/api/auth/me').set(bearer(current))).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(bearer(other))).status).toBe(401);
  });

  it('persists logout revocation', async () => {
    const token = await login('Logout device');
    const logout = await request(app).post('/api/auth/logout').set(bearer(token));
    expect(logout.status).toBe(200);
    expect(logout.body.revoked).toBe(true);
    expect((await request(app).get('/api/auth/me').set(bearer(token))).status).toBe(401);
  });
});
