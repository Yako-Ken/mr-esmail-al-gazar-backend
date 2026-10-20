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
  teacher: '01000008501',
  student: '01000008502',
  otherStudent: '01000008503',
};

describe('Tier 1: R3 Media Playback & GDPR Privacy Features', () => {
  let teacherToken: string;
  let teacherId: string;
  let studentToken: string;
  let studentId: string;
  let otherStudentToken: string;
  let otherStudentId: string;
  let courseId: string;
  let lessonWithBunnyId: string;

  beforeAll(async () => {
    await cleanE2EData(Object.values(PHONES));

    const teacher = await ensureE2EUser({ phone: PHONES.teacher, role: 'TEACHER', name: 'Media Teacher' });
    teacherId = teacher.id;

    const student = await ensureE2EUser({ phone: PHONES.student, role: 'STUDENT', name: 'Privacy Student' });
    studentId = student.id;

    const otherStudent = await ensureE2EUser({ phone: PHONES.otherStudent, role: 'STUDENT', name: 'Other Student' });
    otherStudentId = otherStudent.id;

    teacherToken = (await loginUser(PHONES.teacher)).token;
    studentToken = (await loginUser(PHONES.student)).token;
    otherStudentToken = (await loginUser(PHONES.otherStudent)).token;

    // Create course and enroll student
    const course = await prisma.course.create({
      data: {
        teacherId,
        title: 'E2E Media & Privacy Course',
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

    // Create lesson with Bunny video ID
    const lesson = await prisma.lesson.create({
      data: {
        courseId,
        teacherId,
        title: 'Bunny Protected Lesson',
        bunnyVideoId: 'bunny-guid-12345',
        videoLibraryId: 'lib-67890',
      },
    });
    lessonWithBunnyId = lesson.id;
  }, 60000);

  afterAll(async () => {
    await cleanE2EData(Object.values(PHONES), [courseId]);
    await prisma.$disconnect();
  });

  // =========================================================================
  // Feature 17: Bunny.net Video Streaming & Signed Playback (5 test cases)
  // =========================================================================
  describe('Feature 17: Bunny.net Video Streaming & Signed Playback', () => {
    it('T1-F17-01: enrolled student requests playback URL via GET /api/lessons/:id/playback', async () => {
      const res = await request(app)
        .get(`/api/lessons/${lessonWithBunnyId}/playback`)
        .set(authHeader(studentToken));

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('url');
    });

    it('T1-F17-02: playback URL contains signed token and expiration query parameters', async () => {
      const res = await request(app)
        .get(`/api/lessons/${lessonWithBunnyId}/playback`)
        .set(authHeader(studentToken));

      expect(res.status).toBe(200);
      expect(res.body.url).toContain('token=');
      expect(res.body.url).toContain('expires=');
      expect(res.body.protected).toBe(true);
    });

    it('T1-F17-03: playback response asserts format hls for Bunny Stream', async () => {
      const res = await request(app)
        .get(`/api/lessons/${lessonWithBunnyId}/playback`)
        .set(authHeader(studentToken));

      expect(res.status).toBe(200);
      expect(res.body.format).toBe('hls');
    });

    it('T1-F17-04: playback endpoint sets private, no-store Cache-Control header', async () => {
      const res = await request(app)
        .get(`/api/lessons/${lessonWithBunnyId}/playback`)
        .set(authHeader(studentToken));

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-store, max-age=0');
    });

    it('T1-F17-05: unenrolled student cannot access lesson playback URL', async () => {
      const res = await request(app)
        .get(`/api/lessons/${lessonWithBunnyId}/playback`)
        .set(authHeader(otherStudentToken));

      expect(res.status).toBe(403);
    });
  });

  // =========================================================================
  // Feature 18: Media Controller Path Traversal Defense & Uniform 404 (5 test cases)
  // =========================================================================
  describe('Feature 18: Media Controller Traversal Defense & Uniform 404', () => {
    it('T1-F18-01: unauthenticated access to /api/media returns HTTP 401 Unauthorized', async () => {
      const res = await request(app).get('/api/media?path=videos/test.mp4');
      expect(res.status).toBe(401);
    });

    it('T1-F18-02: invalid empty path parameter returns HTTP 400 Bad Request', async () => {
      const res = await request(app)
        .get('/api/media?path=')
        .set(authHeader(studentToken));

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid private media path');
    });

    it('T1-F18-03: querying thumbnails via private media route returns 400 (thumbnails are public)', async () => {
      const res = await request(app)
        .get('/api/media?path=thumbnails/cover.png')
        .set(authHeader(studentToken));

      expect(res.status).toBe(400);
    });

    it('T1-F18-04: missing media file returns uniform HTTP 404 to avoid information disclosure', async () => {
      const res = await request(app)
        .get('/api/media?path=videos/nonexistent-uuid-12345.mp4')
        .set(authHeader(studentToken));

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Media not found');
    });

    it('T1-F18-05: public thumbnail endpoint exists and serves static assets', async () => {
      const res = await request(app).get('/uploads/thumbnails/placeholder.png');
      // Either 404 if file missing or 200 if placeholder exists, but must NOT 500
      expect([200, 404]).toContain(res.status);
    });
  });

  // =========================================================================
  // Feature 19: GDPR Data Privacy Export (5 test cases)
  // =========================================================================
  describe('Feature 19: GDPR Data Privacy Export', () => {
    it('T1-F19-01: requests export with valid current password via POST /api/auth/privacy/export', async () => {
      const res = await request(app)
        .post('/api/auth/privacy/export')
        .set(authHeader(studentToken))
        .send({ password: E2E_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('export');
    });

    it('T1-F19-02: export bundle includes profile, course enrollments, and sessions', async () => {
      const res = await request(app)
        .post('/api/auth/privacy/export')
        .set(authHeader(studentToken))
        .send({ password: E2E_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.export.profile).toHaveProperty('phone', PHONES.student);
      expect(Array.isArray(res.body.export.learning.enrollments)).toBe(true);
    });

    it('T1-F19-03: export bundle redacts password hashes and security tokens', async () => {
      const res = await request(app)
        .post('/api/auth/privacy/export')
        .set(authHeader(studentToken))
        .send({ password: E2E_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.export.profile).not.toHaveProperty('password');
      expect(res.body.export.profile).not.toHaveProperty('jwtSecret');
    });

    it('T1-F19-04: export response sets Cache-Control: no-store, private header', async () => {
      const res = await request(app)
        .post('/api/auth/privacy/export')
        .set(authHeader(studentToken))
        .send({ password: E2E_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toContain('no-store');
    });

    it('T1-F19-05: records DataPrivacyRequest entry in database with type EXPORT', async () => {
      const exportReq = await prisma.dataPrivacyRequest.findFirst({
        where: { userId: studentId, type: 'EXPORT' },
      });
      expect(exportReq).toBeDefined();
    });
  });

  // =========================================================================
  // Feature 20: GDPR Account Erasure & Background Daemon (5 test cases)
  // =========================================================================
  describe('Feature 20: GDPR Account Erasure & Grace Period', () => {
    it('T1-F20-01: schedules account deletion via POST /api/auth/privacy/deletion with valid password', async () => {
      const res = await request(app)
        .post('/api/auth/privacy/deletion')
        .set(authHeader(otherStudentToken))
        .send({
          password: E2E_PASSWORD,
          reason: 'I am graduating.',
        });

      expect(res.status).toBe(202); // 202 Accepted
      expect(res.body.deletion).toHaveProperty('scheduledFor');
    });

    it('T1-F20-02: scheduledFor date is set approximately 7 days into the future', async () => {
      const deletionReq = await prisma.dataPrivacyRequest.findFirst({
        where: { userId: otherStudentId, type: 'DELETE' },
      });
      expect(deletionReq).toBeDefined();
      const scheduledTime = new Date(deletionReq!.scheduledFor!).getTime();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(scheduledTime - Date.now()).toBeGreaterThan(sevenDaysMs - 120000);
    });

    it('T1-F20-03: deletion scheduling immediately revokes all active UserSessions', async () => {
      const activeSessions = await prisma.userSession.findMany({
        where: { userId: otherStudentId, revokedAt: null },
      });
      expect(activeSessions.length).toBe(0);
    });

    it('T1-F20-04: deletion scheduling increments sessionVersion so old tokens are rejected', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set(authHeader(otherStudentToken));

      expect(res.status).toBe(401);
    });

    it('T1-F20-05: user cancels deletion request within grace window via /api/auth/privacy/deletion/cancel', async () => {
      // Re-login to get a fresh token for cancellation
      const freshLogin = await loginUser(PHONES.otherStudent);

      const res = await request(app)
        .post('/api/auth/privacy/deletion/cancel')
        .set(authHeader(freshLogin.token))
        .send({ password: E2E_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.deletion.status).toBe('CANCELED');

      // Verify request is marked CANCELED in DB
      const deletionReq = await prisma.dataPrivacyRequest.findFirst({
        where: { userId: otherStudentId, type: 'DELETE' },
        orderBy: { requestedAt: 'desc' },
      });
      expect(deletionReq?.status).toBe('CANCELED');
    });
  });
});
