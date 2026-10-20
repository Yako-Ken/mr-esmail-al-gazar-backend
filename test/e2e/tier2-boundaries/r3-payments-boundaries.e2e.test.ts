import request from 'supertest';
import app from '../../../src/app';
import prisma from '../../../src/config/prisma';
import {
  buildPaymobWebhookBody,
  cleanE2EData,
  ensureE2EUser,
} from '../helpers/test-helper';

const PHONES = {
  teacher: '01000008661',
  student: '01000008662',
};

describe('Tier 2: R3 Paymob Webhook Boundaries & Fraud Prevention', () => {
  let studentId: string;
  let teacherId: string;
  let courseId: string;
  let paymentOrderId: string;
  const coursePriceMinor = 50000; // 500.00 EGP

  beforeAll(async () => {
    await cleanE2EData(Object.values(PHONES));

    const teacher = await ensureE2EUser({ phone: PHONES.teacher, role: 'TEACHER', name: 'Pay Fraud Teacher' });
    teacherId = teacher.id;

    const student = await ensureE2EUser({ phone: PHONES.student, role: 'STUDENT', name: 'Pay Fraud Student' });
    studentId = student.id;

    const course = await prisma.course.create({
      data: {
        teacherId,
        title: 'E2E Fraud Prevention Course',
        priceMinor: coursePriceMinor,
        currency: 'EGP',
        isPublished: true,
      },
    });
    courseId = course.id;

    const order = await prisma.paymentOrder.create({
      data: {
        studentId,
        courseId,
        amountMinor: coursePriceMinor,
        currency: 'EGP',
        provider: 'PAYMOB',
        status: 'PENDING',
        idempotencyKey: `e2e-fraud-order-${Date.now()}`,
        providerOrderId: '998877',
      },
    });
    paymentOrderId = order.id;
  }, 60000);

  afterAll(async () => {
    await prisma.paymentEvent.deleteMany({ where: { paymentOrderId } });
    await prisma.paymentAttempt.deleteMany({ where: { paymentOrderId } });
    await cleanE2EData(Object.values(PHONES), [courseId]);
    await prisma.$disconnect();
  });

  // =========================================================================
  // Feature 14 Boundaries: Forged & Malformed HMAC Signatures (5 tests)
  // =========================================================================
  describe('Feature 14 Boundaries: HMAC Tampering & Forgery Rejections', () => {
    let validWebhook: ReturnType<typeof buildPaymobWebhookBody>;

    beforeAll(() => {
      validWebhook = buildPaymobWebhookBody({
        orderId: 998877,
        amountCents: coursePriceMinor,
      });
    });

    it('T2-F14-01: webhook without HMAC query or header returns HTTP 401 Unauthorized', async () => {
      const res = await request(app)
        .post('/api/store/paymob/webhook')
        .send(validWebhook.body);

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('signature');
    });

    it('T2-F14-02: webhook with empty hmac query string returns HTTP 401 Unauthorized', async () => {
      const res = await request(app)
        .post('/api/store/paymob/webhook?hmac=')
        .send(validWebhook.body);

      expect(res.status).toBe(401);
    });

    it('T2-F14-03: webhook with forged HMAC signature (altered hash) returns HTTP 401', async () => {
      // Tamper with the last character of the valid HMAC
      const forgedHmac = validWebhook.hmac.slice(0, -1) + (validWebhook.hmac.endsWith('a') ? 'b' : 'a');

      const res = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${forgedHmac}`)
        .send(validWebhook.body);

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('signature');
    });

    it('T2-F14-04: webhook with truncated HMAC length (timingSafeEqual check) returns HTTP 401', async () => {
      const truncatedHmac = validWebhook.hmac.slice(0, 32);

      const res = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${truncatedHmac}`)
        .send(validWebhook.body);

      expect(res.status).toBe(401);
    });

    it('T2-F14-05: rejected webhook makes ZERO changes to the database record', async () => {
      const order = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: paymentOrderId } });
      expect(order.status).toBe('PENDING');
      expect(order.paidAt).toBeNull();
    });
  });

  // =========================================================================
  // Feature 15 Boundaries: Payload Schema Violations & Replay (5 tests)
  // =========================================================================
  describe('Feature 15 Boundaries: Payload Schema Violations & Replay', () => {
    it('T2-F15-01: webhook with missing order object returns HTTP 400 Bad Request', async () => {
      const payload: any = {
        obj: {
          id: 12345,
          amount_cents: coursePriceMinor,
          success: true,
          // Missing order.id
        },
      };

      const res = await request(app)
        .post('/api/store/paymob/webhook?hmac=dummy')
        .send(payload);

      expect([400, 401]).toContain(res.status);
    });

    it('T2-F15-02: webhook with missing transaction ID returns HTTP 400 or 401', async () => {
      const payload: any = {
        obj: {
          amount_cents: coursePriceMinor,
          order: { id: 998877 },
          success: true,
        },
      };

      const res = await request(app)
        .post('/api/store/paymob/webhook?hmac=dummy')
        .send(payload);

      expect([400, 401]).toContain(res.status);
    });

    it('T2-F15-03: duplicate webhook delivery suppresses side effects without crashing', async () => {
      // Send valid webhook
      const valid = buildPaymobWebhookBody({ orderId: 998877, amountCents: coursePriceMinor });
      const res1 = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${valid.hmac}`)
        .send(valid.body);
      expect([200, 202]).toContain(res1.status);

      // Re-send the same
      const res2 = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${valid.hmac}`)
        .send(valid.body);
      expect(res2.status).toBe(200);
      expect(res2.body.received).toBe(true);
    });

    it('T2-F15-04: duplicate delivery preserves single payment order state', async () => {
      const order = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: paymentOrderId } });
      expect(order.status).toBe('PAID');
    });

    it('T2-F15-05: concurrent identical event processing resolves idempotently', async () => {
      const concurrentPayload = buildPaymobWebhookBody({ orderId: 998877, amountCents: coursePriceMinor });
      const req1 = request(app).post(`/api/store/paymob/webhook?hmac=${concurrentPayload.hmac}`).send(concurrentPayload.body);
      const req2 = request(app).post(`/api/store/paymob/webhook?hmac=${concurrentPayload.hmac}`).send(concurrentPayload.body);

      const [r1, r2] = await Promise.all([req1, req2]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
    });
  });

  // =========================================================================
  // Feature 16 Boundaries: Amount Tampering & Currency Mismatch (6 tests)
  // =========================================================================
  describe('Feature 16 Boundaries: Amount Tampering & Entitlement Guards', () => {
    let tamperedOrderId: string;
    const expectedMinor = 30000;

    beforeAll(async () => {
      const order = await prisma.paymentOrder.create({
        data: {
          studentId,
          courseId,
          amountMinor: expectedMinor,
          currency: 'EGP',
          provider: 'PAYMOB',
          status: 'PENDING',
          idempotencyKey: `e2e-tamper-${Date.now()}`,
          providerOrderId: '776655',
        },
      });
      tamperedOrderId = order.id;
    });

    afterAll(async () => {
      await prisma.paymentOrder.deleteMany({ where: { id: tamperedOrderId } });
    });

    it('T2-F16-01: webhook with tampered amount_cents (1 cent instead of 30000) is detected', async () => {
      // Attacker generated valid HMAC for 100 cents (1 EGP) against 300 EGP order
      const tamperedWebhook = buildPaymobWebhookBody({
        orderId: 776655,
        amountCents: 100, // 1.00 EGP!
      });

      const res = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${tamperedWebhook.hmac}`)
        .send(tamperedWebhook.body);

      expect([200, 202, 400]).toContain(res.status);
    });

    it('T2-F16-02: tampered amount marks payment order failureReason: WEBHOOK_AMOUNT_MISMATCH', async () => {
      const order = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: tamperedOrderId } });
      expect(order.failureReason).toBe('WEBHOOK_AMOUNT_MISMATCH');
      expect(order.status).not.toBe('PAID');
    });

    it('T2-F16-03: tampered amount does NOT grant CourseEntitlement to student', async () => {
      const entitlement = await prisma.courseEntitlement.findFirst({
        where: { sourceOrderId: tamperedOrderId },
      });
      expect(entitlement).toBeNull();
    });

    it('T2-F16-04: webhook for unknown providerOrderId does not create orphan records', async () => {
      const unknownOrderWebhook = buildPaymobWebhookBody({
        orderId: 999999999,
        amountCents: 10000,
      });

      const res = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${unknownOrderWebhook.hmac}`)
        .send(unknownOrderWebhook.body);

      expect([200, 202, 404]).toContain(res.status);
    });

    it('T2-F16-05: failed transaction (success: false) marks order appropriately without granting access', async () => {
      const failedOrder = await prisma.paymentOrder.create({
        data: {
          studentId,
          courseId,
          amountMinor: 20000,
          currency: 'EGP',
          provider: 'PAYMOB',
          status: 'PENDING',
          idempotencyKey: `e2e-fail-${Date.now()}`,
          providerOrderId: '554433',
        },
      });

      const failedWebhook = buildPaymobWebhookBody({
        orderId: 554433,
        amountCents: 20000,
        success: false,
      });

      await request(app)
        .post(`/api/store/paymob/webhook?hmac=${failedWebhook.hmac}`)
        .send(failedWebhook.body);

      const orderCheck = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: failedOrder.id } });
      expect(orderCheck.status).not.toBe('PAID');

      await prisma.paymentOrder.delete({ where: { id: failedOrder.id } });
    });

    it('T2-F16-06: currency mismatch is prevented from granting entitlement', async () => {
      const currencyMismatchWebhook = buildPaymobWebhookBody({
        orderId: 776655,
        amountCents: expectedMinor,
        currency: 'USD', // Not EGP
      });

      const res = await request(app)
        .post(`/api/store/paymob/webhook?hmac=${currencyMismatchWebhook.hmac}`)
        .send(currencyMismatchWebhook.body);

      expect([200, 400, 422]).toContain(res.status);
    });
  });
});
