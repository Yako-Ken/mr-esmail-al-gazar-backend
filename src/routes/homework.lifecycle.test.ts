import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import app from '../app';

/**
 * Homework lifecycle.
 *
 * These tests are written to fail against code that has no transition rules.
 * The schema already carried hwStatus/hwGrade/hwResubmitCount, so the fields
 * existed while nothing decided which moves were legal — a teacher could drag a
 * GRADED submission back to SUBMITTED and a student could resubmit forever.
 */

import prisma from '../config/prisma';

/**
 * Phone range 01000000920-924 is reserved for this file.
 *
 * Several suites already use 901-907 (authorizationMatrix, session.pruning,
 * upload.signature, pii.exposure). Jest runs suites in parallel workers against
 * one shared PostgreSQL, so two suites creating and then deleting the same
 * phone numbers corrupt each other mid-run: this file's fixtures overwrite
 * authorizationMatrix's and both fail in ways that look like product bugs. Each
 * suite must own a disjoint range.
 */
const P = {
  teacher: '01000000920',
  otherTeacher: '01000000921',
  student: '01000000922',
  student2: '01000000923',
  outsider: '01000000924',
};

const password = 'Lifecycle@2026';
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

const KEYS = ['teacher', 'otherTeacher', 'student', 'student2', 'outsider'] as const;
type Key = (typeof KEYS)[number];

let ids: Record<Key, string> = {} as Record<Key, string>;
let tokens: Record<Key, string> = {} as Record<Key, string>;
let lessonId = '';

const grade = (t: string) =>
  request(app).post('/api/auth/login').send({ phone: t, password });

async function login(phone: string): Promise<string> {
  const res = await grade(phone);
  expect(res.status).toBe(200);
  return res.body.token as string;
}

const post = (path: string, token: string) =>
  request(app).post(path).set(bearer(token));

const status = async (studentId: string) =>
  prisma.tracking.findUnique({
    where: { studentId_lessonId: { studentId, lessonId } },
  });

beforeAll(async () => {
  for (const key of KEYS) {
    const phone = P[key];
    const existing = await prisma.user.findUnique({ where: { phone } });
    if (!existing) {
      await prisma.user.create({
        data: {
phone,
          password: await bcrypt.hash(password, 10),
          status: 'APPROVED',
          role: key === 'teacher' || key === 'otherTeacher' ? 'TEACHER' : 'STUDENT',
          isApproved: true,
          name: key,
        },
      });
    }
    ids[key] = (await prisma.user.findUniqueOrThrow({ where: { phone } })).id;
  }

  for (const key of KEYS) tokens[key] = await login(P[key]);

  const course = await prisma.course.create({
    data: {
      teacherId: ids.teacher,
      title: `HW-${Date.now()}`,
      isPublished: true,
      publishedAt: new Date(),
      price: 0,
    },
  });

  lessonId = (
    await prisma.lesson.create({
      data: {
        courseId: course.id,
        teacherId: ids.teacher,
title: 'Lifecycle lesson',
        // The controller refuses a submission for a lesson that has no homework
        // set, so the fixture has to carry homework text to be a real lesson.
        homeworkText: 'Answer in full sentences.',
        // Deadline in the past so late work is exercised.
        homeworkDueAt: new Date(Date.now() - 60_000),
      },
    })
  ).id;

  for (const s of ['student', 'student2'] as const) {
    await prisma.courseEnrollment.create({
      data: {
        studentId: ids[s],
        courseId: course.id,
        paymentMethod: 'CASH',
        status: 'APPROVED',
      },
    });
  }
}, 60_000);

afterAll(async () => {
  await prisma.tracking.deleteMany({ where: { lessonId } });
  await prisma.lesson.deleteMany({ where: { id: lessonId } });
  await prisma.courseEnrollment.deleteMany({
    where: { studentId: { in: [ids.student, ids.student2] } },
  });
  await prisma.course.deleteMany({ where: { teacherId: ids.teacher } });
  await prisma.user.deleteMany({ where: { phone: { in: Object.values(P) } } });
  await prisma.$disconnect();
}, 60_000);

const submit = (token: string, answer: string) =>
  post(`/api/lessons/${lessonId}/homework`, token).send({ answer });

describe('homework lifecycle moves are checked, not assumed', () => {
  it('records a submission with a real timestamp and marks late work', async () => {
    const res = await submit(tokens.student, 'first answer');
    expect(res.status).toBe(201);

    const row = await status(ids.student);
    expect(row?.hwStatus).toBe('SUBMITTED');
    expect(row?.hwSubmittedAt).toBeInstanceOf(Date);

    const parsed = JSON.parse(row!.essayAnswers!);
    expect(parsed.answer).toBe('first answer');
    // The lesson deadline is already in the past, so late work must be accepted
    // AND flagged rather than rejected.
    expect(parsed.late).toBe(true);
  });

  it('refuses to grade a submission that was never made', async () => {
    const res = await post(`/api/teachers/assignments/${lessonId}/grade`, tokens.teacher).send({
      studentId: ids.student2,
      grade: 8,
      maxGrade: 10,
    });
    expect(res.status).toBe(404);
  });

  it('grades a submitted assignment and stores the mark and the marker', async () => {
    const res = await post(`/api/teachers/assignments/${lessonId}/grade`, tokens.teacher).send({
      studentId: ids.student,
      grade: 8,
      maxGrade: 10,
      comment: 'good work',
    });
    expect(res.status).toBe(200);

    const row = await status(ids.student);
    expect(row?.hwStatus).toBe('GRADED');
    expect(row?.hwGrade).toBe(8);
    expect(row?.hwMaxGrade).toBe(10);
    expect(row?.hwComment).toBe('good work');
    expect(row?.hwGradedById).toBe(ids.teacher);
    expect(row?.hwGradedAt).toBeInstanceOf(Date);
  });

  it('refuses a grade above the maximum', async () => {
    const res = await post(`/api/teachers/assignments/${lessonId}/grade`, tokens.teacher).send({
      studentId: ids.student,
      grade: 11,
      maxGrade: 10,
    });
    expect(res.status).toBe(400);
    // And the stored grade must be untouched.
    const row = await status(ids.student);
    expect(row?.hwGrade).toBe(8);
  });

  it('refuses a negative or fractional grade', async () => {
    for (const g of [-1, 7.5]) {
      const res = await post(`/api/teachers/assignments/${lessonId}/grade`, tokens.teacher).send({
        studentId: ids.student,
        grade: g,
        maxGrade: 10,
      });
      expect(res.status).toBe(400);
    }
  });

  it('treats GRADED as final and refuses to reopen it', async () => {
    const res = await post(`/api/teachers/assignments/${lessonId}/return`, tokens.teacher).send({
      studentId: ids.student,
      comment: 'please redo',
    });
    expect(res.status).toBe(400);
    expect((await status(ids.student))?.hwStatus).toBe('GRADED');
  });

  it('refuses a submission change once graded, through the legacy status route', async () => {
    const res = await post(`/api/teachers/assignments/${lessonId}/status`, tokens.teacher).send({
      studentId: ids.student,
      status: 'SUBMITTED',
    });
    expect(res.status).toBe(400);
    expect((await status(ids.student))?.hwStatus).toBe('GRADED');
  });

  it('requires feedback when returning work for revision', async () => {
    await submit(tokens.student2, 'work to be returned');

    const res = await post(`/api/teachers/assignments/${lessonId}/return`, tokens.teacher).send({
      studentId: ids.student2,
    });
    expect(res.status).toBe(400);

    const row = await status(ids.student2);
    expect(row?.hwStatus).toBe('SUBMITTED');
  });

  it('returns work for revision with feedback', async () => {
    const res = await post(`/api/teachers/assignments/${lessonId}/return`, tokens.teacher).send({
      studentId: ids.student2,
      comment: 'show your working',
    });
    expect(res.status).toBe(200);

    const row = await status(ids.student2);
    expect(row?.hwStatus).toBe('NEEDS_REVISION');
    expect(row?.hwComment).toBe('show your working');
  });

  it('counts a resubmission only after a return, not on first submit', async () => {
    // student2 is NEEDS_REVISION with count 0 — this is a genuine resubmission.
    const res = await submit(tokens.student2, 'second answer');
    expect(res.status).toBe(201);

    const row = await status(ids.student2);
    expect(row?.hwStatus).toBe('SUBMITTED');
    expect(row?.hwResubmitCount).toBe(1);
  });

  it('stops resubmitting at the limit instead of looping forever', async () => {
    // Drive the counter to the cap, then prove one more is refused.
    await prisma.tracking.update({
      where: { studentId_lessonId: { studentId: ids.student2, lessonId } },
      data: { hwStatus: 'NEEDS_REVISION', hwResubmitCount: 3 },
    });

    const res = await submit(tokens.student2, 'fourth answer');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/limit/i);

    // The refused submission must not have been written.
    const row = await status(ids.student2);
    expect(row?.hwResubmitCount).toBe(3);
    expect(JSON.parse(row!.essayAnswers!).answer).toBe('second answer');
  });

  it('shows every enrolled student in the register, unsubmitted included', async () => {
    await prisma.tracking.deleteMany({
      where: { studentId: ids.student, lessonId },
    });

    const res = await request(app)
      .get(`/api/teachers/assignments/${lessonId}/register`)
      .set(bearer(tokens.teacher));

    expect(res.status).toBe(200);
    expect(res.body.enrolledCount).toBe(2);
    expect(res.body.students).toHaveLength(2);

    const fresh = res.body.students.find(
      (s: { studentId: string }) => s.studentId === ids.student,
    );
    expect(fresh.status).toBe('NOT_SUBMITTED');
    expect(fresh.answer).toBeNull();
  });

  it('reports remaining resubmissions and the deadline in the register', async () => {
    const res = await request(app)
      .get(`/api/teachers/assignments/${lessonId}/register`)
      .set(bearer(tokens.teacher));

    expect(res.body.assignment.maxResubmissions).toBe(3);
    expect(res.body.assignment.homeworkDueAt).toBeTruthy();
  });
});

describe('homework lifecycle is not forgeable', () => {
  it('refuses a teacher from another account', async () => {
    await submit(tokens.student, 'answer');
    const res = await post(`/api/teachers/assignments/${lessonId}/grade`, tokens.otherTeacher).send({
      studentId: ids.student,
      grade: 1,
      maxGrade: 10,
    });
    expect(res.status).toBe(403);
    expect((await status(ids.student))?.hwStatus).toBe('SUBMITTED');
  });

  it('refuses a student from grading, returning, or reading the register', async () => {
    for (const suffix of ['grade', 'return', 'review']) {
      const res = await post(
        `/api/teachers/assignments/${lessonId}/${suffix}`,
        tokens.student,
      ).send({ studentId: ids.student, grade: 10, maxGrade: 10, comment: 'self graded' });
      expect(res.status).toBe(403);
    }

    const reg = await request(app)
      .get(`/api/teachers/assignments/${lessonId}/register`)
      .set(bearer(tokens.student));
    expect(reg.status).toBe(403);
  });

  it('refuses grading a student who is not enrolled', async () => {
    const res = await post(`/api/teachers/assignments/${lessonId}/grade`, tokens.teacher).send({
      studentId: ids.outsider,
      grade: 5,
      maxGrade: 10,
    });
    expect(res.status).toBe(403);
  });
});