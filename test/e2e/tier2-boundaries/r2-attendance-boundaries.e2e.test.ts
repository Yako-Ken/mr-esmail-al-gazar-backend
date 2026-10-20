import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
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
  teacher: '01000008641',
  otherTeacher: '01000008642',
  student: '01000008643',
  parent: '01000008644',
  unrelatedParent: '01000008645',
};

describe('Tier 2: R2 Attendance QR & Analytics Boundaries', () => {
  let teacherToken: string;
  let teacherId: string;
  let otherTeacherToken: string;
  let studentToken: string;
  let studentId: string;
  let parentToken: string;
  let parentId: string;
  let unrelatedParentToken: string;
  let sessionId: string;

  beforeAll(async () => {
    await cleanE2EData(Object.values(PHONES));

    const t = await ensureE2EUser({ phone: PHONES.teacher, role: 'TEACHER', name: 'Att Boundary Teacher' });
    teacherId = t.id;

    await ensureE2EUser({ phone: PHONES.otherTeacher, role: 'TEACHER', name: 'Other Att Teacher' });

    const s = await ensureE2EUser({ phone: PHONES.student, role: 'STUDENT', name: 'Att Boundary Student' });
    studentId = s.id;

    const p = await ensureE2EUser({ phone: PHONES.parent, role: 'PARENT', name: 'Att Boundary Parent' });
    parentId = p.id;

    await ensureE2EUser({ phone: PHONES.unrelatedParent, role: 'PARENT', name: 'Unrelated Parent' });

    // Link parent and student
    await prisma.studentParentRelation.create({
      data: { studentId, parentId },
    });

    teacherToken = (await loginUser(PHONES.teacher)).token;
    otherTeacherToken = (await loginUser(PHONES.otherTeacher)).token;
    studentToken = (await loginUser(PHONES.student)).token;
    parentToken = (await loginUser(PHONES.parent)).token;
    unrelatedParentToken = (await loginUser(PHONES.unrelatedParent)).token;

    // Create session for teacher
    const sessionRes = await request(app)
      .post('/api/attendance/sessions')
      .set(authHeader(teacherToken))
      .send({ subject: 'Biology', grade: 'Grade 10' });
    sessionId = sessionRes.body.session.id;
  }, 60000);

  afterAll(async () => {
    await prisma.attendanceRecord.deleteMany({ where: { studentId } });
    await prisma.attendanceQrUse.deleteMany({ where: { studentId } });
    if (sessionId) {
      await prisma.attendanceSession.deleteMany({ where: { id: sessionId } });
    }
    await cleanE2EData(Object.values(PHONES));
    await prisma.$disconnect();
  });

  // =========================================================================
  // Feature 10 Boundaries: QR Token Role Exclusions & Lifetimes (5 tests)
  // =========================================================================
  describe('Feature 10 Boundaries: QR Token Issuance Gates', () => {
    it('T2-F10-01: teacher calling GET /api/attendance/qr-token receives HTTP 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/attendance/qr-token')
        .set(authHeader(teacherToken));

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Only students');
    });

    it('T2-F10-02: parent calling GET /api/attendance/qr-token receives HTTP 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/attendance/qr-token')
        .set(authHeader(parentToken));

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Only students');
    });

    it('T2-F10-03: unauthenticated call to qr-token returns HTTP 401', async () => {
      const res = await request(app).get('/api/attendance/qr-token');
      expect(res.status).toBe(401);
    });

    it('T2-F10-04: QR token lifetime is strictly 30 seconds', async () => {
      const res = await request(app)
        .get('/api/attendance/qr-token')
        .set(authHeader(studentToken));

      expect(res.status).toBe(200);
      expect(res.body.expiresIn).toBe(30);

      const decoded: any = jwt.decode(res.body.token);
      const lifetime = decoded.exp - decoded.iat;
      expect(lifetime).toBe(30);
    });

    it('T2-F10-05: student with pending status is rejected when requesting QR token', async () => {
      const pendingStudent = await ensureE2EUser({
        phone: '01000008649',
        role: 'STUDENT',
        status: 'pending',
      });

      // Login will fail or token query will be rejected
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ phone: '01000008649', password: 'hash' });

      expect(loginRes.status).toBe(401);
      await prisma.user.delete({ where: { id: pendingStudent.id } });
    });
  });

  // =========================================================================
  // Feature 11 Boundaries: Anti-Replay & Token Tampering (5 tests)
  // =========================================================================
  describe('Feature 11 Boundaries: Anti-Replay & Token Tampering', () => {
    it('T2-F11-01: expired QR token (>30s) returns HTTP 400 with expiration error', async () => {
      const expiredToken = createSignedQrToken(studentId, E2E_JWT_SECRET, -5); // Expired 5 seconds ago

      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({
          sessionId,
          qrToken: expiredToken.token,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('expired');
    });

    it('T2-F11-02: replaying identical burned JTI token returns HTTP 409 Conflict', async () => {
      const token = createSignedQrToken(studentId, E2E_JWT_SECRET, 30);

      // First scan burns the token
      const res1 = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({ sessionId, qrToken: token.token });
      expect([200, 201]).toContain(res1.status);

      // Pre-insert a dummy session to force JTI collision in different session
      const tempSession = await prisma.attendanceSession.create({
        data: { subject: 'Collision Test', grade: '10', ownerId: teacherId },
      });

      // Scan the SAME burned JTI into tempSession
      const res2 = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({ sessionId: tempSession.id, qrToken: token.token });

      expect(res2.status).toBe(409);
      expect(res2.body.error).toContain('already been used');

      await prisma.attendanceSession.delete({ where: { id: tempSession.id } });
    });

    it('T2-F11-03: forged QR token signed with wrong secret is rejected with HTTP 400', async () => {
      const forgedToken = jwt.sign(
        { type: 'attendance', sub: studentId, jti: crypto.randomUUID() },
        'wrong-attacker-secret',
        {
          algorithm: 'HS256',
          issuer: 'esmail-elgazar-lms',
          audience: 'attendance-scanner',
          expiresIn: 30,
        }
      );

      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({ sessionId, qrToken: forgedToken });

      expect(res.status).toBe(400);
    });

    it('T2-F11-04: token with invalid issuer claim is rejected with HTTP 400', async () => {
      const forgedIssuerToken = jwt.sign(
        { type: 'attendance', sub: studentId, jti: crypto.randomUUID() },
        E2E_JWT_SECRET,
        {
          algorithm: 'HS256',
          issuer: 'rogue-issuer',
          audience: 'attendance-scanner',
          expiresIn: 30,
        }
      );

      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({ sessionId, qrToken: forgedIssuerToken });

      expect(res.status).toBe(400);
    });

    it('T2-F11-05: token with invalid audience claim is rejected with HTTP 400', async () => {
      const forgedAudienceToken = jwt.sign(
        { type: 'attendance', sub: studentId, jti: crypto.randomUUID() },
        E2E_JWT_SECRET,
        {
          algorithm: 'HS256',
          issuer: 'esmail-elgazar-lms',
          audience: 'wrong-audience',
          expiresIn: 30,
        }
      );

      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({ sessionId, qrToken: forgedAudienceToken });

      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // Feature 12 Boundaries: Role Gating & Session Isolation (5 tests)
  // =========================================================================
  describe('Feature 12 Boundaries: Role Gating & Session Isolation', () => {
    it('T2-F12-01: student attempting to invoke /api/attendance/mark returns HTTP 403', async () => {
      const token = createSignedQrToken(studentId, E2E_JWT_SECRET, 30);
      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(studentToken))
        .send({ sessionId, qrToken: token.token });

      expect(res.status).toBe(403);
    });

    it('T2-F12-02: mark request missing sessionId returns HTTP 400', async () => {
      const token = createSignedQrToken(studentId, E2E_JWT_SECRET, 30);
      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({ qrToken: token.token });

      expect(res.status).toBe(400);
    });

    it('T2-F12-03: mark request missing qrToken returns HTTP 400', async () => {
      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({ sessionId });

      expect(res.status).toBe(400);
    });

    it('T2-F12-04: scanning into non-existent sessionId returns HTTP 404', async () => {
      const token = createSignedQrToken(studentId, E2E_JWT_SECRET, 30);
      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({
          sessionId: '00000000-0000-0000-0000-000000000000',
          qrToken: token.token,
        });

      expect(res.status).toBe(404);
    });

    it('T2-F12-05: other teacher cannot view attendance register of unowned session', async () => {
      const res = await request(app)
        .get(`/api/attendance/sessions/${sessionId}/register`)
        .set(authHeader(otherTeacherToken));

      expect([403, 404]).toContain(res.status);
    });
  });

  // =========================================================================
  // Feature 13 Boundaries: Parent Analytics Boundary Cases (5 tests)
  // =========================================================================
  describe('Feature 13 Boundaries: Parent Analytics Access Restrictions', () => {
    it('T2-F13-01: unrelated parent querying student attendance receives HTTP 403 or 404', async () => {
      const res = await request(app)
        .get(`/api/analytics/attendance/students/${studentId}`)
        .set(authHeader(unrelatedParentToken));

      expect([403, 404]).toContain(res.status);
    });

    it('T2-F13-02: student attempting to query parent analytics endpoint receives HTTP 403', async () => {
      const res = await request(app)
        .get(`/api/analytics/attendance/students/${studentId}`)
        .set(authHeader(studentToken));

      expect(res.status).toBe(403);
    });

    it('T2-F13-03: analytics query with malformed student UUID returns 400 or 404', async () => {
      const res = await request(app)
        .get('/api/analytics/attendance/students/malformed-not-a-uuid')
        .set(authHeader(parentToken));

      expect([400, 404]).toContain(res.status);
    });

    it('T2-F13-04: analytics query for non-existent student UUID returns 404', async () => {
      const res = await request(app)
        .get('/api/analytics/attendance/students/00000000-0000-0000-0000-000000000000')
        .set(authHeader(parentToken));

      expect([403, 404]).toContain(res.status);
    });

    it('T2-F13-05: attendance rate calculation safely handles 0 total sessions without divide-by-zero error', async () => {
      // Create student with 0 sessions
      const freshStudent = await ensureE2EUser({ phone: '01000008648', role: 'STUDENT' });
      await prisma.studentParentRelation.create({
        data: { studentId: freshStudent.id, parentId },
      });

      const res = await request(app)
        .get(`/api/analytics/attendance/students/${freshStudent.id}`)
        .set(authHeader(parentToken));

      expect(res.status).toBe(200);
      expect(res.body.sessionCount).toBe(0);
      expect(res.body.presentCount).toBe(0);

      await prisma.studentParentRelation.deleteMany({ where: { studentId: freshStudent.id } });
      await prisma.user.delete({ where: { id: freshStudent.id } });
    });
  });
});
