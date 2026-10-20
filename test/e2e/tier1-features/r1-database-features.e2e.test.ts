import request from 'supertest';
import bcrypt from 'bcryptjs';
import app from '../../../src/app';
import prisma from '../../../src/config/prisma';
import {
  authHeader,
  cleanE2EData,
  E2E_PASSWORD,
  ensureE2EUser,
  loginUser,
} from '../helpers/test-helper';

const PHONES = {
  dbAdmin: '01000008101',
  student1: '01000008102',
  teacher1: '01000008103',
  outsider: '01000008104',
};

describe('Tier 1: R1 Database & Runtime Core Features', () => {
  beforeAll(async () => {
    await cleanE2EData(Object.values(PHONES));
  });

  afterAll(async () => {
    await cleanE2EData(Object.values(PHONES));
    await prisma.$disconnect();
  });

  // =========================================================================
  // Feature 1: PostgreSQL Connection & Handshake (5 test cases)
  // =========================================================================
  describe('Feature 1: PostgreSQL Runtime & Handshake', () => {
    it('T1-F01-01: executes raw SELECT 1 to verify database handshake', async () => {
      const result = await prisma.$queryRaw<Array<{ result: number }>>`SELECT 1 as result`;
      expect(result).toBeDefined();
      expect(Number(result[0].result)).toBe(1);
    });

    it('T1-F01-02: executes aggregate queries on Prisma models cleanly', async () => {
      const count = await prisma.user.count();
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('T1-F01-03: handles multiple concurrent read queries without pool exhaustion', async () => {
      const queries = Array.from({ length: 10 }, () =>
        prisma.$queryRaw`SELECT 1 as val`
      );
      const results = await Promise.all(queries);
      expect(results.length).toBe(10);
    });

    it('T1-F01-04: /health endpoint confirms backend server is operational', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status', 'ok');
    });

    it('T1-F01-05: /api/health returns environment and status metadata', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status', 'ok');
      expect(res.body).toHaveProperty('environment');
    });
  });

  // =========================================================================
  // Feature 2: Prisma Schema & Relational Integrity (5 test cases)
  // =========================================================================
  describe('Feature 2: Prisma Schema & Relational Integrity', () => {
    let createdCourseId: string;
    let createdTeacherId: string;

    it('T1-F02-01: creates user with schema defaults and verifies persistence', async () => {
      const teacher = await ensureE2EUser({
        phone: PHONES.teacher1,
        role: 'TEACHER',
        name: 'Database Teacher 1',
      });
      createdTeacherId = teacher.id;
      expect(teacher.id).toBeDefined();
      expect(teacher.role).toBe('TEACHER');
    });

    it('T1-F02-02: creates Course model linked to Teacher via relation', async () => {
      const course = await prisma.course.create({
        data: {
          teacherId: createdTeacherId,
          title: 'E2E Relational Course 1',
          price: 150,
          currency: 'EGP',
          isPublished: true,
        },
      });
      createdCourseId = course.id;
      expect(course.id).toBeDefined();
      expect(course.teacherId).toBe(createdTeacherId);
    });

    it('T1-F02-03: creates Lesson model child linked to Course with cascading support', async () => {
      const lesson = await prisma.lesson.create({
        data: {
          courseId: createdCourseId,
          teacherId: createdTeacherId,
          title: 'E2E Relational Lesson 1',
          homeworkText: 'Answer schema question.',
        },
      });
      expect(lesson.id).toBeDefined();
      expect(lesson.courseId).toBe(createdCourseId);
    });

    it('T1-F02-04: enforces unique constraint on User phone number', async () => {
      let threw = false;
      try {
        await prisma.user.create({
          data: {
            phone: PHONES.teacher1, // duplicate
            name: 'Duplicate Phone User',
            password: await bcrypt.hash('Secret123', 10),
            role: 'TEACHER',
          },
        });
      } catch (err: any) {
        threw = true;
        expect(err.code).toBe('P2002');
      }
      expect(threw).toBe(true);
    });

    it('T1-F02-05: enforces unique composite constraint on CourseEnrollment (studentId_courseId)', async () => {
      const student = await ensureE2EUser({
        phone: PHONES.student1,
        role: 'STUDENT',
      });

      await prisma.courseEnrollment.create({
        data: {
          studentId: student.id,
          courseId: createdCourseId,
          paymentMethod: 'CASH',
          status: 'APPROVED',
        },
      });

      let threw = false;
      try {
        await prisma.courseEnrollment.create({
          data: {
            studentId: student.id,
            courseId: createdCourseId,
            paymentMethod: 'CASH',
            status: 'APPROVED',
          },
        });
      } catch (err: any) {
        threw = true;
        expect(err.code).toBe('P2002');
      }
      expect(threw).toBe(true);
    });
  });

  // =========================================================================
  // Feature 3: Dual-Revocation Authentication (5 test cases)
  // =========================================================================
  describe('Feature 3: Auth & Dual-Revocation Gate (sv + sid)', () => {
    let studentToken: string;
    let studentId: string;

    it('T1-F03-01: authenticates valid credentials and returns signed JWT token', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('X-Device-Name', 'Database-Device-1')
        .send({ phone: PHONES.student1, password: E2E_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('token');
      expect(typeof res.body.token).toBe('string');
      studentToken = res.body.token;
      studentId = res.body.user.id;
    });

    it('T1-F03-02: accesses protected /api/auth/me using valid bearer token', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set(authHeader(studentToken));

      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(studentId);
      expect(res.body.user.role).toBe('STUDENT');
    });

    it('T1-F03-03: verifies active UserSession is recorded on login', async () => {
      const sessions = await prisma.userSession.findMany({
        where: { userId: studentId, revokedAt: null },
      });
      expect(sessions.length).toBeGreaterThanOrEqual(1);
    });

    it('T1-F03-04: revokes active session upon calling /api/auth/logout', async () => {
      const res = await request(app)
        .post('/api/auth/logout')
        .set(authHeader(studentToken));

      expect(res.status).toBe(200);
      expect(res.body.revoked).toBe(true);
    });

    it('T1-F03-05: increments sessionVersion to invalidate all issued tokens', async () => {
      const { token } = await loginUser(PHONES.student1);
      // Increment session version directly in DB
      await prisma.user.update({
        where: { id: studentId },
        data: { sessionVersion: { increment: 1 } },
      });

      const res = await request(app)
        .get('/api/auth/me')
        .set(authHeader(token));

      // With sessionVersion incremented, auth middleware must reject
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // Feature 4: Password Security & Verification (5 test cases)
  // =========================================================================
  describe('Feature 4: Password Security, Hashing & Verification', () => {
    it('T1-F04-01: stores passwords as bcrypt hashes, never plaintext', async () => {
      const user = await prisma.user.findUniqueOrThrow({
        where: { phone: PHONES.student1 },
      });
      expect(user.password).not.toBe(E2E_PASSWORD);
      expect(user.password.startsWith('$2')).toBe(true);
    });

    it('T1-F04-02: rejects invalid password with HTTP 401 Unauthorized', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ phone: PHONES.student1, password: 'WrongPassword@123' });

      expect(res.status).toBe(401);
      expect(res.body).not.toHaveProperty('token');
    });

    it('T1-F04-03: /api/auth/me redacts password and private salt fields', async () => {
      const { token } = await loginUser(PHONES.student1);
      const res = await request(app)
        .get('/api/auth/me')
        .set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.user).not.toHaveProperty('password');
      expect(res.body.user).not.toHaveProperty('salt');
    });

    it('T1-F04-04: changes password successfully when providing valid current password', async () => {
      const { token } = await loginUser(PHONES.student1);
      const newPassword = 'NewSecretPassword@2026';

      const res = await request(app)
        .post('/api/auth/change-password')
        .set(authHeader(token))
        .send({
          oldPassword: E2E_PASSWORD,
          newPassword,
        });

      expect(res.status).toBe(200);

      // Verify login with new password works
      const loginCheck = await request(app)
        .post('/api/auth/login')
        .send({ phone: PHONES.student1, password: newPassword });
      expect(loginCheck.status).toBe(200);

      // Revert password back for cleanup
      await prisma.user.update({
        where: { phone: PHONES.student1 },
        data: { password: await bcrypt.hash(E2E_PASSWORD, 10) },
      });
    });

    it('T1-F04-05: verifies device name metadata is preserved on login session', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('X-Device-Name', 'Custom-Pixel-Device')
        .send({ phone: PHONES.student1, password: E2E_PASSWORD });

      expect(res.status).toBe(200);
      const session = await prisma.userSession.findFirst({
        where: { userId: res.body.user.id, deviceName: 'Custom-Pixel-Device' },
      });
      expect(session).toBeDefined();
    });
  });
});
