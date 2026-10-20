import request from 'supertest';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import app from '../app';

import prisma from '../config/prisma';

/**
 * Attendance authorization contract.
 *
 * Attendance is teacher-owned academic-record data. A STUDENT or PARENT must
 * never be able to open, list, or create an attendance session. The QR token
 * endpoint is the one deliberate exception: it is the student's own token and
 * is therefore STUDENT-only.
 *
 * These tests assert role boundaries through real HTTP, not by inspecting the
 * route table, so they catch a handler that forgets its own check as well as a
 * route that forgets the middleware.
 */

const USERS = [
  { role: 'STUDENT', phone: '01000000201' },
  { role: 'PARENT', phone: '01000000202' },
  { role: 'TEACHER', phone: '01000000203' },
  { role: 'SUPER_ADMIN', phone: '01000000204' },
] as const;

const PASSWORD = 'Attendance@2026';

const login = async (phone: string): Promise<string> => {
  const res = await request(app)
    .post('/api/auth/login')
    .set('X-Device-Name', 'attendance-authz')
    .send({ identifier: phone, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.token as string;
};

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const tokens: Record<string, string> = {};

beforeAll(async () => {
  for (const { role, phone } of USERS) {
    await prisma.user.deleteMany({ where: { phone } });
    await prisma.user.create({
      data: {
        name: `Attendance ${role}`,
        phone,
        email: `attendance-${role.toLowerCase()}@example.com`,
        password: await bcrypt.hash(PASSWORD, 10),
        role,
        status: 'approved',
        isApproved: true,
      },
    });
    tokens[role] = await login(phone);
  }
});

afterAll(async () => {
  for (const { phone } of USERS) {
    await prisma.user.deleteMany({ where: { phone } });
  }
  await prisma.$disconnect();
});

describe('attendance requires a staff role', () => {
  describe('POST /api/attendance/sessions', () => {
    it.each(['STUDENT', 'PARENT'] as const)(
      'rejects %s with 403 and creates no session',
      async (role) => {
        const subject = `ShouldNotExist-${role}-${Date.now()}`;

        const res = await request(app)
          .post('/api/attendance/sessions')
          .set(bearer(tokens[role]))
          .send({ subject, grade: 'grade-1' });

        expect(res.status).toBe(403);

        const leaked = await prisma.attendanceSession.findFirst({
          where: { subject },
        });
        expect(leaked).toBeNull();
      },
    );

    it('rejects an unauthenticated caller with 401', async () => {
      const res = await request(app)
        .post('/api/attendance/sessions')
        .send({ subject: 'anon', grade: 'grade-1' });
      expect(res.status).toBe(401);
    });

    it('allows a TEACHER to create a session', async () => {
      const subject = `TeacherSession-${Date.now()}`;
      const res = await request(app)
        .post('/api/attendance/sessions')
        .set(bearer(tokens.TEACHER))
        .send({ subject, grade: 'grade-1' });

      expect(res.status).toBe(201);
      expect(res.body.session.subject).toBe(subject);

      await prisma.attendanceSession.deleteMany({ where: { subject } });
    });

    it('allows SUPER_ADMIN to create a session', async () => {
      const subject = `AdminSession-${Date.now()}`;
      const res = await request(app)
        .post('/api/attendance/sessions')
        .set(bearer(tokens.SUPER_ADMIN))
        .send({ subject, grade: 'grade-1' });

      expect(res.status).toBe(201);
      await prisma.attendanceSession.deleteMany({ where: { subject } });
    });
  });

  describe('GET /api/attendance/sessions', () => {
    it.each(['STUDENT', 'PARENT'] as const)('rejects %s with 403', async (role) => {
      const res = await request(app)
        .get('/api/attendance/sessions')
        .set(bearer(tokens[role]));
      expect(res.status).toBe(403);
    });

    it('rejects an unauthenticated caller with 401', async () => {
      const res = await request(app).get('/api/attendance/sessions');
      expect(res.status).toBe(401);
    });

    it('allows a TEACHER to list their own sessions', async () => {
      const res = await request(app)
        .get('/api/attendance/sessions')
        .set(bearer(tokens.TEACHER));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('GET /api/attendance/qr-token', () => {
    it('is STUDENT-only: a TEACHER is refused', async () => {
      const res = await request(app)
        .get('/api/attendance/qr-token')
        .set(bearer(tokens.TEACHER));
      expect(res.status).toBe(403);
    });

    it('is STUDENT-only: a PARENT is refused', async () => {
      const res = await request(app)
        .get('/api/attendance/qr-token')
        .set(bearer(tokens.PARENT));
      expect(res.status).toBe(403);
    });

    it('issues a token to a STUDENT', async () => {
      const res = await request(app)
        .get('/api/attendance/qr-token')
        .set(bearer(tokens.STUDENT));
      expect(res.status).toBe(200);
      expect(res.body.token).toEqual(expect.any(String));
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('requires authentication', async () => {
      const res = await request(app).get('/api/attendance/qr-token');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/attendance/mark', () => {
    it.each(['STUDENT', 'PARENT'] as const)(
      'rejects %s with 403 and records no attendance',
      async (role) => {
        const subject = `MarkGuard-${role}-${Date.now()}`;
        const created = await request(app)
          .post('/api/attendance/sessions')
          .set(bearer(tokens.TEACHER))
          .send({ subject, grade: 'grade-1' });
        const sessionId = created.body.session.id;

        const res = await request(app)
          .post('/api/attendance/mark')
          .set(bearer(tokens[role]))
          .send({ sessionId, qrToken: 'not-a-real-token' });

        expect(res.status).toBe(403);
        expect(await prisma.attendanceRecord.count({ where: { sessionId } })).toBe(0);

        await prisma.attendanceSession.deleteMany({ where: { id: sessionId } });
      },
    );

    it('requires authentication', async () => {
      const res = await request(app)
        .post('/api/attendance/mark')
        .send({ sessionId: 'x', qrToken: 'y' });
      expect(res.status).toBe(401);
    });
  });

  describe('ownership isolation', () => {
    it("does not let a TEACHER read another owner's session", async () => {
      const subject = `OwnedSession-${Date.now()}`;
      const adminSession = await request(app)
        .post('/api/attendance/sessions')
        .set(bearer(tokens.SUPER_ADMIN))
        .send({ subject, grade: 'grade-1' });

      const res = await request(app)
        .get(`/api/attendance/sessions/${adminSession.body.session.id}`)
        .set(bearer(tokens.TEACHER));

      expect(res.status).toBe(404);

      await prisma.attendanceSession.deleteMany({ where: { subject } });
    });
  });
});
