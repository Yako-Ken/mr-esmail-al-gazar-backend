import request from 'supertest';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import app from '../app';

const prisma = new PrismaClient();

const teacherPhone = '01020202021';
const otherTeacherPhone = '01020202022';
const studentPhone = '01020202023';
let teacherToken = '';
let otherTeacherToken = '';
let studentToken = '';
let courseId = '';
let otherCourseId = '';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const login = async (phone: string, password: string): Promise<string> => {
  const response = await request(app)
    .post('/api/auth/login')
    .set('X-Device-Name', 'Settlements test device')
    .send({ identifier: phone, password });
  expect(response.status).toBe(200);
  return response.body.token as string;
};

beforeAll(async () => {
  await prisma.user.deleteMany({
    where: { phone: { in: [teacherPhone, otherTeacherPhone, studentPhone] } },
  });

  const teacher = await prisma.user.create({
    data: {
      name: 'مدرس التسويات',
      phone: teacherPhone,
      password: await bcrypt.hash('Settle@2026', 12),
      role: 'TEACHER',
      status: 'approved',
      isApproved: true,
    },
  });
  const otherTeacher = await prisma.user.create({
    data: {
      name: 'مدرس آخر',
      phone: otherTeacherPhone,
      password: await bcrypt.hash('Other@2026', 12),
      role: 'TEACHER',
      status: 'approved',
      isApproved: true,
    },
  });
  const student = await prisma.user.create({
    data: {
      name: 'طالب التسويات',
      phone: studentPhone,
      password: await bcrypt.hash('StudentS@2026', 12),
      role: 'STUDENT',
      status: 'approved',
      isApproved: true,
    },
  });

  const course = await prisma.course.create({
    data: { teacherId: teacher.id, title: 'كورس مدرس التسويات', priceMinor: 30000 },
  });
  courseId = course.id;
  const otherCourse = await prisma.course.create({
    data: {
      teacherId: otherTeacher.id,
      title: 'كورس المدرس الآخر',
      priceMinor: 50000,
    },
  });
  otherCourseId = otherCourse.id;

  const base = {
    studentId: student.id,
    currency: 'EGP',
    provider: 'PAYMOB',
  };
  // Teacher's course: two paid orders (one this month, one older) + refund.
  const paid1 = await prisma.paymentOrder.create({
    data: {
      ...base,
      courseId,
      amountMinor: 30000,
      status: 'PAID',
      idempotencyKey: 'settle-paid-1',
      paidAt: new Date(),
    },
  });
  const paid2 = await prisma.paymentOrder.create({
    data: {
      ...base,
      courseId,
      amountMinor: 30000,
      status: 'PAID',
      idempotencyKey: 'settle-paid-2',
      paidAt: new Date('2026-01-15'),
    },
  });
  await prisma.paymentOrder.create({
    data: {
      ...base,
      courseId,
      amountMinor: 30000,
      status: 'PENDING',
      idempotencyKey: 'settle-pending-1',
    },
  });
  // Confirmed refund on paid1, requested refund on paid2.
  await prisma.refund.create({
    data: {
      paymentOrderId: paid1.id,
      amountMinor: 30000,
      currency: 'EGP',
      status: 'REFUNDED',
      reason: 'استرداد مؤكد',
    },
  });
  await prisma.refund.create({
    data: {
      paymentOrderId: paid2.id,
      amountMinor: 30000,
      currency: 'EGP',
      status: 'REQUESTED',
      reason: 'قيد المراجعة',
    },
  });
  // Other teacher's paid order must never leak into the first teacher's ledger.
  await prisma.paymentOrder.create({
    data: {
      ...base,
      courseId: otherCourseId,
      amountMinor: 50000,
      status: 'PAID',
      idempotencyKey: 'settle-other-1',
      paidAt: new Date(),
    },
  });

  teacherToken = await login(teacherPhone, 'Settle@2026');
  otherTeacherToken = await login(otherTeacherPhone, 'Other@2026');
  studentToken = await login(studentPhone, 'StudentS@2026');
});

afterAll(async () => {
  await prisma.refund.deleteMany({});
  await prisma.paymentOrder.deleteMany({});
  await prisma.course.deleteMany({});
  await prisma.user.deleteMany({
    where: { phone: { in: [teacherPhone, otherTeacherPhone, studentPhone] } },
  });
  await prisma.$disconnect();
});

describe('teacher settlements', () => {
  it('rejects unauthenticated and non-teacher access', async () => {
    expect(
      (await request(app).get('/api/teachers/payments/settlements')).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .get('/api/teachers/payments/settlements')
          .set(bearer(studentToken))
      ).status,
    ).toBe(403);
  });

  it('computes gross, confirmed refunds, pending refunds, and net', async () => {
    const response = await request(app)
      .get('/api/teachers/payments/settlements')
      .set(bearer(teacherToken));
    expect(response.status).toBe(200);
    expect(response.body.currency).toBe('EGP');
    expect(response.body.summary).toMatchObject({
      grossPaidMinor: 60000, // two paid orders
      refundedConfirmedMinor: 30000, // confirmed only
      refundPendingMinor: 30000, // requested shown separately
      netMinor: 30000, // gross - confirmed
    });
    expect(response.body.summary.grossThisMonthMinor).toBe(30000); // only paid1
  });

  it('breaks earnings down per course with order counts', async () => {
    const response = await request(app)
      .get('/api/teachers/payments/settlements')
      .set(bearer(teacherToken));
    expect(response.body.perCourse).toHaveLength(1);
    expect(response.body.perCourse[0]).toMatchObject({
      courseTitle: 'كورس مدرس التسويات',
      ordersCount: 2,
      paidMinor: 60000,
      refundedMinor: 30000,
    });
    expect(response.body.recentOrders.length).toBeGreaterThanOrEqual(2);
    expect(response.body.disclaimer).toBeTruthy();
  });

  it('isolates teachers: no other teacher orders leak in', async () => {
    const mine = await request(app)
      .get('/api/teachers/payments/settlements')
      .set(bearer(otherTeacherToken));
    expect(mine.status).toBe(200);
    expect(mine.body.summary.grossPaidMinor).toBe(50000);
    expect(JSON.stringify(mine.body)).not.toContain('كورس مدرس التسويات');

    const theirs = await request(app)
      .get('/api/teachers/payments/settlements')
      .set(bearer(teacherToken));
    expect(JSON.stringify(theirs.body)).not.toContain('كورس المدرس الآخر');
  });
});
