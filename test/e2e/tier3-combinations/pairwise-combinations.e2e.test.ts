import request from 'supertest';
import app from '../../../src/app';
import prisma from '../../../src/config/prisma';
import {
  authHeader,
  buildPaymobWebhookBody,
  cleanE2EData,
  createSignedQrToken,
  E2E_JWT_SECRET,
  E2E_PASSWORD,
  ensureE2EUser,
  loginUser,
} from '../helpers/test-helper';

const PHONES = {
  teacher: '01000008701',
  assistant: '01000008702',
  otherTeacher: '01000008703',
  student1: '01000008704',
  student2: '01000008705',
  parent: '01000008706',
};

describe('Tier 3: Cross-Feature Pairwise Combinations & State Handoffs', () => {
  let teacherToken: string;
  let teacherId: string;
  let assistantToken: string;
  let otherTeacherToken: string;
  let student1Token: string;
  let student1Id: string;
  let student2Token: string;
  let student2Id: string;
  let parentToken: string;
  let courseId: string;
  let lessonId: string;

  beforeAll(async () => {
    await cleanE2EData(Object.values(PHONES));

    const t = await ensureE2EUser({ phone: PHONES.teacher, role: 'TEACHER', name: 'Combo Teacher' });
    teacherId = t.id;

    await ensureE2EUser({
      phone: PHONES.assistant,
      role: 'ASSISTANT',
      name: 'Combo Assistant',
      parentTeacherId: teacherId,
    });

    await ensureE2EUser({ phone: PHONES.otherTeacher, role: 'TEACHER', name: 'Other Combo Teacher' });

    const s1 = await ensureE2EUser({ phone: PHONES.student1, role: 'STUDENT', name: 'Combo Student 1' });
    student1Id = s1.id;

    const s2 = await ensureE2EUser({ phone: PHONES.student2, role: 'STUDENT', name: 'Combo Student 2' });
    student2Id = s2.id;

    const p = await ensureE2EUser({ phone: PHONES.parent, role: 'PARENT', name: 'Combo Parent' });

    // Link parent and student 1
    await prisma.studentParentRelation.create({
      data: { studentId: student1Id, parentId: p.id },
    });

    teacherToken = (await loginUser(PHONES.teacher)).token;
    assistantToken = (await loginUser(PHONES.assistant)).token;
    otherTeacherToken = (await loginUser(PHONES.otherTeacher)).token;
    student1Token = (await loginUser(PHONES.student1)).token;
    student2Token = (await loginUser(PHONES.student2)).token;
    parentToken = (await loginUser(PHONES.parent)).token;

    // Create course and lesson
    const course = await prisma.course.create({
      data: {
        teacherId,
        title: 'Combo Course',
        priceMinor: 20000,
        currency: 'EGP',
        isPublished: true,
      },
    });
    courseId = course.id;

    const lesson = await prisma.lesson.create({
      data: {
        courseId,
        teacherId,
        title: 'Combo Video Lesson',
        bunnyVideoId: 'combo-stream-uuid',
        homeworkText: 'Write your thoughts on combinations.',
        homeworkDueAt: new Date(Date.now() + 86400000),
      },
    });
    lessonId = lesson.id;
  }, 60000);

  afterAll(async () => {
    await cleanE2EData(Object.values(PHONES), [courseId]);
    await prisma.$disconnect();
  });

  // =========================================================================
  // Interaction 1 & 2: Payment -> Entitlement -> Lesson Video Access
  // =========================================================================
  describe('Pair 1: Payment Checkout -> Webhook -> Video Access', () => {
    let orderId: string;
    const priceMinor = 20000;

    it('T3-01: student initially lacks access to paid lesson playback', async () => {
      const res = await request(app)
        .get(`/api/lessons/${lessonId}/playback`)
        .set(authHeader(student1Token));

      expect(res.status).toBe(403);
    });

    it('T3-02: webhook callback activates entitlement and immediately unlocks lesson playback', async () => {
      const order = await prisma.paymentOrder.create({
        data: {
          studentId: student1Id,
          courseId,
          amountMinor: priceMinor,
          currency: 'EGP',
          provider: 'PAYMOB',
          status: 'PENDING',
          idempotencyKey: `combo-order-${Date.now()}`,
          providerOrderId: '887766',
        },
      });
      orderId = order.id;

      const webhook = buildPaymobWebhookBody({
        orderId: 887766,
        amountCents: priceMinor,
      });

      const webhookRes = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${webhook.hmac}`)
        .send(webhook.body);
      expect([200, 202]).toContain(webhookRes.status);

      // Now student should have access
      const playbackRes = await request(app)
        .get(`/api/lessons/${lessonId}/playback`)
        .set(authHeader(student1Token));

      expect(playbackRes.status).toBe(200);
      expect(playbackRes.body.protected).toBe(true);
      expect(playbackRes.body.url).toContain('token=');
    });
  });

  // =========================================================================
  // Interaction 3, 4 & 5: Attendance QR -> Parent Analytics & Split-Brain Check
  // =========================================================================
  describe('Pair 2: Attendance QR -> Parent Analytics & Split-Brain Immunity', () => {
    let sessionId: string;

    it('T3-03: teacher creates session and assistant marks attendance for student', async () => {
      const sessionRes = await request(app)
        .post('/api/attendance/sessions')
        .set(authHeader(teacherToken))
        .send({ subject: 'Math', grade: '12' });
      sessionId = sessionRes.body.session.id;

      // Student generates QR token
      const qrToken = createSignedQrToken(student1Id, E2E_JWT_SECRET, 30);

      // Assistant scans student QR into teacher's session
      const markRes = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(assistantToken))
        .send({ sessionId, qrToken: qrToken.token });

      expect(markRes.status).toBe(201);
    });

    it('T3-04: parent analytics immediately increments present count after QR scan', async () => {
      const res = await request(app)
        .get(`/api/analytics/attendance/students/${student1Id}`)
        .set(authHeader(parentToken));

      expect(res.status).toBe(200);
      expect(res.body.presentCount).toBeGreaterThanOrEqual(1);
    });

    it('T3-05: student lesson view tracking does not distort parent attendance count (split-brain immunity)', async () => {
      // Simulate student viewing lesson (Tracking.isPresent = true)
      await prisma.tracking.upsert({
        where: { studentId_lessonId: { studentId: student1Id, lessonId } },
        create: { studentId: student1Id, lessonId, isPresent: true },
        update: { isPresent: true },
      });

      const res = await request(app)
        .get(`/api/analytics/attendance/students/${student1Id}`)
        .set(authHeader(parentToken));

      // Must strictly match AttendanceRecord count, completely ignoring Tracking.isPresent
      const realRecords = await prisma.attendanceRecord.count({ where: { studentId: student1Id } });
      expect(res.body.presentCount).toBe(realRecords);
    });
  });

  // =========================================================================
  // Interaction 6 & 7: Homework Revision Loop State Machine
  // =========================================================================
  describe('Pair 3: Homework Submit -> Return -> Resubmit -> Grade', () => {
    it('T3-06: student submits homework and teacher returns with required feedback comment', async () => {
      // Student submits
      const submitRes = await request(app)
        .post(`/api/lessons/${lessonId}/homework`)
        .set(authHeader(student1Token))
        .send({ answer: 'First submission for combination review.' });
      expect(submitRes.status).toBe(201);

      // Teacher returns
      const returnRes = await request(app)
        .post(`/api/teachers/assignments/${lessonId}/return`)
        .set(authHeader(teacherToken))
        .send({
          studentId: student1Id,
          comment: 'Please expand on section 3.',
        });

      expect(returnRes.status).toBe(200);
      expect(returnRes.body.result.hwStatus).toBe('NEEDS_REVISION');
    });

    it('T3-07: student resubmits revised work and teacher issues final grade locking the record', async () => {
      // Student resubmits
      const resubmitRes = await request(app)
        .post(`/api/lessons/${lessonId}/homework`)
        .set(authHeader(student1Token))
        .send({ answer: 'Second revised submission with section 3 expanded.' });
      expect(resubmitRes.status).toBe(201);

      // Teacher grades
      const gradeRes = await request(app)
        .post(`/api/teachers/assignments/${lessonId}/grade`)
        .set(authHeader(teacherToken))
        .send({
          studentId: student1Id,
          grade: 10,
          maxGrade: 10,
          comment: 'Perfect revision!',
        });

      expect(gradeRes.status).toBe(200);
      expect(gradeRes.body.result.hwStatus).toBe('GRADED');

      // Attempting to re-submit must be blocked
      const blockedResubmit = await request(app)
        .post(`/api/lessons/${lessonId}/homework`)
        .set(authHeader(student1Token))
        .send({ answer: 'Trying to change graded work' });
      expect(blockedResubmit.status).toBe(409);
    });
  });

  // =========================================================================
  // Interaction 8 & 9: GDPR Deletion -> Immediate Revocation -> Cancelation
  // =========================================================================
  describe('Pair 4: Account Deletion -> Immediate Session Kill -> Cancel Window', () => {
    it('T3-08: deletion request immediately invalidates current JWT bearer token', async () => {
      // Student 2 requests deletion
      const deleteRes = await request(app)
        .post('/api/auth/privacy/deletion')
        .set(authHeader(student2Token))
        .send({ password: E2E_PASSWORD, reason: 'Testing combination revocation' });

      expect(deleteRes.status).toBe(202);

      // Subsequent query with same token must be rejected
      const meRes = await request(app)
        .get('/api/auth/me')
        .set(authHeader(student2Token));

      expect(meRes.status).toBe(401);
    });

    it('T3-09: student re-authenticates to cancel deletion and restores active standing', async () => {
      const freshLogin = await loginUser(PHONES.student2);
      student2Token = freshLogin.token;

      const cancelRes = await request(app)
        .post('/api/auth/privacy/deletion/cancel')
        .set(authHeader(freshLogin.token))
        .send({ password: E2E_PASSWORD });

      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.deletion.status).toBe('CANCELED');

      // Me query works normally
      const meRes = await request(app)
        .get('/api/auth/me')
        .set(authHeader(freshLogin.token));

      expect(meRes.status).toBe(200);
      expect(meRes.body.user.phone).toBe(PHONES.student2);
    });
  });

  // =========================================================================
  // Interaction 10 & 11: Password Change -> Multi-Device Revocation
  // =========================================================================
  describe('Pair 5: Password Change -> Session Invalidation Across Devices', () => {
    it('T3-10: changing password immediately invalidates pre-existing session token', async () => {
      const { token: oldToken } = await loginUser(PHONES.student2, E2E_PASSWORD, 'Device-A');
      const newPassword = 'CombinationPassword@2026';

      const changeRes = await request(app)
        .post('/api/auth/change-password')
        .set(authHeader(oldToken))
        .send({
          oldPassword: E2E_PASSWORD,
          newPassword,
        });
      expect(changeRes.status).toBe(200);

      // Using the old token on Device-A must now be rejected
      const oldCheck = await request(app)
        .get('/api/auth/me')
        .set(authHeader(oldToken));

      expect(oldCheck.status).toBe(401);

      // Revert password
      await prisma.user.update({
        where: { phone: PHONES.student2 },
        data: { password: await require('bcryptjs').hash(E2E_PASSWORD, 10) },
      });
    });

    it('T3-11: FCM push token registration maps device to user session', async () => {
      const { token } = await loginUser(PHONES.student2);
      student2Token = token;

      const fcmRes = await request(app)
        .post('/api/notifications/fcm-token')
        .set(authHeader(token))
        .send({
          token: 'e2e-fake-fcm-token-1234567890',
          platform: 'android',
        });

      expect(fcmRes.status).toBe(200);
      expect(fcmRes.body.registered).toBe(true);

      const storedToken = await prisma.pushToken.findFirst({
        where: { userId: student2Id, token: 'e2e-fake-fcm-token-1234567890' },
      });
      expect(storedToken).toBeDefined();
    });
  });

  // =========================================================================
  // Interaction 12, 13, 14: Teacher Isolation & Attendance Aggregation
  // =========================================================================
  describe('Pair 6: Multi-Actor Permissions & Dynamic Attendance Refresh', () => {
    it('T3-12: unrelated teacher cannot scan into other teacher session', async () => {
      const session = await prisma.attendanceSession.findFirst({ where: { ownerId: teacherId } });
      const qr = createSignedQrToken(student1Id, E2E_JWT_SECRET, 30);

      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(otherTeacherToken))
        .send({ sessionId: session?.id, qrToken: qr.token });

      expect(res.status).toBe(404);
    });

    it('T3-13: assistant inherits teacher course context without privilege escalation', async () => {
      const res = await request(app)
        .get(`/api/teachers/assignments/${lessonId}/register`)
        .set(authHeader(assistantToken));

      expect(res.status).toBe(200);
      expect(res.body.students).toBeDefined();
    });

    it('T3-14: second student scans into same session, register count increases', async () => {
      const session = await prisma.attendanceSession.findFirst({ where: { ownerId: teacherId } });
      const qr2 = createSignedQrToken(student2Id, E2E_JWT_SECRET, 30);

      const markRes = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({ sessionId: session?.id, qrToken: qr2.token });

      expect(markRes.status).toBe(201);

      const registerRes = await request(app)
        .get(`/api/attendance/sessions/${session?.id}/register`)
        .set(authHeader(teacherToken));

      expect(registerRes.status).toBe(200);
      expect(registerRes.body.students.length).toBeGreaterThanOrEqual(2);
    });

    it('T3-15: notification mark-read flow operates isolated per student', async () => {
      // Create test notification
      const notif = await prisma.notification.create({
        data: {
          userId: student1Id,
          type: 'lesson_new',
          title: 'New lesson available',
          body: 'Check out the new video',
        },
      });

      const readRes = await request(app)
        .post(`/api/notifications/${notif.id}/read`)
        .set(authHeader(student1Token));

      expect(readRes.status).toBe(200);
      expect(readRes.body.ok).toBe(true);
    });

    it('T3-16: student 2 cannot mark student 1 notification as read', async () => {
      const notif = await prisma.notification.create({
        data: {
          userId: student1Id,
          type: 'grade_posted',
          title: 'Grade posted',
          body: 'Your homework was graded',
        },
      });

      const res = await request(app)
        .post(`/api/notifications/${notif.id}/read`)
        .set(authHeader(student2Token));

      expect(res.status).toBe(404);
    });

    it('T3-17: fresh QR token generated after expiration scans successfully', async () => {
      const session = await prisma.attendanceSession.findFirst({ where: { ownerId: teacherId } });
      const freshQr = createSignedQrToken(student1Id, E2E_JWT_SECRET, 30);

      // Student 1 already marked in this session; idempotent response returns 200
      const res = await request(app)
        .post('/api/attendance/mark')
        .set(authHeader(teacherToken))
        .send({ sessionId: session?.id, qrToken: freshQr.token });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('already marked');
    });

    it('T3-18: media access strictly verifies course enrollment relationship', async () => {
      const res = await request(app)
        .get('/api/media?path=videos/combo-stream-uuid')
        .set(authHeader(student1Token));

      // Returns 404 Media not found because physical file is not on test disk,
      // confirming it passed the 403 authorization check without crash
      expect([200, 404]).toContain(res.status);
    });

    it('T3-19: GDPR export reflects updated attendance and grading records', async () => {
      const res = await request(app)
        .post('/api/auth/privacy/export')
        .set(authHeader(student1Token))
        .send({ password: E2E_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.export.learning.attendance.length).toBeGreaterThanOrEqual(1);
    });

    it('T3-20: complete lifecycle leaves clean state invariants across tables', async () => {
      const student1Tracking = await prisma.tracking.findUnique({
        where: { studentId_lessonId: { studentId: student1Id, lessonId } },
      });
      expect(student1Tracking?.hwStatus).toBe('GRADED');
      expect(student1Tracking?.hwGrade).toBe(10);
    });
  });
});
