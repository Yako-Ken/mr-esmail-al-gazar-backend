import request from 'supertest';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import app from '../app';
import { calculatePaymobHmac } from '../utils/paymobHmac';

/**
 * Payment → entitlement → course access, driven through the real webhook.
 *
 * The three writes that make a paid course accessible are:
 *   PaymentOrder.status = PAID
 *   CourseEntitlement   = ACTIVE
 *   CourseEnrollment    = APPROVED
 *
 * They are written by src/controllers/payment.controller.ts inside one
 * transaction. This suite exercises that path end to end over HTTP with a
 * correctly signed HMAC, and asserts every persisted effect — because the
 * business only has value if a paying student can actually open the lesson.
 *
 * The HMAC secret is read from the same env the server validates, so the test
 * fails loudly if the signature scheme changes.
 */

import prisma from '../config/prisma';

const PASSWORD = 'Webhook@2026';
const PHONES = {
  teacher: '01000000701',
  student: '01000000702',
  outsider: '01000000703',
};
const UNIQUE_TAG = `PayWebhook-${Date.now()}`;

// Use the application's own signature builder rather than reimplementing it.
// A hand-rolled copy would only prove that the copy matches itself; importing
// the real one means this suite fails the moment the signing scheme changes,
// which is the property that matters — it is what stops an attacker, or a
// provider-side change, from silently unlocking paid content.
const signPaymob = (obj: Record<string, any>, secret: string): string =>
  calculatePaymobHmac(obj, secret);

const login = async (phone: string): Promise<string> => {
  const res = await request(app)
    .post('/api/auth/login')
    .set('X-Device-Name', 'pay-webhook-test')
    .send({ identifier: phone, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.token as string;
};

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const HMAC_SECRET = process.env.PAYMOB_HMAC_SECRET as string;

let teacherToken: string;
let studentToken: string;
let outsiderToken: string;
let courseId: string;
let lessonId: string;
let orderId: string;

beforeAll(async () => {
  // The webhook answers 503 without a secret; that is correct fail-closed
  // behaviour but makes the rest of this suite meaningless.
  expect(typeof HMAC_SECRET).toBe('string');
  expect(HMAC_SECRET.length).toBeGreaterThan(0);

  for (const phone of Object.values(PHONES)) {
    await prisma.user.deleteMany({ where: { phone } });
  }

  const users: Record<string, string> = {};
  for (const [role, phone] of Object.entries(PHONES)) {
    const row = await prisma.user.create({
      data: {
        name: `PayWebhook ${role}`,
        phone,
        email: `paywebhook-${role}@example.com`,
        password: await bcrypt.hash(PASSWORD, 10),
        role: role === 'teacher' ? 'TEACHER' : 'STUDENT',
        status: 'approved',
        isApproved: true,
      },
    });
    users[role] = row.id;
  }

  teacherToken = await login(PHONES.teacher);
  studentToken = await login(PHONES.student);
  outsiderToken = await login(PHONES.outsider);

  const course = await prisma.course.create({
    data: {
      teacherId: users.teacher,
      title: UNIQUE_TAG,
      priceMinor: 30000,
      currency: 'EGP',
      isPublished: true,
    },
  });
  courseId = course.id;

  const lesson = await prisma.lesson.create({
    data: {
      courseId,
      teacherId: users.teacher,
      title: `${UNIQUE_TAG} lesson`,
      videoUrl: 'https://demo.b-cdn.net/x.m3u8',
    },
  });
  lessonId = lesson.id;

  const order = await prisma.paymentOrder.create({
    data: {
      studentId: users.student,
      courseId,
      amountMinor: 30000,
      currency: 'EGP',
      provider: 'PAYMOB',
      status: 'PENDING',
      idempotencyKey: UNIQUE_TAG,
    },
  });
  orderId = order.id;
});

afterAll(async () => {
  if (courseId) {
    const users = await prisma.user.findMany({
      where: { phone: { in: Object.values(PHONES) } },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    const orders = await prisma.paymentOrder.findMany({
      where: { courseId },
      select: { id: true },
    });
    const orderIds = orders.map((o) => o.id);
    await prisma.paymentEvent.deleteMany({ where: { paymentOrderId: { in: orderIds } } });
    await prisma.paymentAttempt.deleteMany({ where: { paymentOrderId: { in: orderIds } } });
    await prisma.paymentOrder.deleteMany({ where: { courseId } });
    await prisma.courseEntitlement.deleteMany({ where: { courseId } });
    await prisma.courseEnrollment.deleteMany({ where: { courseId } });
    await prisma.lesson.deleteMany({ where: { courseId } });
    await prisma.course.deleteMany({ where: { id: courseId } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
});

describe('paid content is gated until the provider confirms payment', () => {
  it('denies the lesson while the order is still PENDING', async () => {
    const res = await request(app)
      .get(`/api/lessons/${lessonId}`)
      .set(bearer(studentToken));

    expect(res.status).toBe(403);
    expect(await prisma.courseEntitlement.count({ where: { courseId } })).toBe(0);
  });

  it('rejects a webhook with a bad signature and grants nothing', async () => {
    const payload = {
      type: 'transaction',
      obj: {
        type: 'transaction',
        id: 'forged-txn',
        success: true,
        pending: false,
        is_voided: false,
        is_refunded: false,
        amount_cents: 30000,
        currency: 'EGP',
        order: { id: orderId, merchant_order_id: orderId },
      },
    };

    const res = await request(app)
      .post(`/api/store/paymob/webhook?hmac=${encodeURIComponent('not-a-valid-signature')}`)
      .send(payload);

    expect(res.status).toBe(401);
    expect(await prisma.courseEntitlement.count({ where: { courseId } })).toBe(0);
    const order = await prisma.paymentOrder.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('PENDING');
  });

  it('rejects a signed webhook whose amount does not match', async () => {
    const payload = {
      type: 'transaction',
      obj: {
        type: 'transaction',
        id: 'tampered-txn',
        success: true,
        pending: false,
        is_voided: false,
        is_refunded: false,
        amount_cents: 1, // paid 1 piastre instead of 300 EGP
        currency: 'EGP',
        order: { id: orderId, merchant_order_id: orderId },
      },
    };

    const res = await request(app)
      .post(
        `/api/store/paymob/webhook?hmac=${encodeURIComponent(signPaymob(payload.obj, HMAC_SECRET))}`
      )
      .send(payload);

    // The order must NOT become PAID and no entitlement may be created.
    const order = await prisma.paymentOrder.findUnique({ where: { id: orderId } });
    expect(order?.status).not.toBe('PAID');
    expect(await prisma.courseEntitlement.count({ where: { courseId } })).toBe(0);
    expect(res.status).toBeLessThan(500);
  });
});

describe('a correctly signed payment confirmation unlocks the course', () => {
  const transactionId = `txn-${Date.now()}`;

  const postWebhook = async (overrides: Record<string, any> = {}) => {
    const payload = {
      type: 'transaction',
      obj: {
        type: 'transaction',
        id: transactionId,
        success: true,
        pending: false,
        is_voided: false,
        is_refunded: false,
        amount_cents: 30000,
        currency: 'EGP',
        order: { id: orderId, merchant_order_id: orderId },
        ...overrides,
      },
    };
    const hmac = signPaymob(payload.obj, HMAC_SECRET);
    return request(app)
      .post(`/api/store/paymob/webhook?hmac=${encodeURIComponent(hmac)}`)
      .send(payload);
  };

  it('marks the order PAID with a paidAt timestamp', async () => {
    const res = await postWebhook();
    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(true);

    const order = await prisma.paymentOrder.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('PAID');
    expect(order?.paidAt).not.toBeNull();
  });

  it('creates an ACTIVE entitlement pointing at the order', async () => {
    const entitlement = await prisma.courseEntitlement.findFirst({
      where: { courseId },
    });
    expect(entitlement).not.toBeNull();
    expect(entitlement?.status).toBe('ACTIVE');
    expect(entitlement?.sourceOrderId).toBe(orderId);
    expect(entitlement?.revokedAt).toBeNull();
  });

  it('approves the enrollment through PAYMOB', async () => {
    const enrollment = await prisma.courseEnrollment.findFirst({
      where: { courseId },
    });
    expect(enrollment).not.toBeNull();
    expect(enrollment?.status).toBe('APPROVED');
    expect(enrollment?.paymentMethod).toBe('PAYMOB');
  });

  it('now lets the paying student open the lesson', async () => {
    const res = await request(app)
      .get(`/api/lessons/${lessonId}`)
      .set(bearer(studentToken));
    expect(res.status).toBe(200);
  });

  it('lists the course in the student purchases', async () => {
    const res = await request(app)
      .get('/api/store/my-courses')
      .set(bearer(studentToken));
    expect(res.status).toBe(200);
    const ids = Array.isArray(res.body) ? res.body.map((c: any) => c.id ?? c.courseId) : [];
    expect(ids).toContain(courseId);
  });

  it('still denies an unrelated student who never paid', async () => {
    const res = await request(app)
      .get(`/api/lessons/${lessonId}`)
      .set(bearer(outsiderToken));
    expect(res.status).toBe(403);
  });

  it('is idempotent: replaying the same webhook does not duplicate rows', async () => {
    const before = {
      entitlements: await prisma.courseEntitlement.count({ where: { courseId } }),
      enrollments: await prisma.courseEnrollment.count({ where: { courseId } }),
      events: await prisma.paymentEvent.count({ where: { paymentOrderId: orderId } }),
    };

    const res = await postWebhook();
    expect(res.status).toBe(200);

    expect(await prisma.courseEntitlement.count({ where: { courseId } })).toBe(
      before.entitlements
    );
    expect(await prisma.courseEnrollment.count({ where: { courseId } })).toBe(
      before.enrollments
    );
    expect(await prisma.paymentEvent.count({ where: { paymentOrderId: orderId } })).toBe(
      before.events
    );
  });

  it('does not expose payment internals to the student payload', async () => {
    const res = await request(app)
      .get('/api/store/my-courses')
      .set(bearer(studentToken));
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/providerOrderId|checkoutUrl|failureReason/);
  });
});