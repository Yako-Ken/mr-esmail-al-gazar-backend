import request from 'supertest';
import app from '../../../src/app';
import prisma from '../../../src/config/prisma';
import {
  buildPaymobWebhookBody,
  cleanE2EData,
  ensureE2EUser,
} from '../helpers/test-helper';

const PHONES = {
  teacher: '01000008841',
  student: '01000008842',
};

describe('Tier 4 Scenario 3: Payment & Entitlement Resilience Drill', () => {
  let teacherId: string;
  let studentId: string;
  let courseId: string;
  let orderId: string;
  let validWebhook: ReturnType<typeof buildPaymobWebhookBody>;
  const coursePriceMinor = 45000; // 450.00 EGP

  beforeAll(async () => {
    await cleanE2EData(Object.values(PHONES));

    const teacher = await ensureE2EUser({
      phone: PHONES.teacher,
      role: 'TEACHER',
      name: 'Resilience Pay Teacher',
    });
    teacherId = teacher.id;

    const student = await ensureE2EUser({
      phone: PHONES.student,
      role: 'STUDENT',
      name: 'Resilience Pay Student',
    });
    studentId = student.id;

    const course = await prisma.course.create({
      data: {
        teacherId,
        title: 'High-Stakes Resilience Course',
        priceMinor: coursePriceMinor,
        currency: 'EGP',
        isPublished: true,
      },
    });
    courseId = course.id;
  }, 60000);

  afterAll(async () => {
    if (orderId) {
      await prisma.paymentEvent.deleteMany({ where: { paymentOrderId: orderId } });
      await prisma.paymentAttempt.deleteMany({ where: { paymentOrderId: orderId } });
      await prisma.courseEntitlement.deleteMany({ where: { sourceOrderId: orderId } });
    }
    await cleanE2EData(Object.values(PHONES), [courseId]);
    await prisma.$disconnect();
  });

  // =========================================================================
  // Scenario 3: Payment Resilience Drill
  // =========================================================================
  it('Step 1: Student creates checkout order and records pending PaymentOrder', async () => {
    const order = await prisma.paymentOrder.create({
      data: {
        studentId,
        courseId,
        amountMinor: coursePriceMinor,
        currency: 'EGP',
        provider: 'PAYMOB',
        status: 'PENDING',
        idempotencyKey: `resilience-order-${Date.now()}`,
        providerOrderId: '665544',
      },
    });
    orderId = order.id;
    await prisma.paymentAttempt.create({
      data: { paymentOrderId: order.id },
    });

    expect(order.status).toBe('PENDING');
    expect(order.amountMinor).toBe(coursePriceMinor);
  });

  it('Step 2: Gateway sends authentic HMAC webhook; system approves enrollment and creates entitlement', async () => {
    validWebhook = buildPaymobWebhookBody({
      orderId: '665544',
      amountCents: coursePriceMinor,
      currency: 'EGP',
    });

    const res = await request(app)
      .post(`/api/store/paymob/webhook?hmac=${validWebhook.hmac}`)
      .send(validWebhook.body);

    expect([200, 202]).toContain(res.status);

    // Verify order is PAID
    const order = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PAID');
    expect(order.paidAt).toBeInstanceOf(Date);

    // Verify entitlement is ACTIVE
    const entitlement = await prisma.courseEntitlement.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
    });
    expect(entitlement?.status).toBe('ACTIVE');

    // Verify enrollment is APPROVED
    const enrollment = await prisma.courseEnrollment.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
    });
    expect(enrollment?.status).toBe('APPROVED');
  });

  it('Step 3: Network retry sends duplicate webhook; idempotency cleanly deduplicates without creating extra rows', async () => {
    const res = await request(app)
      .post(`/api/store/paymob/webhook?hmac=${validWebhook.hmac}`)
      .send(validWebhook.body);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    // Verify exactly one entitlement and one enrollment exist
    const entitlements = await prisma.courseEntitlement.findMany({
      where: { studentId, courseId },
    });
    expect(entitlements.length).toBe(1);

    const enrollments = await prisma.courseEnrollment.findMany({
      where: { studentId, courseId },
    });
    expect(enrollments.length).toBe(1);
  });

  it('Step 4: Price tampering attempt with 1-cent payment is detected and entitlement is withheld', async () => {
    // Create new pending order for tampering drill
    const tamperOrder = await prisma.paymentOrder.create({
      data: {
        studentId,
        courseId,
        amountMinor: 35000, // 350 EGP
        currency: 'EGP',
        provider: 'PAYMOB',
        status: 'PENDING',
        idempotencyKey: `resilience-tamper-${Date.now()}`,
        providerOrderId: '112233',
      },
    });
    await prisma.paymentAttempt.create({
      data: { paymentOrderId: tamperOrder.id },
    });

    // Attacker sends 100 cents (1 EGP)
    const tamperedWebhook = buildPaymobWebhookBody({
      orderId: '112233',
      amountCents: 100,
    });

    await request(app)
      .post(`/api/store/paymob/webhook?hmac=${tamperedWebhook.hmac}`)
      .send(tamperedWebhook.body);

    const checkOrder = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: tamperOrder.id } });
    expect(checkOrder.failureReason).toBe('WEBHOOK_AMOUNT_MISMATCH');
    expect(checkOrder.status).not.toBe('PAID');

    await prisma.paymentAttempt.deleteMany({ where: { paymentOrderId: tamperOrder.id } });
    await prisma.paymentOrder.delete({ where: { id: tamperOrder.id } });
  });

  it('Step 5: Audit logs verify PaymentAttempt and PaymentEvent consistency', async () => {
    const attempts = await prisma.paymentAttempt.findMany({
      where: { paymentOrderId: orderId },
    });
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(attempts[0].status).toBe('SUCCEEDED');

    const events = await prisma.paymentEvent.findMany({
      where: { paymentOrderId: orderId },
    });
    expect(events.length).toBe(1);
    expect(events[0].externalEventId).toContain('paymob:');
  });
});
