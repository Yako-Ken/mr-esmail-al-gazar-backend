import request from 'supertest';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import app from '../../../src/app';
import prisma from '../../../src/config/prisma';
import { calculatePaymobHmac } from '../../../src/utils/paymobHmac';

export const E2E_PASSWORD = 'E2EPassword@2026';
export const E2E_JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret-not-for-production-use-01234';
export const E2E_HMAC_SECRET = process.env.PAYMOB_HMAC_SECRET || 'test-only-paymob-hmac-secret-0123456789';

export const authHeader = (token: string) => ({
  Authorization: `Bearer ${token}`,
});

export const loginUser = async (
  phone: string,
  password = E2E_PASSWORD,
  device = 'e2e-test-device',
): Promise<{ token: string; user: any }> => {
  const res = await request(app)
    .post('/api/auth/login')
    .set('X-Device-Name', device)
    .send({ phone, identifier: phone, password });

  if (res.status !== 200) {
    throw new Error(`Login failed for ${phone} with status ${res.status}: ${JSON.stringify(res.body)}`);
  }

  return { token: res.body.token, user: res.body.user };
};

export const ensureE2EUser = async (opts: {
  phone: string;
  role: 'STUDENT' | 'TEACHER' | 'ASSISTANT' | 'PARENT' | 'SUPER_ADMIN' | 'ADMIN';
  name?: string;
  email?: string;
  password?: string;
  isApproved?: boolean;
  status?: string;
  parentTeacherId?: string;
}): Promise<{ id: string; phone: string; role: string }> => {
  const existing = await prisma.user.findUnique({ where: { phone: opts.phone } });
  const hashedPassword = await bcrypt.hash(opts.password || E2E_PASSWORD, 10);

  if (existing) {
    const updated = await prisma.user.update({
      where: { id: existing.id },
      data: {
        role: opts.role,
        isApproved: opts.isApproved ?? true,
        status: opts.status || 'APPROVED',
        password: hashedPassword,
        parentTeacherId: opts.parentTeacherId,
      },
    });
    return { id: updated.id, phone: updated.phone, role: updated.role };
  }

  const created = await prisma.user.create({
    data: {
      phone: opts.phone,
      name: opts.name || `E2E ${opts.role} ${opts.phone.slice(-4)}`,
      email: opts.email || `e2e-${opts.role.toLowerCase()}-${opts.phone}@example.test`,
      password: hashedPassword,
      role: opts.role,
      isApproved: opts.isApproved ?? true,
      status: opts.status || 'APPROVED',
      parentTeacherId: opts.parentTeacherId,
    },
  });

  return { id: created.id, phone: created.phone, role: created.role };
};

export const cleanE2EData = async (phones: string[], courseIds: string[] = []): Promise<void> => {
  try {
    if (courseIds.length > 0) {
      await prisma.paymentOrder.deleteMany({ where: { courseId: { in: courseIds } } });
      await prisma.courseEntitlement.deleteMany({ where: { courseId: { in: courseIds } } });
      await prisma.courseEnrollment.deleteMany({ where: { courseId: { in: courseIds } } });
      await prisma.lessonProgress.deleteMany({ where: { courseId: { in: courseIds } } });
      await prisma.tracking.deleteMany({ where: { lesson: { courseId: { in: courseIds } } } });
      await prisma.quiz.deleteMany({ where: { lesson: { courseId: { in: courseIds } } } });
      await prisma.lesson.deleteMany({ where: { courseId: { in: courseIds } } });
      await prisma.course.deleteMany({ where: { id: { in: courseIds } } });
    }

    const users = await prisma.user.findMany({
      where: { phone: { in: phones } },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);

    if (userIds.length > 0) {
      await prisma.dataPrivacyRequest.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.attendanceRecord.deleteMany({
        where: {
          OR: [
            { studentId: { in: userIds } },
            { session: { ownerId: { in: userIds } } },
          ],
        },
      });
      await prisma.attendanceQrUse.deleteMany({ where: { studentId: { in: userIds } } });
      await prisma.attendanceSession.deleteMany({
        where: { ownerId: { in: userIds } },
      });

      const userOrders = await prisma.paymentOrder.findMany({
        where: { studentId: { in: userIds } },
        select: { id: true },
      });
      const userOrderIds = userOrders.map((o) => o.id);
      if (userOrderIds.length > 0) {
        await prisma.paymentAttempt.deleteMany({ where: { paymentOrderId: { in: userOrderIds } } });
        await prisma.paymentEvent.deleteMany({ where: { paymentOrderId: { in: userOrderIds } } });
      }

      await prisma.paymentOrder.deleteMany({ where: { studentId: { in: userIds } } });
      await prisma.courseEntitlement.deleteMany({ where: { studentId: { in: userIds } } });
      await prisma.courseEnrollment.deleteMany({
        where: { OR: [{ studentId: { in: userIds } }, { course: { teacherId: { in: userIds } } }] },
      });
      await prisma.lessonProgress.deleteMany({
        where: { OR: [{ studentId: { in: userIds } }, { course: { teacherId: { in: userIds } } }] },
      });
      await prisma.tracking.deleteMany({
        where: { OR: [{ studentId: { in: userIds } }, { lesson: { teacherId: { in: userIds } } }] },
      });
      await prisma.quiz.deleteMany({ where: { lesson: { teacherId: { in: userIds } } } });
      await prisma.lesson.deleteMany({
        where: { OR: [{ teacherId: { in: userIds } }, { course: { teacherId: { in: userIds } } }] },
      });
      await prisma.course.deleteMany({ where: { teacherId: { in: userIds } } });
      await prisma.pushToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.studentParentRelation.deleteMany({
        where: { OR: [{ studentId: { in: userIds } }, { parentId: { in: userIds } }] },
      });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  } catch (err) {
    // Graceful error logging in tests
    console.warn('cleanE2EData notice:', (err as Error).message);
  }
};

export const createSignedQrToken = (
  studentId: string,
  secret = E2E_JWT_SECRET,
  lifetimeSeconds = 30,
) => {
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { type: 'attendance' },
    secret,
    {
      algorithm: 'HS256',
      subject: studentId,
      jwtid: jti,
      issuer: 'esmail-elgazar-lms',
      audience: 'attendance-scanner',
      expiresIn: lifetimeSeconds,
    },
  );

  return { token, jti, lifetimeSeconds };
};

export const buildPaymobWebhookBody = (opts: {
  transactionId?: number;
  orderId: number | string;
  amountCents: number;
  currency?: string;
  success?: boolean;
}) => {
  const txnId = opts.transactionId ?? Math.floor(100000 + Math.random() * 900000);
  const now = new Date().toISOString();

  const obj = {
    id: txnId,
    pending: false,
    amount_cents: opts.amountCents,
    success: opts.success ?? true,
    is_auth: false,
    is_capture: false,
    is_standalone_payment: true,
    is_voided: false,
    is_refunded: false,
    is_3d_secure: true,
    integration_id: 12345,
    has_parent_transaction: false,
    currency: opts.currency || 'EGP',
    created_at: now,
    error_occured: false,
    owner: 98765,
    order: {
      id: typeof opts.orderId === 'string' ? parseInt(opts.orderId, 10) || 54321 : opts.orderId,
    },
    source_data: {
      pan: '2345',
      sub_type: 'MasterCard',
      type: 'card',
    },
  };

  const hmac = calculatePaymobHmac(obj, E2E_HMAC_SECRET);
  return { body: { obj, type: 'TRANSACTION' }, hmac, txnId };
};
