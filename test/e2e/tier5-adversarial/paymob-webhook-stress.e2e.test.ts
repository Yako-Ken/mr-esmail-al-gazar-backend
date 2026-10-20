import request from 'supertest';
import app from '../../../src/app';
import prisma from '../../../src/config/prisma';
import {
  buildPaymobWebhookBody,
  cleanE2EData,
  ensureE2EUser,
  E2E_HMAC_SECRET,
} from '../helpers/test-helper';
import { calculatePaymobHmac } from '../../../src/utils/paymobHmac';

const PHONES = {
  teacher: '01000008911',
  student: '01000008912',
  tamperStudent: '01000008913',
};

describe('Tier 5 Adversarial: Paymob Webhook Stress, Replay & Idempotency Testing', () => {
  let teacherId: string;
  let studentId: string;
  let tamperStudentId: string;
  let courseId: string;
  let normalOrderId: string;
  let tamperOrderId: string;
  const coursePriceMinor = 45000; // 450.00 EGP

  beforeAll(async () => {
    await cleanE2EData(Object.values(PHONES));

    const teacher = await ensureE2EUser({
      phone: PHONES.teacher,
      role: 'TEACHER',
      name: 'Adv Paymob Teacher',
    });
    teacherId = teacher.id;

    const student = await ensureE2EUser({
      phone: PHONES.student,
      role: 'STUDENT',
      name: 'Adv Paymob Student',
    });
    studentId = student.id;

    const tamperStudent = await ensureE2EUser({
      phone: PHONES.tamperStudent,
      role: 'STUDENT',
      name: 'Adv Tamper Student',
    });
    tamperStudentId = tamperStudent.id;

    const course = await prisma.course.create({
      data: {
        teacherId,
        title: 'Adversarial Paymob Resilience Course',
        priceMinor: coursePriceMinor,
        currency: 'EGP',
        isPublished: true,
      },
    });
    courseId = course.id;

    // Normal order for concurrency & replay testing
    const order1 = await prisma.paymentOrder.create({
      data: {
        studentId,
        courseId,
        amountMinor: coursePriceMinor,
        currency: 'EGP',
        provider: 'PAYMOB',
        status: 'PENDING',
        idempotencyKey: `adv-order-${Date.now()}-1`,
        providerOrderId: '88112233',
      },
    });
    normalOrderId = order1.id;

    // Tamper order for price manipulation tests
    const order2 = await prisma.paymentOrder.create({
      data: {
        studentId: tamperStudentId,
        courseId,
        amountMinor: coursePriceMinor,
        currency: 'EGP',
        provider: 'PAYMOB',
        status: 'PENDING',
        idempotencyKey: `adv-order-${Date.now()}-2`,
        providerOrderId: '88112244',
      },
    });
    tamperOrderId = order2.id;
  }, 60000);

  afterAll(async () => {
    await prisma.paymentEvent.deleteMany({
      where: { paymentOrderId: { in: [normalOrderId, tamperOrderId] } },
    });
    await prisma.paymentAttempt.deleteMany({
      where: { paymentOrderId: { in: [normalOrderId, tamperOrderId] } },
    });
    await cleanE2EData(Object.values(PHONES), [courseId]);
    await prisma.$disconnect();
  });

  // =========================================================================
  // Section 1: HMAC Tampering, Bit-Flips, Encoding & Malformed Headers
  // =========================================================================
  describe('1. HMAC Signature Tampering & Forgery Resistance', () => {
    let validWebhook: ReturnType<typeof buildPaymobWebhookBody>;

    beforeAll(() => {
      validWebhook = buildPaymobWebhookBody({
        orderId: '88112233',
        amountCents: coursePriceMinor,
      });
    });

    it('T5-PAY-01: rejects request with missing HMAC signature with HTTP 401', async () => {
      const res = await request(app)
        .post('/api/store/paymob/webhook')
        .send(validWebhook.body);

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Invalid webhook signature/i);
    });

    it('T5-PAY-02: rejects request with empty HMAC string (?hmac=) with HTTP 401', async () => {
      const res = await request(app)
        .post('/api/store/paymob/webhook?hmac=')
        .send(validWebhook.body);

      expect(res.status).toBe(401);
    });

    it('T5-PAY-03: rejects bit-flipped HMAC (single character altered at end) with HTTP 401', async () => {
      const flipped = validWebhook.hmac.slice(0, -1) + (validWebhook.hmac.endsWith('0') ? '1' : '0');
      const res = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${flipped}`)
        .send(validWebhook.body);

      expect(res.status).toBe(401);
    });

    it('T5-PAY-04: rejects bit-flipped HMAC (first character altered) with HTTP 401', async () => {
      const flipped = (validWebhook.hmac.startsWith('a') ? 'b' : 'a') + validWebhook.hmac.slice(1);
      const res = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${flipped}`)
        .send(validWebhook.body);

      expect(res.status).toBe(401);
    });

    it('T5-PAY-05: rejects non-hex HMAC strings (!@#$%^&* symbols) with HTTP 401', async () => {
      const res = await request(app)
        .post('/api/store/paymob/webhook?hmac=INVALID_NON_HEX_HMAC_STRING!@#$%^&*()')
        .send(validWebhook.body);

      expect(res.status).toBe(401);
    });

    it('T5-PAY-06: rejects truncated HMAC length (e.g. 64 chars instead of 128) with HTTP 401', async () => {
      const truncated = validWebhook.hmac.slice(0, 64);
      const res = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${truncated}`)
        .send(validWebhook.body);

      expect(res.status).toBe(401);
    });

    it('T5-PAY-07: rejects oversized HMAC length (e.g. 130 chars) with HTTP 401', async () => {
      const oversized = validWebhook.hmac + 'ff';
      const res = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${oversized}`)
        .send(validWebhook.body);

      expect(res.status).toBe(401);
    });

    it('T5-PAY-08: rejects HMAC computed with wrong secret key with HTTP 401', async () => {
      const wrongSecretHmac = calculatePaymobHmac(validWebhook.body.obj, 'wrong-secret-key-1234567890');
      const res = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${wrongSecretHmac}`)
        .send(validWebhook.body);

      expect(res.status).toBe(401);
    });

    it('T5-PAY-09: rejects payload when amount_cents was modified after HMAC generation', async () => {
      const tamperedBody = JSON.parse(JSON.stringify(validWebhook.body));
      tamperedBody.obj.amount_cents = 100; // Altered to 1 EGP

      const res = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${validWebhook.hmac}`)
        .send(tamperedBody);

      expect(res.status).toBe(401);
    });

    it('T5-PAY-10: rejects payload when order.id was modified after HMAC generation', async () => {
      const tamperedBody = JSON.parse(JSON.stringify(validWebhook.body));
      tamperedBody.obj.order.id = 99999999;

      const res = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${validWebhook.hmac}`)
        .send(tamperedBody);

      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // Section 2: Malformed Payloads & Negative Boundary Handling
  // =========================================================================
  describe('2. Malformed Payload Bodies & Validation Robustness', () => {
    it('T5-PAY-11: handles empty JSON object body gracefully without 500 crash', async () => {
      const res = await request(app)
        .post('/api/store/paymob/webhook?hmac=deadbeef')
        .send({});

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });

    it('T5-PAY-12: rejects payload missing transaction id with HTTP 400 when HMAC is computed', async () => {
      const malformedObj = {
        amount_cents: coursePriceMinor,
        order: { id: 88112233 },
      };
      const hmac = calculatePaymobHmac(malformedObj, E2E_HMAC_SECRET);

      const res = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${hmac}`)
        .send({ obj: malformedObj });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid webhook payload/i);
    });

    it('T5-PAY-13: rejects payload missing order reference with HTTP 400 when HMAC is computed', async () => {
      const malformedObj = {
        id: 778899,
        amount_cents: coursePriceMinor,
      };
      const hmac = calculatePaymobHmac(malformedObj, E2E_HMAC_SECRET);

      const res = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${hmac}`)
        .send({ obj: malformedObj });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid webhook payload/i);
    });

    it('T5-PAY-14: returns HTTP 202 matched: false when order reference does not exist in database', async () => {
      const ghostWebhook = buildPaymobWebhookBody({
        orderId: 999999999, // Non-existent order
        amountCents: coursePriceMinor,
      });

      const res = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${ghostWebhook.hmac}`)
        .send(ghostWebhook.body);

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ received: true, matched: false });
    });
  });

  // =========================================================================
  // Section 3: Concurrent Duplicate Webhook Stress & Idempotency
  // =========================================================================
  describe('3. Concurrent Duplicate Transaction IDs & Atomic Idempotency', () => {
    let concurrentWebhook: ReturnType<typeof buildPaymobWebhookBody>;

    beforeAll(() => {
      concurrentWebhook = buildPaymobWebhookBody({
        transactionId: 911001,
        orderId: '88112233',
        amountCents: coursePriceMinor,
      });
    });

    it('T5-PAY-15: 10 simultaneous webhook requests with identical txn ID resolve idempotently', async () => {
      // Fire 10 parallel HTTP requests with the exact same transaction ID and payload
      const parallelRequests = Array.from({ length: 10 }, () =>
        request(app)
          .post(`/api/store/paymob/webhook?hmac=${concurrentWebhook.hmac}`)
          .send(concurrentWebhook.body),
      );

      const responses = await Promise.all(parallelRequests);

      // Every response must return HTTP 200 OK
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ received: true, matched: true });
      }

      // Check PostgreSQL state: PaymentEvent must have EXACTLY 1 row for this event ID
      const expectedEventId = `paymob:${concurrentWebhook.txnId}:true-false-false-false`;
      const events = await prisma.paymentEvent.findMany({
        where: { externalEventId: expectedEventId },
      });
      expect(events).toHaveLength(1);
      expect(events[0].processingStatus).toBe('PROCESSED');

      // PaymentOrder must be PAID
      const updatedOrder = await prisma.paymentOrder.findUnique({
        where: { id: normalOrderId },
      });
      expect(updatedOrder?.status).toBe('PAID');
      expect(updatedOrder?.paidAt).toBeInstanceOf(Date);

      // CourseEnrollment must be strictly 1 row with status APPROVED
      const enrollments = await prisma.courseEnrollment.findMany({
        where: { studentId, courseId },
      });
      expect(enrollments).toHaveLength(1);
      expect(enrollments[0].status).toBe('APPROVED');

      // CourseEntitlement must be strictly 1 row with status ACTIVE
      const entitlements = await prisma.courseEntitlement.findMany({
        where: { studentId, courseId },
      });
      expect(entitlements).toHaveLength(1);
      expect(entitlements[0].status).toBe('ACTIVE');
    });

    it('T5-PAY-16: sequential network replay of the same webhook 5 times is strictly idempotent', async () => {
      const initialPaidAt = (await prisma.paymentOrder.findUnique({ where: { id: normalOrderId } }))?.paidAt;

      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .post(`/api/store/paymob/webhook?hmac=${concurrentWebhook.hmac}`)
          .send(concurrentWebhook.body);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ received: true, matched: true });
      }

      // Ensure no duplicate rows were added
      const expectedEventId = `paymob:${concurrentWebhook.txnId}:true-false-false-false`;
      const events = await prisma.paymentEvent.findMany({
        where: { externalEventId: expectedEventId },
      });
      expect(events).toHaveLength(1);

      const finalOrder = await prisma.paymentOrder.findUnique({ where: { id: normalOrderId } });
      expect(finalOrder?.paidAt?.getTime()).toBe(initialPaidAt?.getTime());
    });
  });

  // =========================================================================
  // Section 4: Price Mismatch & Tampered Amount Isolation
  // =========================================================================
  describe('4. Tampered Amount Stress & Entitlement Protection', () => {
    it('T5-PAY-17: webhook with valid HMAC but tampered amount (1 cent lower) rejects entitlement', async () => {
      const tamperedAmount = coursePriceMinor - 1; // 449.99 EGP instead of 450.00
      const tamperedWebhook = buildPaymobWebhookBody({
        transactionId: 911002,
        orderId: '88112244',
        amountCents: tamperedAmount,
      });

      const res = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${tamperedWebhook.hmac}`)
        .send(tamperedWebhook.body);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, matched: true });

      // The order must NOT be marked PAID
      const order = await prisma.paymentOrder.findUnique({
        where: { id: tamperOrderId },
      });
      expect(order?.status).toBe('PENDING');
      expect(order?.failureReason).toBe('WEBHOOK_AMOUNT_MISMATCH');

      // The student must NOT receive an enrollment
      const enrollment = await prisma.courseEnrollment.findUnique({
        where: { studentId_courseId: { studentId: tamperStudentId, courseId } },
      });
      expect(enrollment).toBeNull();

      // The student must NOT receive an entitlement
      const entitlement = await prisma.courseEntitlement.findUnique({
        where: { studentId_courseId: { studentId: tamperStudentId, courseId } },
      });
      expect(entitlement).toBeNull();

      // The event record must be marked REJECTED_AMOUNT_MISMATCH
      const event = await prisma.paymentEvent.findUnique({
        where: { externalEventId: `paymob:911002:true-false-false-false` },
      });
      expect(event?.processingStatus).toBe('REJECTED_AMOUNT_MISMATCH');
    });
  });
});
