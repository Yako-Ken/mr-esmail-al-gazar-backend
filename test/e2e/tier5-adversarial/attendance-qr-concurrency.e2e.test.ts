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
  teacher: '01000008920',
  outsiderTeacher: '01000008921',
  studentMain: '01000008922',
  parent: '01000008923',
  multi1: '01000008924',
  multi2: '01000008925',
  multi3: '01000008926',
  multi4: '01000008927',
  multi5: '01000008928',
};

describe('Tier 5 Adversarial: Attendance QR Token Expiring, Concurrency & Role Gates', () => {
  let teacherToken: string;
  let teacherId: string;
  let outsiderTeacherToken: string;
  let outsiderTeacherId: string;
  let studentMainToken: string;
  let studentMainId: string;
  let parentToken: string;
  let sessionId: string;
  let multiStudentIds: string[] = [];
  let multiStudentTokens: string[] = [];

  beforeAll(async () => {
    await cleanE2EData(Object.values(PHONES));

    const t = await ensureE2EUser({
      phone: PHONES.teacher,
      role: 'TEACHER',
      name: 'Adv Att Teacher',
    });
    teacherId = t.id;

    const ot = await ensureE2EUser({
      phone: PHONES.outsiderTeacher,
      role: 'TEACHER',
      name: 'Adv Outsider Teacher',
    });
    outsiderTeacherId = ot.id;

    const sm = await ensureE2EUser({
      phone: PHONES.studentMain,
      role: 'STUDENT',
      name: 'Adv Att Student Main',
    });
    studentMainId = sm.id;

    const p = await ensureE2EUser({
      phone: PHONES.parent,
      role: 'PARENT',
      name: 'Adv Att Parent',
    });

    teacherToken = (await loginUser(PHONES.teacher)).token;
    outsiderTeacherToken = (await loginUser(PHONES.outsiderTeacher)).token;
    studentMainToken = (await loginUser(PHONES.studentMain)).token;
    parentToken = (await loginUser(PHONES.parent)).token;

    // Multi-students for concurrent scanning waves
    const multiPhones = [PHONES.multi1, PHONES.multi2, PHONES.multi3, PHONES.multi4, PHONES.multi5];
    for (const phone of multiPhones) {
      const u = await ensureE2EUser({ phone, role: 'STUDENT', name: `Multi Student ${phone.slice(-1)}` });
      multiStudentIds.push(u.id);
      const l = await loginUser(phone);
      multiStudentTokens.push(l.token);
    }

    // Teacher creates classroom attendance session
    const sessionRes = await request(app)
      .post('/api/attendance/sessions')
      .set(authHeader(teacherToken))
      .send({ subject: 'Adversarial Physics', grade: 'Grade 12' });
    sessionId = sessionRes.body.session.id;
  }, 60000);

  afterAll(async () => {
    const allUserIds = [studentMainId, ...multiStudentIds];
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: allUserIds } } });
    await prisma.attendanceQrUse.deleteMany({ where: { studentId: { in: allUserIds } } });
    if (sessionId) {
      await prisma.attendanceSession.deleteMany({ where: { id: sessionId } });
    }
    await cleanE2EData(Object.values(PHONES));
    await prisma.$disconnect();
  });

  // =========================================================================
  // Section 1: Expiring Token Challenges
  // =========================================================================
  describe('1. Expiring Token Validation & Boundary Enforcement', () => {
    it('T5-ATT-01: QR token with 1-second lifetime fails check-in after 1.5 seconds (HTTP 400)', async () => {
      // Create validly signed token with 1 second TTL
      const { token } = createSignedQrToken(studentMainId, E2E_JWT_SECRET, 1);

      // Wait 1.5 seconds so token expires
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({ sessionId, qrToken: token });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/The QR code is invalid or expired/i);
    });

    it('T5-ATT-02: QR token with negative or epoch 0 exp timestamp fails check-in (HTTP 400)', async () => {
      const token = jwt.sign(
        { type: 'attendance', exp: 0 },
        E2E_JWT_SECRET,
        {
          algorithm: 'HS256',
          subject: studentMainId,
          jwtid: crypto.randomUUID(),
          issuer: 'esmail-elgazar-lms',
          audience: 'attendance-scanner',
        },
      );

      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({ sessionId, qrToken: token });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/The QR code is invalid or expired/i);
    });

    it('T5-ATT-03: QR token signed with wrong secret key fails check-in (HTTP 400)', async () => {
      const { token } = createSignedQrToken(studentMainId, 'attacker-unauthorized-secret-99999', 30);

      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({ sessionId, qrToken: token });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/The QR code is invalid or expired/i);
    });

    it('T5-ATT-04: QR token missing required claims (sub, jti, type) fails check-in (HTTP 400)', async () => {
      const token = jwt.sign(
        { invalidClaim: true },
        E2E_JWT_SECRET,
        { algorithm: 'HS256', expiresIn: 30 },
      );

      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({ sessionId, qrToken: token });

      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // Section 2: Replay & Concurrency Stress
  // =========================================================================
  describe('2. JWT JTI Replay & Concurrent Check-in Race Conditions', () => {
    it('T5-ATT-05: sequential replay of the same token returns HTTP 409 Conflict', async () => {
      const { token, jti } = createSignedQrToken(studentMainId, E2E_JWT_SECRET, 30);

      // First scan: succeeds
      const res1 = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({ sessionId, qrToken: token });

      expect(res1.status).toBe(201);
      expect(res1.body.message).toMatch(/Attendance marked successfully/i);

      // Second scan with identical token / JTI: must be rejected with HTTP 409
      const res2 = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({ sessionId, qrToken: token });

      // Note: If attendance was already marked, existingRecord check returns 200, BUT if another session or before existing record, JTI collision throws 409
      expect([200, 409]).toContain(res2.status);

      // Now create a second session for the same teacher to isolate JTI replay without hitting existingRecord for the same session
      const s2 = await request(app)
        .post('/api/attendance/sessions')
        .set(authHeader(teacherToken))
        .send({ subject: 'Adversarial Chemistry', grade: 'Grade 12' });
      const session2Id = s2.body.session.id;

      // Scanning the USED token in a NEW session must hit the JTI unique constraint and return HTTP 409
      const resUsed = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({ sessionId: session2Id, qrToken: token });

      expect(resUsed.status).toBe(409);
      expect(resUsed.body.error).toMatch(/This QR code has already been used/i);

      await prisma.attendanceSession.deleteMany({ where: { id: session2Id } });
    });

    it('T5-ATT-06: 10 concurrent scan requests with identical fresh QR token resolve with strictly 1 use', async () => {
      // Use multiStudent 1 for this isolated test in a new session
      const studentId = multiStudentIds[0];
      const s3 = await request(app)
        .post('/api/attendance/sessions')
        .set(authHeader(teacherToken))
        .send({ subject: 'Adversarial Math', grade: 'Grade 12' });
      const session3Id = s3.body.session.id;

      const { token, jti } = createSignedQrToken(studentId, E2E_JWT_SECRET, 30);

      // Fire 10 concurrent check-ins with the identical token
      const parallelScans = Array.from({ length: 10 }, () =>
        request(app)
          .post('/api/attendance/mark')
          .set(authHeader(teacherToken))
          .send({ sessionId: session3Id, qrToken: token }),
      );

      const responses = await Promise.all(parallelScans);

      // Responses must either be 201 (success), 200 (already marked), or 409 (JTI burned) - NEVER 500!
      for (const r of responses) {
        expect([200, 201, 409]).toContain(r.status);
      }

      // Exactly 1 record in AttendanceQrUse for this JTI
      const jtiRecords = await prisma.attendanceQrUse.findMany({ where: { jti } });
      expect(jtiRecords).toHaveLength(1);

      // Exactly 1 record in AttendanceRecord for this student and session
      const attRecords = await prisma.attendanceRecord.findMany({
        where: { sessionId: session3Id, studentId },
      });
      expect(attRecords).toHaveLength(1);

      await prisma.attendanceRecord.deleteMany({ where: { sessionId: session3Id } });
      await prisma.attendanceQrUse.deleteMany({ where: { jti } });
      await prisma.attendanceSession.deleteMany({ where: { id: session3Id } });
    });

    it('T5-ATT-07: rapid concurrent check-ins by 5 distinct students succeed concurrently without deadlocks', async () => {
      const s4 = await request(app)
        .post('/api/attendance/sessions')
        .set(authHeader(teacherToken))
        .send({ subject: 'Concurrent Wave Session', grade: 'Grade 12' });
      const session4Id = s4.body.session.id;

      // Generate distinct valid tokens for each student
      const scanRequests = multiStudentIds.map((sId) => {
        const { token } = createSignedQrToken(sId, E2E_JWT_SECRET, 30);
        return request(app)
          .post('/api/attendance/mark')
          .set(authHeader(teacherToken))
          .send({ sessionId: session4Id, qrToken: token });
      });

      const responses = await Promise.all(scanRequests);

      // All 5 must succeed with 201 Created
      for (const r of responses) {
        expect(r.status).toBe(201);
        expect(r.body.message).toMatch(/Attendance marked successfully/i);
      }

      // Check database: exactly 5 attendance records created
      const records = await prisma.attendanceRecord.findMany({
        where: { sessionId: session4Id },
      });
      expect(records).toHaveLength(5);

      await prisma.attendanceRecord.deleteMany({ where: { sessionId: session4Id } });
      await prisma.attendanceSession.deleteMany({ where: { id: session4Id } });
    });
  });

  // =========================================================================
  // Section 3: Wrong Student IDs & Forged Claims
  // =========================================================================
  describe('3. Wrong Student IDs & Non-Student Roles', () => {
    it('T5-ATT-08: QR token with non-existent student UUID returns HTTP 404', async () => {
      const ghostId = crypto.randomUUID();
      const { token } = createSignedQrToken(ghostId, E2E_JWT_SECRET, 30);

      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({ sessionId, qrToken: token });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/Student not found/i);
    });

    it('T5-ATT-09: QR token containing a TEACHER user ID as sub returns HTTP 404', async () => {
      const { token } = createSignedQrToken(teacherId, E2E_JWT_SECRET, 30);

      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({ sessionId, qrToken: token });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/Student not found/i);
    });
  });

  // =========================================================================
  // Section 4: Role Gates & Cross-Teacher Session Isolation
  // =========================================================================
  describe('4. Attendance Role Gates & Session Ownership Isolation', () => {
    it('T5-ATT-10: student calling GET /api/attendance/qr-token succeeds with 30s token', async () => {
      const res = await request(app)
        .get('/api/attendance/qr-token')
        .set(authHeader(studentMainToken));

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.expiresIn).toBe(30);
    });

    it('T5-ATT-11: teacher calling GET /api/attendance/qr-token returns HTTP 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/attendance/qr-token')
        .set(authHeader(teacherToken));

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Only students can create an attendance QR token/i);
    });

    it('T5-ATT-12: parent calling GET /api/attendance/qr-token returns HTTP 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/attendance/qr-token')
        .set(authHeader(parentToken));

      expect(res.status).toBe(403);
    });

    it('T5-ATT-13: student attempting POST /api/attendance/sessions returns HTTP 403 Forbidden', async () => {
      const res = await request(app)
        .post('/api/attendance/sessions')
        .set(authHeader(studentMainToken))
        .send({ subject: 'Illegal Student Session', grade: 'Grade 12' });

      expect(res.status).toBe(403);
    });

    it('T5-ATT-14: student attempting POST /api/attendance/mark returns HTTP 403 Forbidden', async () => {
      const { token } = createSignedQrToken(studentMainId, E2E_JWT_SECRET, 30);
      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(studentMainToken))
        .send({ sessionId, qrToken: token });

      expect(res.status).toBe(403);
    });

    it('T5-ATT-15: teacher cannot mark attendance in another teacher session (HTTP 404)', async () => {
      const { token } = createSignedQrToken(studentMainId, E2E_JWT_SECRET, 30);

      // Outsider teacher attempts to scan into teacher's session
      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(outsiderTeacherToken))
        .send({ sessionId, qrToken: token });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/Session not found or unauthorized/i);
    });
  });
});
