import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../../src/app';
import prisma from '../../../src/config/prisma';
import {
  authHeader,
  cleanE2EData,
  createSignedQrToken,
  E2E_JWT_SECRET,
  ensureE2EUser,
  loginUser,
} from '../helpers/test-helper';

const PHONES = {
  teacherA: '01000008301',
  teacherB: '01000008302',
  assistantA: '01000008303',
  student: '01000008304',
  parent: '01000008305',
};

describe('Tier 1: R2 Attendance QR Token & Register Features', () => {
  let teacherAToken: string;
  let teacherAId: string;
  let teacherBToken: string;
  let teacherBId: string;
  let assistantAToken: string;
  let studentToken: string;
  let studentId: string;
  let parentToken: string;
  let parentId: string;
  let sessionAId: string;

  beforeAll(async () => {
    await cleanE2EData(Object.values(PHONES));

    const tA = await ensureE2EUser({ phone: PHONES.teacherA, role: 'TEACHER', name: 'Attendance Teacher A' });
    teacherAId = tA.id;

    const tB = await ensureE2EUser({ phone: PHONES.teacherB, role: 'TEACHER', name: 'Attendance Teacher B' });
    teacherBId = tB.id;

    const asstA = await ensureE2EUser({
      phone: PHONES.assistantA,
      role: 'ASSISTANT',
      name: 'Attendance Assistant A',
      parentTeacherId: teacherAId,
    });

    const stud = await ensureE2EUser({ phone: PHONES.student, role: 'STUDENT', name: 'Attendance Student' });
    studentId = stud.id;

    const par = await ensureE2EUser({ phone: PHONES.parent, role: 'PARENT', name: 'Attendance Parent' });
    parentId = par.id;

    // Link parent and student
    await prisma.studentParentRelation.create({
      data: { parentId, studentId },
    });

    teacherAToken = (await loginUser(PHONES.teacherA)).token;
    teacherBToken = (await loginUser(PHONES.teacherB)).token;
    assistantAToken = (await loginUser(PHONES.assistantA)).token;
    studentToken = (await loginUser(PHONES.student)).token;
    parentToken = (await loginUser(PHONES.parent)).token;

    // Create a base attendance session for Teacher A
    const sessionRes = await request(app)
      .post('/api/attendance/sessions')
      .set(authHeader(teacherAToken))
      .send({ subject: 'Physics', grade: 'Grade 12', date: new Date().toISOString() });
    sessionAId = sessionRes.body.session.id;
  }, 60000);

  afterAll(async () => {
    await prisma.attendanceRecord.deleteMany({ where: { studentId } });
    await prisma.attendanceQrUse.deleteMany({ where: { studentId } });
    if (sessionAId) {
      await prisma.attendanceSession.deleteMany({ where: { ownerId: { in: [teacherAId, teacherBId] } } });
    }
    await cleanE2EData(Object.values(PHONES));
    await prisma.$disconnect();
  });

  // =========================================================================
  // Feature 10: Rotating 30s Attendance QR Token (5 test cases)
  // =========================================================================
  describe('Feature 10: Rotating 30s Attendance QR Token', () => {
    let qrToken: string;

    it('T1-F10-01: student requests attendance QR token via GET /api/attendance/qr-token', async () => {
      const res = await request(app)
        .get('/api/attendance/qr-token')
        .set(authHeader(studentToken));

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('token');
      expect(res.body).toHaveProperty('expiresAt');
      expect(res.body).toHaveProperty('expiresIn', 30);
      qrToken = res.body.token;
    });

    it('T1-F10-02: QR token endpoint enforces Cache-Control: no-store header', async () => {
      const res = await request(app)
        .get('/api/attendance/qr-token')
        .set(authHeader(studentToken));

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('T1-F10-03: token is cryptographically signed using HS256 algorithm', async () => {
      const decodedHeader = jwt.decode(qrToken, { complete: true });
      expect(decodedHeader?.header.alg).toBe('HS256');
    });

    it('T1-F10-04: token payload contains student UUID as sub and a unique JTI', async () => {
      const decoded: any = jwt.decode(qrToken);
      expect(decoded.sub).toBe(studentId);
      expect(decoded.jti).toBeDefined();
      expect(typeof decoded.jti).toBe('string');
      expect(decoded.type).toBe('attendance');
    });

    it('T1-F10-05: token asserts authoritative issuer and audience claims', async () => {
      const decoded: any = jwt.decode(qrToken);
      expect(decoded.iss).toBe('esmail-elgazar-lms');
      expect(decoded.aud).toBe('attendance-scanner');
    });
  });

  // =========================================================================
  // Feature 11: Single-Use JTI Replay Protection (5 test cases)
  // =========================================================================
  describe('Feature 11: Single-Use JTI Replay Protection', () => {
    let usedTokenInfo: { token: string; jti: string };

    it('T1-F11-01: teacher marks attendance with valid QR token, returns 201 Created', async () => {
      usedTokenInfo = createSignedQrToken(studentId, E2E_JWT_SECRET, 30);
      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherAToken))
        .send({
          sessionId: sessionAId,
          qrToken: usedTokenInfo.token,
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('message');
      expect(res.body.student.id).toBe(studentId);
    });

    it('T1-F11-02: creates AttendanceRecord in database linking session and student', async () => {
      const record = await prisma.attendanceRecord.findUnique({
        where: { sessionId_studentId: { sessionId: sessionAId, studentId } },
      });
      expect(record).toBeDefined();
    });

    it('T1-F11-03: records JTI in AttendanceQrUse table to burn the token', async () => {
      const qrUse = await prisma.attendanceQrUse.findUnique({
        where: { jti: usedTokenInfo.jti },
      });
      expect(qrUse).toBeDefined();
      expect(qrUse?.studentId).toBe(studentId);
    });

    it('T1-F11-04: rescanning an already marked student returns idempotent success message', async () => {
      const anotherToken = createSignedQrToken(studentId, E2E_JWT_SECRET, 30);
      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherAToken))
        .send({
          sessionId: sessionAId,
          qrToken: anotherToken.token,
        });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Attendance already marked');
    });

    it('T1-F11-05: attendance register reflects marked student in session records', async () => {
      const res = await request(app)
        .get(`/api/attendance/sessions/${sessionAId}/register`)
        .set(authHeader(teacherAToken));

      expect(res.status).toBe(200);
      const record = res.body.students.find((r: any) => r.id === studentId);
      expect(record).toBeDefined();
    });
  });

  // =========================================================================
  // Feature 12: Attendance Role Gating & Session Ownership (5 test cases)
  // =========================================================================
  describe('Feature 12: Attendance Role Gating & Session Ownership', () => {
    it('T1-F12-01: staff role (TEACHER) can create new attendance session', async () => {
      const res = await request(app)
        .post('/api/attendance/sessions')
        .set(authHeader(teacherAToken))
        .send({ subject: 'Math', grade: 'Grade 11' });

      expect(res.status).toBe(201);
      expect(res.body.session.subject).toBe('Math');
    });

    it('T1-F12-02: staff role (TEACHER) can list their own attendance sessions', async () => {
      const res = await request(app)
        .get('/api/attendance/sessions')
        .set(authHeader(teacherAToken));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it('T1-F12-03: assistant resolves ownerId to parent teacher when creating session', async () => {
      const res = await request(app)
        .post('/api/attendance/sessions')
        .set(authHeader(assistantAToken))
        .send({ subject: 'Chemistry', grade: 'Grade 10' });

      expect(res.status).toBe(201);
      expect(res.body.session.ownerId).toBe(teacherAId);
    });

    it('T1-F12-04: student calling POST /api/attendance/sessions receives 403 Forbidden', async () => {
      const res = await request(app)
        .post('/api/attendance/sessions')
        .set(authHeader(studentToken))
        .send({ subject: 'Cheating', grade: '10' });

      expect(res.status).toBe(403);
    });

    it('T1-F12-05: teacher cannot access or scan into another teacher unowned session', async () => {
      const freshToken = createSignedQrToken(studentId, E2E_JWT_SECRET, 30);
      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherBToken)) // Teacher B trying to scan Teacher A's session
        .send({
          sessionId: sessionAId,
          qrToken: freshToken.token,
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('Session not found or unauthorized');
    });
  });

  // =========================================================================
  // Feature 13: Attendance Analytics & Split-Brain Immunity (5 test cases)
  // =========================================================================
  describe('Feature 13: Attendance Analytics & Split-Brain Immunity', () => {
    it('T1-F13-01: parent queries child attendance analytics endpoint', async () => {
      const res = await request(app)
        .get(`/api/analytics/attendance/students/${studentId}`)
        .set(authHeader(parentToken));

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('presentCount');
      expect(res.body).toHaveProperty('sessionCount');
    });

    it('T1-F13-02: analytics accurately reflects present count from AttendanceRecord', async () => {
      const res = await request(app)
        .get(`/api/analytics/attendance/students/${studentId}`)
        .set(authHeader(parentToken));

      expect(res.status).toBe(200);
      expect(res.body.presentCount).toBeGreaterThanOrEqual(1);
    });

    it('T1-F13-03: legacy Tracking.isPresent flag is completely ignored by parent analytics', async () => {
      // Artificially create a tracking row with isPresent: true (simulating video view)
      const testCourse = await prisma.course.create({
        data: { teacherId: teacherAId, title: 'Split Brain Test Course' },
      });
      const testLesson = await prisma.lesson.create({
        data: { courseId: testCourse.id, teacherId: teacherAId, title: 'Split Brain Lesson' },
      });
      await prisma.tracking.create({
        data: { studentId, lessonId: testLesson.id, isPresent: true },
      });

      // Query parent analytics again
      const res = await request(app)
        .get(`/api/analytics/attendance/students/${studentId}`)
        .set(authHeader(parentToken));

      // Present count must come ONLY from AttendanceRecord, not Tracking.isPresent
      const actualAttendanceRecordsCount = await prisma.attendanceRecord.count({
        where: { studentId },
      });
      expect(res.body.presentCount).toBe(actualAttendanceRecordsCount);

      // Clean up split brain test objects
      await prisma.tracking.deleteMany({ where: { lessonId: testLesson.id } });
      await prisma.lesson.deleteMany({ where: { id: testLesson.id } });
      await prisma.course.deleteMany({ where: { id: testCourse.id } });
    });

    it('T1-F13-04: analytics returns sessions array with verified dates and subjects', async () => {
      const res = await request(app)
        .get(`/api/analytics/attendance/students/${studentId}`)
        .set(authHeader(parentToken));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
      if (res.body.sessions.length > 0) {
        expect(res.body.sessions[0]).toHaveProperty('subject');
        expect(res.body.sessions[0]).toHaveProperty('date');
      }
    });

    it('T1-F13-05: unauthenticated caller to student attendance analytics is rejected with 401', async () => {
      const res = await request(app)
        .get(`/api/analytics/attendance/students/${studentId}`);

      expect(res.status).toBe(401);
    });
  });
});
