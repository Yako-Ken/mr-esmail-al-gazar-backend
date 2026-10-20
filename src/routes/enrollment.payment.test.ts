import request from 'supertest';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import app from '../app';

import prisma from '../config/prisma';

/**
 * Enrollment approval must reflect money for paid courses.
 *
 * A teacher could previously flip any enrollment to APPROVED with no payment
 * check at all, which grants paid course content access for free. This suite
 * pins the rule:
 *   - free course  -> teacher may approve freely (manual scholarship/enrolment)
 *   - paid course  -> APPROVED requires a PAID PaymentOrder for that pair
 *
 * Everything is asserted over HTTP so the contract is the observable API, not
 * the controller's internals.
 */

const TEACHER = { phone: '01000000301', role: 'TEACHER' as const };
const STUDENT_FREE = { phone: '01000000302', role: 'STUDENT' as const };
const STUDENT_PAID = { phone: '01000000303', role: 'STUDENT' as const };
const PASSWORD = 'Enroll@2026';

const PHONES = [TEACHER.phone, STUDENT_FREE.phone, STUDENT_PAID.phone];
const tokens: Record<string, string> = {};

const suffix = Date.now();
const FREE_COURSE = { title: `FreeCourse-${suffix}`, priceMinor: 0 };
const PAID_COURSE = { title: `PaidCourse-${suffix}`, priceMinor: 25000 };

const login = async (phone: string): Promise<string> => {
  const res = await request(app)
    .post('/api/auth/login')
    .set('X-Device-Name', 'enrollment-payment')
    .send({ identifier: phone, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.token as string;
};

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let teacherId: string;

beforeAll(async () => {
  // Dependency-ordered cleanup so a re-run never trips a foreign key from a
  // previous aborted run: orders -> enrollments -> courses -> users.
  const staleCourses = await prisma.course.findMany({
    where: { title: { in: [FREE_COURSE.title, PAID_COURSE.title] } },
    select: { id: true },
  });
  const staleIds = staleCourses.map((c) => c.id);
  if (staleIds.length > 0) {
    await prisma.paymentOrder.deleteMany({ where: { courseId: { in: staleIds } } });
    await prisma.courseEnrollment.deleteMany({ where: { courseId: { in: staleIds } } });
    await prisma.lessonProgress.deleteMany({ where: { courseId: { in: staleIds } } });
    await prisma.course.deleteMany({ where: { id: { in: staleIds } } });
  }
// Users are upserted, not deleted. CourseEnrollment.studentId has no onDelete
  // action, so deleting a user that owns an enrollment is rejected by the
  // database. Upserting keeps the suite re-runnable without leaving residue.
  const upserted: Record<string, string> = {};
  for (const u of [TEACHER, STUDENT_FREE, STUDENT_PAID]) {
    const row = await prisma.user.upsert({
      where: { phone: u.phone },
      update: {
        role: u.role,
        status: 'approved',
        isApproved: true,
        password: await bcrypt.hash(PASSWORD, 10),
      },
      create: {
        name: `Enroll ${u.role}`,
        phone: u.phone,
        email: `enroll-${u.phone}@example.com`,
        password: await bcrypt.hash(PASSWORD, 10),
        role: u.role,
        status: 'approved',
        isApproved: true,
      },
    });
    upserted[u.phone] = row.id;
    tokens[u.phone] = await login(u.phone);
  }

  const teacher = { id: upserted[TEACHER.phone] };
  teacherId = teacher!.id;

  for (const c of [FREE_COURSE, PAID_COURSE]) {
    await prisma.course.create({
      data: {
        teacherId,
        title: c.title,
        price: c.priceMinor / 100,
        priceMinor: c.priceMinor,
        currency: 'EGP',
        isPublished: true,
      },
    });
  }

  for (const [student, course] of [
    [STUDENT_FREE, FREE_COURSE],
    [STUDENT_PAID, PAID_COURSE],
  ] as const) {
    const s = await prisma.user.findUnique({ where: { phone: student.phone } });
    const c = await prisma.course.findFirst({ where: { title: course.title } });
    await prisma.courseEnrollment.create({
      data: {
        studentId: s!.id,
        courseId: c!.id,
        status: 'PENDING',
        paymentMethod: 'TEACHER_MANUAL',
      },
    });
  }
});

afterAll(async () => {
  // Only course-side fixtures are removed. The users are intentionally left in
  // place: CourseEnrollment.studentId has no onDelete action, so removing them
  // would fail. Leaving three approved test users is harmless and keeps the
  // suite idempotent.
  const paidCourse = await prisma.course.findFirst({ where: { title: PAID_COURSE.title } });
  if (paidCourse) {
    await prisma.paymentOrder.deleteMany({ where: { courseId: paidCourse.id } });
    await prisma.courseEnrollment.deleteMany({ where: { courseId: paidCourse.id } });
  }
  const freeCourse = await prisma.course.findFirst({ where: { title: FREE_COURSE.title } });
  if (freeCourse) {
    await prisma.courseEnrollment.deleteMany({ where: { courseId: freeCourse.id } });
  }
  await prisma.course.deleteMany({ where: { title: { in: [FREE_COURSE.title, PAID_COURSE.title] } } });
  await prisma.$disconnect();
});

const enrollmentFor = async (studentPhone: string, courseTitle: string) => {
  const student = await prisma.user.findUnique({ where: { phone: studentPhone } });
  const course = await prisma.course.findFirst({ where: { title: courseTitle } });
  return prisma.courseEnrollment.findFirstOrThrow({
    where: { studentId: student!.id, courseId: course!.id },
  });
};

describe('PUT /api/teachers/enrollments/:id requires verified payment for paid courses', () => {
  it('blocks APPROVED on a paid course with no PAID order', async () => {
    const enrollment = await enrollmentFor(STUDENT_PAID.phone, PAID_COURSE.title);
    expect(enrollment.status).toBe('PENDING');

    const res = await request(app)
      .put(`/api/teachers/enrollments/${enrollment.id}`)
      .set(bearer(tokens[TEACHER.phone]))
      .send({ status: 'APPROVED' });

    expect(res.status).toBe(403);

    const after = await prisma.courseEnrollment.findUnique({ where: { id: enrollment.id } });
    expect(after?.status).toBe('PENDING');
  });

  it('blocks APPROVED when an order exists but is still PENDING', async () => {
    const student = await prisma.user.findUnique({ where: { phone: STUDENT_PAID.phone } });
    const course = await prisma.course.findFirst({ where: { title: PAID_COURSE.title } });

    await prisma.paymentOrder.create({
      data: {
        studentId: student!.id,
        courseId: course!.id,
        amountMinor: PAID_COURSE.priceMinor,
        currency: 'EGP',
        provider: 'PAY',
        status: 'PENDING',
        idempotencyKey: `pending-${suffix}`,
      },
    });

    const enrollment = await enrollmentFor(STUDENT_PAID.phone, PAID_COURSE.title);
    const res = await request(app)
      .put(`/api/teachers/enrollments/${enrollment.id}`)
      .set(bearer(tokens[TEACHER.phone]))
      .send({ status: 'APPROVED' });

    expect(res.status).toBe(403);
  });

  it('allows APPROVED once a PAID order exists', async () => {
    const student = await prisma.user.findUnique({ where: { phone: STUDENT_PAID.phone } });
    const course = await prisma.course.findFirst({ where: { title: PAID_COURSE.title } });

    await prisma.paymentOrder.updateMany({
      where: { idempotencyKey: `pending-${suffix}` },
      data: { status: 'PAID', paidAt: new Date() },
    });

    const enrollment = await enrollmentFor(STUDENT_PAID.phone, PAID_COURSE.title);
    const res = await request(app)
      .put(`/api/teachers/enrollments/${enrollment.id}`)
      .set(bearer(tokens[TEACHER.phone]))
      .send({ status: 'APPROVED' });

    expect(res.status).toBe(200);
    expect(res.body.enrollment.status).toBe('APPROVED');
  });

  it('still lets a teacher approve a free course without any order', async () => {
    const enrollment = await enrollmentFor(STUDENT_FREE.phone, FREE_COURSE.title);

    const res = await request(app)
      .put(`/api/teachers/enrollments/${enrollment.id}`)
      .set(bearer(tokens[TEACHER.phone]))
      .send({ status: 'APPROVED' });

    expect(res.status).toBe(200);
    expect(res.body.enrollment.status).toBe('APPROVED');
  });

  it('still allows REJECTED on a paid course without a paid order', async () => {
// Rejecting must never be blocked: it is the safe direction of travel.
    // Use the free-course student so the (studentId, courseId) pair is unique.
    const student = await prisma.user.findUnique({ where: { phone: STUDENT_FREE.phone } });
    const course = await prisma.course.findFirst({ where: { title: PAID_COURSE.title } });
    const extra = await prisma.courseEnrollment.create({
      data: {
        studentId: student!.id,
        courseId: course!.id,
        status: 'PENDING',
        paymentMethod: 'TEACHER_MANUAL',
      },
    });

    const res = await request(app)
      .put(`/api/teachers/enrollments/${extra.id}`)
      .set(bearer(tokens[TEACHER.phone]))
      .send({ status: 'REJECTED' });

    expect(res.status).toBe(200);
    expect(res.body.enrollment.status).toBe('REJECTED');
  });

  it('does not leak payment details in the rejection response', async () => {
    const enrollment = await enrollmentFor(STUDENT_PAID.phone, PAID_COURSE.title);
    const res = await request(app)
      .put(`/api/teachers/enrollments/${enrollment.id}`)
      .set(bearer(tokens[TEACHER.phone]))
      .send({ status: 'APPROVED' });

    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/amountMinor|checkoutUrl|providerOrderId/);
  });
});

