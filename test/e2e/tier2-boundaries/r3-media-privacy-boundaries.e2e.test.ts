import request from 'supertest';
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
  superAdmin: '01000008681',
  student: '01000008682',
  unenrolledStudent: '01000008683',
  teacher: '01000008684',
};

describe('Tier 2: R3 Media & Privacy Boundaries & Security Gates', () => {
  let superAdminToken: string;
  let studentToken: string;
  let studentId: string;
  let unenrolledStudentToken: string;
  let teacherToken: string;
  let courseId: string;
  let emptyLessonId: string;
  let bunnyLessonId: string;

  beforeAll(async () => {
    await cleanE2EData(Object.values(PHONES));

    await ensureE2EUser({
      phone: PHONES.superAdmin,
      role: 'SUPER_ADMIN',
      name: 'E2E Super Admin',
    });

    const student = await ensureE2EUser({
      phone: PHONES.student,
      role: 'STUDENT',
      name: 'Boundary Privacy Student',
    });
    studentId = student.id;

    await ensureE2EUser({
      phone: PHONES.unenrolledStudent,
      role: 'STUDENT',
      name: 'Unenrolled Media Student',
    });

    const teacher = await ensureE2EUser({
      phone: PHONES.teacher,
      role: 'TEACHER',
      name: 'Boundary Media Teacher',
    });

    superAdminToken = (await loginUser(PHONES.superAdmin)).token;
    studentToken = (await loginUser(PHONES.student)).token;
    unenrolledStudentToken = (await loginUser(PHONES.unenrolledStudent)).token;
    teacherToken = (await loginUser(PHONES.teacher)).token;

    // Create course and enrollment for student
    const course = await prisma.course.create({
      data: {
        teacherId: teacher.id,
        title: 'Media Traversal Course',
        isPublished: true,
      },
    });
    courseId = course.id;

    await prisma.courseEnrollment.create({
      data: {
        studentId,
        courseId,
        paymentMethod: 'CASH',
        status: 'APPROVED',
      },
    });

    // Lesson with Bunny video
    const l1 = await prisma.lesson.create({
      data: {
        courseId,
        teacherId: teacher.id,
        title: 'Bunny Lesson',
        bunnyVideoId: 'video-guid-abc',
      },
    });
    bunnyLessonId = l1.id;

    // Lesson without video
    const l2 = await prisma.lesson.create({
      data: {
        courseId,
        teacherId: teacher.id,
        title: 'No Video Lesson',
      },
    });
    emptyLessonId = l2.id;
  }, 60000);

  afterAll(async () => {
    await prisma.dataPrivacyRequest.deleteMany({ where: { userId: studentId } });
    await cleanE2EData(Object.values(PHONES), [courseId]);
    await prisma.$disconnect();
  });

  // =========================================================================
  // Feature 17 Boundaries: Video Playback Access Restrictions (5 tests)
  // =========================================================================
  describe('Feature 17 Boundaries: Video Playback Access Restrictions', () => {
    it('T2-F17-01: unauthenticated playback request returns HTTP 401 Unauthorized', async () => {
      const res = await request(app).get(`/api/lessons/${bunnyLessonId}/playback`);
      expect(res.status).toBe(401);
    });

    it('T2-F17-02: playback query for non-existent lesson UUID returns HTTP 404', async () => {
      const res = await request(app)
        .get('/api/lessons/00000000-0000-0000-0000-000000000000/playback')
        .set(authHeader(studentToken));

      expect(res.status).toBe(404);
    });

    it('T2-F17-03: unenrolled student requesting playback receives HTTP 403 Forbidden', async () => {
      const res = await request(app)
        .get(`/api/lessons/${bunnyLessonId}/playback`)
        .set(authHeader(unenrolledStudentToken));

      expect(res.status).toBe(403);
    });

    it('T2-F17-04: lesson without any video configured returns HTTP 404 with descriptive error', async () => {
      const res = await request(app)
        .get(`/api/lessons/${emptyLessonId}/playback`)
        .set(authHeader(studentToken));

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('Lesson video is not available');
    });

    it('T2-F17-05: signed playback URL expiresAt is approximately 2 hours in the future', async () => {
      const res = await request(app)
        .get(`/api/lessons/${bunnyLessonId}/playback`)
        .set(authHeader(studentToken));

      expect(res.status).toBe(200);
      const twoHoursMs = 7200 * 1000;
      const expiry = new Date(res.body.expiresAt).getTime();
      expect(expiry - Date.now()).toBeLessThanOrEqual(twoHoursMs + 10000);
    });
  });

  // =========================================================================
  // Feature 18 Boundaries: Path Traversal Defenses & Anti-Oracle (5 tests)
  // =========================================================================
  describe('Feature 18 Boundaries: Path Traversal & Anti-Discovery Oracle', () => {
    it('T2-F18-01: relative path traversal (../../secret.txt) returns HTTP 400 or 404', async () => {
      const res = await request(app)
        .get('/api/media?path=../../secret.txt')
        .set(authHeader(studentToken));

      expect([400, 404]).toContain(res.status);
    });

    it('T2-F18-02: backslash path traversal (..\\..\\secret.txt) returns HTTP 400 or 404', async () => {
      const res = await request(app)
        .get('/api/media?path=..\\..\\secret.txt')
        .set(authHeader(studentToken));

      expect([400, 404]).toContain(res.status);
    });

    it('T2-F18-03: null byte injection in media path returns HTTP 400 or 404', async () => {
      const res = await request(app)
        .get('/api/media?path=videos/test%00.mp4')
        .set(authHeader(studentToken));

      expect([400, 404]).toContain(res.status);
    });

    it('T2-F18-04: absolute root paths are rejected as invalid media path', async () => {
      const res = await request(app)
        .get('/api/media?path=/etc/passwd')
        .set(authHeader(studentToken));

      expect([400, 404]).toContain(res.status);
    });

    it('T2-F18-05: returns identical uniform 404 for missing media and unauthorized media', async () => {
      // Query 1: non-existent file
      const res1 = await request(app)
        .get('/api/media?path=videos/does-not-exist.mp4')
        .set(authHeader(studentToken));

      // Query 2: unauthorized file
      const res2 = await request(app)
        .get('/api/media?path=videos/unauthorized.mp4')
        .set(authHeader(unenrolledStudentToken));

      expect(res1.status).toBe(404);
      expect(res2.status).toBe(404);
      expect(res1.body.error).toBe('Media not found');
      expect(res2.body.error).toBe('Media not found');
    });
  });

  // =========================================================================
  // Feature 19 Boundaries: GDPR Export Re-Authentication Failures (5 tests)
  // =========================================================================
  describe('Feature 19 Boundaries: GDPR Export Password Re-Auth', () => {
    it('T2-F19-01: data export with incorrect password returns HTTP 400 INVALID_REAUTH', async () => {
      const res = await request(app)
        .post('/api/auth/privacy/export')
        .set(authHeader(studentToken))
        .send({ password: 'WrongPassword@123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('كلمة المرور الحالية');
    });

    it('T2-F19-02: data export with empty password returns HTTP 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/auth/privacy/export')
        .set(authHeader(studentToken))
        .send({ password: '' });

      expect(res.status).toBe(400);
    });

    it('T2-F19-03: unauthenticated call to /api/auth/privacy/export returns HTTP 401', async () => {
      const res = await request(app)
        .post('/api/auth/privacy/export')
        .send({ password: E2E_PASSWORD });

      expect(res.status).toBe(401);
    });

    it('T2-F19-04: user querying /api/auth/privacy/requests sees existing requests', async () => {
      const res = await request(app)
        .get('/api/auth/privacy/requests')
        .set(authHeader(studentToken));

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('latestExport');
    });

    it('T2-F19-05: new user without data exports empty arrays gracefully without crashing', async () => {
      const newUser = await ensureE2EUser({ phone: '01000008689', role: 'STUDENT' });
      const newLogin = await loginUser('01000008689');

      const res = await request(app)
        .post('/api/auth/privacy/export')
        .set(authHeader(newLogin.token))
        .send({ password: E2E_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.export.learning.enrollments).toEqual([]);
      await cleanE2EData(['01000008689']);
    });
  });

  // =========================================================================
  // Feature 20 Boundaries: Super Admin Deletion Guard & Grace Limits (5 tests)
  // =========================================================================
  describe('Feature 20 Boundaries: Super Admin Guard & Deletion Limits', () => {
    it('T2-F20-01: Super Admin account deletion is blocked with HTTP 403', async () => {
      const res = await request(app)
        .post('/api/auth/privacy/deletion')
        .set(authHeader(superAdminToken))
        .send({
          password: E2E_PASSWORD,
          reason: 'I am shutting down the platform.',
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SUPER_ADMIN_DELETION_REQUIRES_GOVERNANCE');
    });

    it('T2-F20-02: deletion request with wrong password returns HTTP 400 INVALID_REAUTH', async () => {
      const res = await request(app)
        .post('/api/auth/privacy/deletion')
        .set(authHeader(studentToken))
        .send({
          password: 'IncorrectOldPassword',
          reason: 'leaving',
        });

      expect(res.status).toBe(400);
    });

    it('T2-F20-03: deletion request without password field returns HTTP 400', async () => {
      const res = await request(app)
        .post('/api/auth/privacy/deletion')
        .set(authHeader(studentToken))
        .send({ reason: 'no password given' });

      expect(res.status).toBe(400);
    });

    it('T2-F20-04: cancel deletion with wrong password returns HTTP 400', async () => {
      const res = await request(app)
        .post('/api/auth/privacy/deletion/cancel')
        .set(authHeader(studentToken))
        .send({ password: 'BadPassword' });

      expect(res.status).toBe(400);
    });

    it('T2-F20-05: cancel deletion when no deletion was pending returns HTTP 400 or 404', async () => {
      const res = await request(app)
        .post('/api/auth/privacy/deletion/cancel')
        .set(authHeader(studentToken))
        .send({ password: E2E_PASSWORD });

      // No pending deletion exists, so cancelation is rejected
      expect([400, 404, 409]).toContain(res.status);
    });
  });
});
