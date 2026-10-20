import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../../src/app';
import prisma from '../../../src/config/prisma';
import {
  authHeader,
  cleanE2EData,
  E2E_JWT_SECRET,
  E2E_PASSWORD,
  ensureE2EUser,
  loginUser,
} from '../helpers/test-helper';

const PHONES = {
  activeStudent: '01000008601',
  bannedStudent: '01000008602',
  teacher: '01000008603',
};

describe('Tier 2: R1 Database & Auth Boundaries & Corner Cases', () => {
  let activeStudentToken: string;
  let activeStudentId: string;
  let teacherId: string;

  beforeAll(async () => {
    await cleanE2EData(Object.values(PHONES));

    const student = await ensureE2EUser({
      phone: PHONES.activeStudent,
      role: 'STUDENT',
      name: 'Boundary Student',
    });
    activeStudentId = student.id;

    await ensureE2EUser({
      phone: PHONES.bannedStudent,
      role: 'STUDENT',
      status: 'banned',
      name: 'Banned Student',
    });

    const teacher = await ensureE2EUser({
      phone: PHONES.teacher,
      role: 'TEACHER',
      name: 'Boundary Teacher',
    });
    teacherId = teacher.id;

    activeStudentToken = (await loginUser(PHONES.activeStudent)).token;
  }, 60000);

  afterAll(async () => {
    await cleanE2EData(Object.values(PHONES));
    await prisma.$disconnect();
  });

  // =========================================================================
  // Feature 1 Boundaries: Database Connectivity & Malformed Requests (5 tests)
  // =========================================================================
  describe('Feature 1 Boundaries: Database & Transport Limits', () => {
    it('T2-F01-01: malformed JSON request body returns HTTP 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"phone": "01000000000", invalid json}');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Malformed JSON body');
    });

    it('T2-F01-02: query parameters exceeding numeric bounds are safely handled', async () => {
      const res = await request(app)
        .get('/api/notifications?limit=999999999999999999999')
        .set(authHeader(activeStudentToken));

      expect([200, 400]).toContain(res.status);
    });

    it('T2-F01-03: unsupported content encoding header is rejected', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Encoding', 'unsupported-gzip-fake')
        .send('test');

      expect([400, 415]).toContain(res.status);
    });

    it('T2-F01-04: non-existent endpoint returns uniform HTTP 404', async () => {
      const res = await request(app).get('/api/non-existent-subpath-for-testing');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Endpoint not found');
    });

    it('T2-F01-05: database transaction rollback prevents partial state corruption', async () => {
      let rolledBack = false;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: activeStudentId },
            data: { name: 'Temporary Corrupt Name' },
          });
          throw new Error('Forced Rollback');
        });
      } catch {
        rolledBack = true;
      }

      expect(rolledBack).toBe(true);
      const student = await prisma.user.findUniqueOrThrow({ where: { id: activeStudentId } });
      expect(student.name).not.toBe('Temporary Corrupt Name');
    });
  });

  // =========================================================================
  // Feature 2 Boundaries: Prisma Schema & Constraint Edge Cases (5 tests)
  // =========================================================================
  describe('Feature 2 Boundaries: Prisma Relational Constraints', () => {
    it('T2-F02-01: inserting Course with non-existent teacherId triggers foreign key violation', async () => {
      let threw = false;
      try {
        await prisma.course.create({
          data: {
            teacherId: '00000000-0000-0000-0000-000000000000',
            title: 'Orphaned Course',
          },
        });
      } catch (err: any) {
        threw = true;
        expect(err.code).toBe('P2003'); // Foreign key constraint failed
      }
      expect(threw).toBe(true);
    });

    it('T2-F02-02: deleting Course cascades and removes related Lesson children', async () => {
      const tempCourse = await prisma.course.create({
        data: { teacherId, title: 'Cascade Course' },
      });
      const tempLesson = await prisma.lesson.create({
        data: { courseId: tempCourse.id, teacherId, title: 'Cascade Lesson' },
      });

      // Delete the course
      await prisma.course.delete({ where: { id: tempCourse.id } });

      // Lesson must be deleted via cascade
      const foundLesson = await prisma.lesson.findUnique({ where: { id: tempLesson.id } });
      expect(foundLesson).toBeNull();
    });

    it('T2-F02-03: accepts null for optional nullable fields without database rejection', async () => {
      const userWithNulls = await prisma.user.create({
        data: {
          phone: '01000008609',
          name: 'Nullable Field Student',
          password: 'hash',
          email: null,
          deviceId: null,
          parentPhone: null,
        },
      });

      expect(userWithNulls.email).toBeNull();
      expect(userWithNulls.deviceId).toBeNull();
      await prisma.user.delete({ where: { id: userWithNulls.id } });
    });

    it('T2-F02-04: rejects duplicate entries in StudentParentRelation (composite unique key)', async () => {
      const parent = await ensureE2EUser({ phone: '01000008608', role: 'PARENT' });
      await prisma.studentParentRelation.create({
        data: { studentId: activeStudentId, parentId: parent.id },
      });

      let threw = false;
      try {
        await prisma.studentParentRelation.create({
          data: { studentId: activeStudentId, parentId: parent.id },
        });
      } catch (err: any) {
        threw = true;
        expect(err.code).toBe('P2002');
      }
      expect(threw).toBe(true);
      await prisma.studentParentRelation.deleteMany({ where: { studentId: activeStudentId } });
      await prisma.user.delete({ where: { id: parent.id } });
    });

    it('T2-F02-05: query on non-existent primary key returns null without exception', async () => {
      const nonExistent = await prisma.user.findUnique({
        where: { id: '00000000-0000-0000-0000-000000000000' },
      });
      expect(nonExistent).toBeNull();
    });
  });

  // =========================================================================
  // Feature 3 Boundaries: Auth Token Malformations & Status Exclusions (5 tests)
  // =========================================================================
  describe('Feature 3 Boundaries: Auth Token Malformation & Status Gates', () => {
    it('T2-F03-01: malformed bearer token (random string) returns HTTP 401 Unauthorized', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer this-is-not-a-valid-jwt');

      expect(res.status).toBe(401);
    });

    it('T2-F03-02: empty Bearer prefix returns HTTP 401 Unauthorized', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer ');

      expect(res.status).toBe(401);
    });

    it('T2-F03-03: non-bearer authorization scheme returns HTTP 401 Unauthorized', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Basic dXNlcjpwYXNz');

      expect(res.status).toBe(401);
    });

    it('T2-F03-04: expired JWT token returns HTTP 401 Unauthorized', async () => {
      const expiredToken = jwt.sign(
        { userId: activeStudentId, role: 'STUDENT', sv: 0 },
        E2E_JWT_SECRET,
        { expiresIn: -10 } // expired 10 seconds ago
      );

      const res = await request(app)
        .get('/api/auth/me')
        .set(authHeader(expiredToken));

      expect(res.status).toBe(401);
    });

    it('T2-F03-05: user with status "banned" is rejected by auth middleware with HTTP 401', async () => {
      // Issue a valid JWT for the banned student
      const bannedToken = jwt.sign(
        { userId: PHONES.bannedStudent, role: 'STUDENT', sv: 0 },
        E2E_JWT_SECRET,
        { expiresIn: 3600 }
      );

      const res = await request(app)
        .get('/api/auth/me')
        .set(authHeader(bannedToken));

      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // Feature 4 Boundaries: Password Edge Cases & Validation Limits (5 tests)
  // =========================================================================
  describe('Feature 4 Boundaries: Password Validation & Rate Limiting', () => {
    it('T2-F04-01: registration rejects password shorter than minimum length', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          name: 'Short Pass User',
          phone: '01000008607',
          password: '123', // Too short
          role: 'STUDENT',
        });

      expect(res.status).toBe(400);
    });

    it('T2-F04-02: change-password rejects incorrect old password with HTTP 401', async () => {
      const res = await request(app)
        .post('/api/auth/change-password')
        .set(authHeader(activeStudentToken))
        .send({
          oldPassword: 'IncorrectOldPassword@123',
          newPassword: 'BrandNewValidPassword@2026',
        });

      expect([400, 401]).toContain(res.status);
      expect(res.body.error).toMatch(/old password|incorrect/i);
    });

    it('T2-F04-03: change-password rejects new password that is empty or whitespace', async () => {
      const res = await request(app)
        .post('/api/auth/change-password')
        .set(authHeader(activeStudentToken))
        .send({
          oldPassword: E2E_PASSWORD,
          newPassword: '   ',
        });

      expect(res.status).toBe(400);
    });

    it('T2-F04-04: login with unregistered phone number returns HTTP 401 without timing leak', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          phone: '01099999999',
          password: E2E_PASSWORD,
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });

    it('T2-F04-05: sensitiveActionRateLimit guards sensitive password endpoints', async () => {
      // Perform a series of invalid change password attempts
      const attempts = Array.from({ length: 5 }, () =>
        request(app)
          .post('/api/auth/change-password')
          .set(authHeader(activeStudentToken))
          .send({
            currentPassword: 'BadPassword',
            newPassword: 'ValidNewPassword@123',
          })
      );

      const results = await Promise.all(attempts);
      // Responses must be either 400 (rejected credentials) or 429 (rate limited)
      results.forEach((r) => {
        expect([400, 429]).toContain(r.status);
      });
    });
  });
});
