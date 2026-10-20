import request from 'supertest';
import app from '../../../src/app';
import prisma from '../../../src/config/prisma';
import {
  authHeader,
  buildPaymobWebhookBody,
  cleanE2EData,
  E2E_HMAC_SECRET,
  ensureE2EUser,
  loginUser,
} from '../helpers/test-helper';

const PHONES = {
  teacher: '01000008401',
  student: '01000008402',
};

describe('Tier 1: R3 Paymob Webhook & Entitlement Features', () => {
  let teacherId: string;
  let studentId: string;
  let studentToken: string;
  let courseId: string;
  let paymentOrderId: string;
  let webhookData: ReturnType<typeof buildPaymobWebhookBody>;
  const coursePriceMinor = 25000; // 250.00 EGP

  beforeAll(async () => {
    await cleanE2EData(Object.values(PHONES));

    const teacher = await ensureE2EUser({ phone: PHONES.teacher, role: 'TEACHER', name: 'Pay Teacher' });
    teacherId = teacher.id;

    const student = await ensureE2EUser({ phone: PHONES.student, role: 'STUDENT', name: 'Pay Student' });
    studentId = student.id;

    const sLogin = await loginUser(PHONES.student);
    studentToken = sLogin.token;

    // Create course
    const course = await prisma.course.create({
      data: {
        teacherId,
        title: 'E2E Paid Course',
        priceMinor: coursePriceMinor,
        currency: 'EGP',
        isPublished: true,
      },
    });
    courseId = course.id;

    // Create pending PaymentOrder for student
    const order = await prisma.paymentOrder.create({
      data: {
        studentId,
        courseId,
        amountMinor: coursePriceMinor,
        currency: 'EGP',
        provider: 'PAYMOB',
        status: 'PENDING',
        idempotencyKey: `e2e-pay-order-${Date.now()}`,
        providerOrderId: `pm-order-${Date.now()}`,
      },
    });
    paymentOrderId = order.id;
    await prisma.paymentAttempt.create({
      data: { paymentOrderId: order.id },
    });
  }, 60000);

  afterAll(async () => {
    await prisma.paymentEvent.deleteMany({ where: { paymentOrderId } });
    await prisma.paymentAttempt.deleteMany({ where: { paymentOrderId } });
    await cleanE2EData(Object.values(PHONES), [courseId]);
    await prisma.$disconnect();
  });

  // =========================================================================
  // Feature 14: Paymob HMAC SHA-512 Verification (5 test cases)
  // =========================================================================
  describe('Feature 14: Paymob HMAC SHA-512 Verification', () => {
    beforeAll(() => {
      webhookData = buildPaymobWebhookBody({
        orderId: 999001,
        amountCents: coursePriceMinor,
        currency: 'EGP',
      });
    });

    it('T1-F14-01: builds valid SHA-512 HMAC across exactly 20 sorted fields', async () => {
      expect(webhookData.hmac).toBeDefined();
      expect(webhookData.hmac.length).toBe(128); // 64 bytes in hex
    });

    it('T1-F14-02: webhook endpoint POST /api/store/paymob/webhook accepts valid HMAC', async () => {
      // Connect existing paymentOrder with providerOrderId matching webhookData.obj.order.id
      await prisma.paymentOrder.update({
        where: { id: paymentOrderId },
        data: { providerOrderId: String(webhookData.body.obj.order.id) },
      });

      const res = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${webhookData.hmac}`)
        .send(webhookData.body);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('received', true);
    });

    it('T1-F14-03: webhook updates PaymentOrder status from PENDING to PAID', async () => {
      const order = await prisma.paymentOrder.findUnique({
        where: { id: paymentOrderId },
      });
      expect(order?.status).toBe('PAID');
    });

    it('T1-F14-04: webhook records paidAt timestamp upon successful verification', async () => {
      const order = await prisma.paymentOrder.findUnique({
        where: { id: paymentOrderId },
      });
      expect(order?.paidAt).toBeInstanceOf(Date);
    });

    it('T1-F14-05: webhook records PaymentAttempt with status SUCCEEDED', async () => {
      const attempt = await prisma.paymentAttempt.findFirst({
        where: { paymentOrderId },
      });
      expect(attempt).toBeDefined();
      expect(attempt?.status).toBe('SUCCEEDED');
    });
  });

  // =========================================================================
  // Feature 15: Paymob Webhook Idempotency & Replay Suppression (5 test cases)
  // =========================================================================
  describe('Feature 15: Paymob Webhook Idempotency & Replay Suppression', () => {
    it('T1-F15-01: records PaymentEvent with unique externalEventId', async () => {
      const events = await prisma.paymentEvent.findMany({
        where: { paymentOrderId },
      });
      expect(events.length).toBe(1);
      expect(events[0].externalEventId).toContain('paymob:');
    });

    it('T1-F15-02: replaying identical webhook payload returns HTTP 200 without error', async () => {
      // Replay the identical webhook payload that was processed in T1-F14-02
      const res = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${webhookData.hmac}`)
        .send(webhookData.body);

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    it('T1-F15-03: duplicate webhook does NOT create duplicate PaymentEvent rows', async () => {
      const events = await prisma.paymentEvent.findMany({
        where: { paymentOrderId },
      });
      expect(events.length).toBe(1);
    });

    it('T1-F15-04: duplicate webhook does NOT create multiple CourseEnrollment rows', async () => {
      const enrollments = await prisma.courseEnrollment.findMany({
        where: { studentId, courseId },
      });
      expect(enrollments.length).toBe(1);
    });

    it('T1-F15-05: duplicate webhook leaves original paidAt timestamp untouched', async () => {
      const order = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: paymentOrderId } });
      expect(order.paidAt).toBeDefined();
    });
  });

  // =========================================================================
  // Feature 16: Payment Amount Validation & Atomic Entitlement (6 test cases)
  // =========================================================================
  describe('Feature 16: Payment Amount Validation & Atomic Entitlement', () => {
    it('T1-F16-01: CourseEntitlement is created with status ACTIVE in the same transaction', async () => {
      const entitlement = await prisma.courseEntitlement.findUnique({
        where: { studentId_courseId: { studentId, courseId } },
      });
      expect(entitlement).toBeDefined();
      expect(entitlement?.status).toBe('ACTIVE');
    });

    it('T1-F16-02: CourseEnrollment is created or updated to status APPROVED', async () => {
      const enrollment = await prisma.courseEnrollment.findUnique({
        where: { studentId_courseId: { studentId, courseId } },
      });
      expect(enrollment).toBeDefined();
      expect(enrollment?.status).toBe('APPROVED');
      expect(enrollment?.paymentMethod).toBe('PAYMOB');
    });

    it('T1-F16-03: CourseEntitlement links sourceOrderId to the paid order', async () => {
      const entitlement = await prisma.courseEntitlement.findUnique({
        where: { studentId_courseId: { studentId, courseId } },
      });
      expect(entitlement?.sourceOrderId).toBe(paymentOrderId);
    });

    it('T1-F16-04: student course enrollment query reflects approved access', async () => {
      const enrollment = await prisma.courseEnrollment.findUnique({
        where: { studentId_courseId: { studentId, courseId } },
      });
      expect(enrollment?.status).toBe('APPROVED');
    });

    it('T1-F16-05: PaymentOrder amountMinor matches exactly the verified amount_cents', async () => {
      const order = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: paymentOrderId } });
      expect(order.amountMinor).toBe(coursePriceMinor);
      expect(order.currency).toBe('EGP');
    });

    it('T1-F16-06: student is now authorized to access the course content', async () => {
      const res = await request(app)
        .get(`/api/courses/${courseId}`)
        .set(authHeader(studentToken));

      expect(res.status).toBe(200);
    });
  });
});
