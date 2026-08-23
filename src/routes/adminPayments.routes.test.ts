import request from 'supertest';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import app from '../app';

const prisma = new PrismaClient();

const adminPhone = '01070707070';
const studentPhone = '01060606061';

let adminToken = '';
let studentToken = '';
let paidOrderId = '';
let pendingOrderId = '';
let failedOrderId = '';

const loginAs = async (phone: string, password: string): Promise<string> => {
  const response = await request(app)
    .post('/api/auth/login')
    .set('X-Device-Name', 'Admin payments test device')
    .send({ identifier: phone, password });
  expect(response.status).toBe(200);
  return response.body.token as string;
};

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { phone: { in: [adminPhone, studentPhone] } } });

  await prisma.user.create({
    data: {
      name: 'Admin Ops Test',
      phone: adminPhone,
      email: 'admin-payments-test@example.com',
      password: await bcrypt.hash('AdminOps@2026', 12),
      role: 'SUPER_ADMIN',
      status: 'approved',
      isApproved: true,
    },
  });
  const student = await prisma.user.create({
    data: {
      name: 'سلمى أحمد',
      phone: studentPhone,
      email: 'student-payments-test@example.com',
      password: await bcrypt.hash('StudentOps@2026', 12),
      role: 'STUDENT',
      status: 'approved',
      isApproved: true,
    },
  });
  const teacher = await prisma.user.create({
    data: {
      name: 'معلم الاختبار',
      phone: '01050505052',
      password: await bcrypt.hash('TeacherOps@2026', 12),
      role: 'TEACHER',
      status: 'approved',
      isApproved: true,
    },
  });
  const course = await prisma.course.create({
    data: {
      teacherId: teacher.id,
      title: 'مراجعة نهائية – إنجليزي',
      priceMinor: 40000,
      isPublished: true,
      publishedAt: new Date(),
    },
  });

  const baseOrder = {
    studentId: student.id,
    courseId: course.id,
    amountMinor: 40000,
    currency: 'EGP',
    provider: 'PAYMOB',
  };
  const paid = await prisma.paymentOrder.create({
    data: { ...baseOrder, status: 'PAID', idempotencyKey: 'test-paid-order-1', paidAt: new Date() },
  });
  pendingOrderId = (
    await prisma.paymentOrder.create({
      data: {
        ...baseOrder,
        amountMinor: 25000,
        status: 'PENDING',
        idempotencyKey: 'test-pending-order-1',
      },
    })
  ).id;
  failedOrderId = (
    await prisma.paymentOrder.create({
      data: {
        ...baseOrder,
        amountMinor: 30000,
        status: 'FAILED',
        idempotencyKey: 'test-failed-order-1',
        failureReason: 'PROVIDER_REJECTED',
      },
    })
  ).id;
  paidOrderId = paid.id;

  await prisma.paymentAttempt.create({
    data: { paymentOrderId: paid.id, status: 'SUCCESS', responseCode: '00' },
  });

  adminToken = await loginAs(adminPhone, 'AdminOps@2026');
  studentToken = await loginAs(studentPhone, 'StudentOps@2026');
});

afterAll(async () => {
  await prisma.adminAuditEvent.deleteMany({});
  await prisma.refund.deleteMany({});
  await prisma.paymentAttempt.deleteMany({});
  await prisma.paymentEvent.deleteMany({});
  await prisma.paymentOrder.deleteMany({});
  await prisma.course.deleteMany({});
  await prisma.user.deleteMany({
    where: { phone: { in: [adminPhone, studentPhone, '01050505052'] } },
  });
  await prisma.$disconnect();
});

describe('admin payments authorization', () => {
  it('rejects unauthenticated access', async () => {
    expect((await request(app).get('/api/admin/payments')).status).toBe(401);
    expect(
      (await request(app).post(`/api/admin/payments/${paidOrderId}/refund`)).status,
    ).toBe(401);
    expect((await request(app).get('/api/admin/audit-events')).status).toBe(401);
  });

  it('rejects non-admin roles', async () => {
    expect(
      (await request(app).get('/api/admin/payments').set(bearer(studentToken))).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/admin/payments/${paidOrderId}/refund`)
          .set(bearer(studentToken))
          .send({ reason: 'محاولة من غير مصرح' })
      ).status,
    ).toBe(403);
    expect(
      (await request(app).get('/api/admin/audit-events').set(bearer(studentToken))).status,
    ).toBe(403);
  });
});

describe('admin payments listing and detail', () => {
  it('lists orders newest first with masked phones and summary counts', async () => {
    const response = await request(app)
      .get('/api/admin/payments')
      .set(bearer(adminToken));
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(3);
    expect(response.body.orders[0].createdAt >= response.body.orders[1].createdAt).toBe(true);
    expect(response.body.summary).toMatchObject({ PAID: 1, PENDING: 1, FAILED: 1 });

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(studentPhone); // raw phone never leaves the server
    expect(serialized).toContain('سلمى أحمد');

    const order = response.body.orders.find(
      (item: { id: string }) => item.id === paidOrderId,
    );
    expect(order).toMatchObject({
      studentName: 'سلمى أحمد',
      courseTitle: 'مراجعة نهائية – إنجليزي',
      currency: 'EGP',
      status: 'PAID',
    });
  });

  it('filters by status', async () => {
    const response = await request(app)
      .get('/api/admin/payments')
      .query({ status: 'PAID' })
      .set(bearer(adminToken));
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.orders[0].id).toBe(paidOrderId);
  });

  it('returns 400 for invalid query params', async () => {
    const response = await request(app)
      .get('/api/admin/payments')
      .query({ status: 'HACKED', limit: 9999 })
      .set(bearer(adminToken));
    expect(response.status).toBe(400);
  });

  it('returns detail with attempts, events, and refunds', async () => {
    const response = await request(app)
      .get(`/api/admin/payments/${paidOrderId}`)
      .set(bearer(adminToken));
    expect(response.status).toBe(200);
    expect(response.body.order.status).toBe('PAID');
    expect(response.body.attempts).toHaveLength(1);
    expect(response.body.attempts[0].responseCode).toBe('00');
    expect(JSON.stringify(response.body)).not.toContain(studentPhone);

    const missing = await request(app)
      .get('/api/admin/payments/does-not-exist')
      .set(bearer(adminToken));
    expect(missing.status).toBe(404);
  });
});

describe('admin refunds with audit trail', () => {
  it('rejects invalid refund payloads', async () => {
    const shortReason = await request(app)
      .post(`/api/admin/payments/${paidOrderId}/refund`)
      .set(bearer(adminToken))
      .send({ reason: 'قص' });
    expect(shortReason.status).toBe(400);

    const unknownField = await request(app)
      .post(`/api/admin/payments/${paidOrderId}/refund`)
      .set(bearer(adminToken))
      .send({ reason: 'سبب كافٍ للقبول هنا', extra: true });
    expect(unknownField.status).toBe(400);
  });

  it('refuses refunds on unpaid orders', async () => {
    const pending = await request(app)
      .post(`/api/admin/payments/${pendingOrderId}/refund`)
      .set(bearer(adminToken))
      .send({ reason: 'الطالب لم يكمل الدفع أصلًا' });
    expect(pending.status).toBe(409);
    expect(pending.body.code).toBe('REFUND_NOT_ALLOWED');

    const failed = await request(app)
      .post(`/api/admin/payments/${failedOrderId}/refund`)
      .set(bearer(adminToken))
      .send({ reason: 'عملية فاشلة لا يمكن استردادها' });
    expect(failed.status).toBe(409);
  });

  it('creates a REQUESTED refund plus immutable audit event', async () => {
    const created = await request(app)
      .post(`/api/admin/payments/${paidOrderId}/refund`)
      .set(bearer(adminToken))
      .send({ reason: 'الطالب التحق بعد عملية مكررة بنفس البطاقة' });
    expect(created.status).toBe(201);
    expect(created.body.refund).toMatchObject({
      paymentOrderId: paidOrderId,
      amountMinor: 40000,
      currency: 'EGP',
      status: 'REQUESTED',
    });

    const audit = await request(app)
      .get('/api/admin/audit-events')
      .query({ category: 'finance' })
      .set(bearer(adminToken));
    expect(audit.status).toBe(200);
    expect(audit.body.events).toHaveLength(1);
    expect(audit.body.events[0]).toMatchObject({
      action: 'refund_initiated',
      category: 'finance',
      targetType: 'payment_order',
      targetId: paidOrderId,
      actorName: 'Admin Ops Test',
      actorRole: 'SUPER_ADMIN',
    });
  });

  it('replays the same active refund idempotently without duplicates', async () => {
    const replay = await request(app)
      .post(`/api/admin/payments/${paidOrderId}/refund`)
      .set(bearer(adminToken))
      .send({ reason: 'طلب مكرر بعد انقطاع الشبكة' });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);

    const list = await request(app).get('/api/admin/refunds').set(bearer(adminToken));
    expect(list.status).toBe(200);
    const forOrder = list.body.refunds.filter(
      (refund: { paymentOrderId: string }) => refund.paymentOrderId === paidOrderId,
    );
    expect(forOrder).toHaveLength(1);

    // The replay must NOT have added a second audit event
    const audit = await request(app)
      .get('/api/admin/audit-events')
      .query({ category: 'finance' })
      .set(bearer(adminToken));
    expect(audit.body.events).toHaveLength(1);
  });

  it('refunds a missing order with 404', async () => {
    const missing = await request(app)
      .post('/api/admin/payments/no-such-order/refund')
      .set(bearer(adminToken))
      .send({ reason: 'مرجع غير موجود في النظام إطلاقًا' });
    expect(missing.status).toBe(404);
  });
});
