import request from 'supertest';
import app from '../../../src/app';
import prisma from '../../../src/config/prisma';
import {
  authHeader,
  cleanE2EData,
  ensureE2EUser,
  loginUser,
} from '../helpers/test-helper';

const PHONES = {
  teacher: '01000008931',
  student1: '01000008932',
  student2: '01000008933',
};

describe('Tier 5 Adversarial: Homework Due Date & State Machine Stress Testing', () => {
  let teacherToken: string;
  let teacherId: string;
  let student1Token: string;
  let student1Id: string;
  let student2Token: string;
  let student2Id: string;
  let courseId: string;
  let lessonId: string;

  beforeAll(async () => {
    await cleanE2EData(Object.values(PHONES));

    const t = await ensureE2EUser({
      phone: PHONES.teacher,
      role: 'TEACHER',
      name: 'Adv HW Teacher',
    });
    teacherId = t.id;

    const s1 = await ensureE2EUser({
      phone: PHONES.student1,
      role: 'STUDENT',
      name: 'Adv HW Student 1',
    });
    student1Id = s1.id;

    const s2 = await ensureE2EUser({
      phone: PHONES.student2,
      role: 'STUDENT',
      name: 'Adv HW Student 2',
    });
    student2Id = s2.id;

    teacherToken = (await loginUser(PHONES.teacher)).token;
    student1Token = (await loginUser(PHONES.student1)).token;
    student2Token = (await loginUser(PHONES.student2)).token;

    // Create course and enroll students
    const course = await prisma.course.create({
      data: {
        teacherId,
        title: 'Adversarial Homework Course',
        isPublished: true,
      },
    });
    courseId = course.id;

    await prisma.courseEnrollment.createMany({
      data: [
        { studentId: student1Id, courseId, status: 'APPROVED', paymentMethod: 'CASH' },
        { studentId: student2Id, courseId, status: 'APPROVED', paymentMethod: 'CASH' },
      ],
    });

    // Create baseline lesson with homework
    const lesson = await prisma.lesson.create({
      data: {
        courseId,
        teacherId,
        title: 'Adversarial State Machine Lesson',
        homeworkText: 'Answer the comprehensive adversarial questions.',
        homeworkDueAt: new Date(Date.now() + 86400000), // Due in 24 hours
      },
    });
    lessonId = lesson.id;
  }, 60000);

  afterAll(async () => {
    await cleanE2EData(Object.values(PHONES), [courseId]);
    await prisma.$disconnect();
  });

  // =========================================================================
  // Section 1: State Machine Transition Stress & Illegal Moves
  // =========================================================================
  describe('1. State Machine Transitions & Illegal State Changes', () => {
    it('T5-HW-01: student cannot submit empty or whitespace-only homework answer (HTTP 400)', async () => {
      const res = await request(app)
        .post(`/api/lessons/${lessonId}/homework`)
        .set(authHeader(student1Token))
        .send({ answer: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('T5-HW-02: student submits homework -> transitions to SUBMITTED', async () => {
      const res = await request(app)
        .post(`/api/lessons/${lessonId}/homework`)
        .set(authHeader(student1Token))
        .send({ answer: 'My first genuine attempt.' });

      expect(res.status).toBe(201);
      expect(res.body.tracking.hwStatus).toBe('SUBMITTED');
    });

    it('T5-HW-03: student cannot resubmit while status is SUBMITTED (HTTP 409 Conflict)', async () => {
      const res = await request(app)
        .post(`/api/lessons/${lessonId}/homework`)
        .set(authHeader(student1Token))
        .send({ answer: 'Premature replacement attempt.' });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/Homework already submitted/i);
    });

    it('T5-HW-04: teacher moves SUBMITTED to UNDER_REVIEW', async () => {
      const res = await request(app)
        .post(`/api/teachers/assignments/${lessonId}/review`)
        .set(authHeader(teacherToken))
        .send({ studentId: student1Id });

      expect(res.status).toBe(200);
      expect(res.body.result.hwStatus).toBe('UNDER_REVIEW');
    });

    it('T5-HW-05: student cannot submit while status is UNDER_REVIEW (HTTP 409 Conflict)', async () => {
      const res = await request(app)
        .post(`/api/lessons/${lessonId}/homework`)
        .set(authHeader(student1Token))
        .send({ answer: 'Interfering while teacher is reviewing.' });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/Homework already submitted/i);
    });

    it('T5-HW-06: teacher grades homework -> transitions to terminal GRADED', async () => {
      const res = await request(app)
        .post(`/api/teachers/assignments/${lessonId}/grade`)
        .set(authHeader(teacherToken))
        .send({
          studentId: student1Id,
          grade: 95,
          maxGrade: 100,
          comment: 'Outstanding adversarial solution.',
        });

      expect(res.status).toBe(200);
      expect(res.body.result.hwStatus).toBe('GRADED');
    });

    it('T5-HW-07: once GRADED, student cannot resubmit homework (HTTP 409 Conflict)', async () => {
      const res = await request(app)
        .post(`/api/lessons/${lessonId}/homework`)
        .set(authHeader(student1Token))
        .send({ answer: 'Attempt to overwrite graded work.' });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/Homework already submitted/i);
    });

    it('T5-HW-08: once GRADED, teacher cannot move submission back to SUBMITTED (HTTP 400)', async () => {
      const res = await request(app)
        .post(`/api/teachers/assignments/${lessonId}/status`)
        .set(authHeader(teacherToken))
        .send({ studentId: student1Id, status: 'SUBMITTED' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Graded homework cannot return to an earlier state/i);
    });

    it('T5-HW-09: once GRADED, teacher cannot return submission for revision (HTTP 400)', async () => {
      const res = await request(app)
        .post(`/api/teachers/assignments/${lessonId}/return`)
        .set(authHeader(teacherToken))
        .send({ studentId: student1Id, comment: 'Illegal return of graded work.' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Illegal homework transition/i);
    });
  });

  // =========================================================================
  // Section 2: Resubmission Loop & Max Resubmission Cap Enforcement
  // =========================================================================
  describe('2. Revision Loop & Maximum Resubmission Cap Stress (3 Cycles)', () => {
    it('T5-HW-10: enforces mandatory comment when returning homework (HTTP 400)', async () => {
      // Student 2 submits
      await request(app)
        .post(`/api/lessons/${lessonId}/homework`)
        .set(authHeader(student2Token))
        .send({ answer: 'Student 2 initial submission.' });

      const res = await request(app)
        .post(`/api/teachers/assignments/${lessonId}/return`)
        .set(authHeader(teacherToken))
        .send({ studentId: student2Id, comment: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/A comment is required/i);
    });

    it('T5-HW-11: executes 3 full revision cycles successfully', async () => {
      // Cycle 1: Return -> Resubmit
      const ret1 = await request(app)
        .post(`/api/teachers/assignments/${lessonId}/return`)
        .set(authHeader(teacherToken))
        .send({ studentId: student2Id, comment: 'Revision 1 required.' });
      expect(ret1.status).toBe(200);
      expect(ret1.body.result.hwStatus).toBe('NEEDS_REVISION');

      const sub1 = await request(app)
        .post(`/api/lessons/${lessonId}/homework`)
        .set(authHeader(student2Token))
        .send({ answer: 'Student 2 resubmission 1.' });
      expect(sub1.status).toBe(201);
      expect(sub1.body.tracking.hwStatus).toBe('SUBMITTED');

      // Cycle 2: Return -> Resubmit
      const ret2 = await request(app)
        .post(`/api/teachers/assignments/${lessonId}/return`)
        .set(authHeader(teacherToken))
        .send({ studentId: student2Id, comment: 'Revision 2 required.' });
      expect(ret2.status).toBe(200);

      const sub2 = await request(app)
        .post(`/api/lessons/${lessonId}/homework`)
        .set(authHeader(student2Token))
        .send({ answer: 'Student 2 resubmission 2.' });
      expect(sub2.status).toBe(201);

      // Cycle 3: Return -> Resubmit
      const ret3 = await request(app)
        .post(`/api/teachers/assignments/${lessonId}/return`)
        .set(authHeader(teacherToken))
        .send({ studentId: student2Id, comment: 'Revision 3 required.' });
      expect(ret3.status).toBe(200);

      const sub3 = await request(app)
        .post(`/api/lessons/${lessonId}/homework`)
        .set(authHeader(student2Token))
        .send({ answer: 'Student 2 resubmission 3.' });
      expect(sub3.status).toBe(201);
    });

    it('T5-HW-12: 4th return attempt exceeds MAX_RESUBMISSIONS and throws HTTP 400', async () => {
      const res = await request(app)
        .post(`/api/teachers/assignments/${lessonId}/return`)
        .set(authHeader(teacherToken))
        .send({ studentId: student2Id, comment: 'Attempting illegal 4th revision cycle.' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Maximum resubmission limit reached/i);
    });
  });

  // =========================================================================
  // Section 3: Extreme Boundary Due Dates & Overdue Precision
  // =========================================================================
  describe('3. Extreme Boundary Due Dates (Leap Years, Epoch 0, Extreme Future, 1s delta)', () => {
    it('T5-HW-13: past leap year deadline (2024-02-29) computes isOverdue: true', async () => {
      const pastLeapLesson = await prisma.lesson.create({
        data: {
          courseId,
          teacherId,
          title: 'Past Leap Year Lesson',
          homeworkText: 'Leap year questions.',
          homeworkDueAt: new Date('2024-02-29T23:59:59.999Z'),
        },
      });

      const res = await request(app)
        .get(`/api/lessons/${pastLeapLesson.id}`)
        .set(authHeader(student1Token));

      expect(res.status).toBe(200);
      expect(res.body.lesson.isOverdue).toBe(true);
      expect(res.body.lesson.homeworkDueAt).toBe('2024-02-29T23:59:59.999Z');

      await prisma.lesson.delete({ where: { id: pastLeapLesson.id } });
    });

    it('T5-HW-14: future leap year deadline (2028-02-29) computes isOverdue: false', async () => {
      const futureLeapLesson = await prisma.lesson.create({
        data: {
          courseId,
          teacherId,
          title: 'Future Leap Year Lesson',
          homeworkText: 'Future leap year questions.',
          homeworkDueAt: new Date('2028-02-29T23:59:59.999Z'),
        },
      });

      const res = await request(app)
        .get(`/api/lessons/${futureLeapLesson.id}`)
        .set(authHeader(student1Token));

      expect(res.status).toBe(200);
      expect(res.body.lesson.isOverdue).toBe(false);

      await prisma.lesson.delete({ where: { id: futureLeapLesson.id } });
    });

    it('T5-HW-15: Unix Epoch 0 deadline (1970-01-01) computes isOverdue: true', async () => {
      const epochLesson = await prisma.lesson.create({
        data: {
          courseId,
          teacherId,
          title: 'Epoch Zero Lesson',
          homeworkText: 'Epoch questions.',
          homeworkDueAt: new Date('1970-01-01T00:00:00.000Z'),
        },
      });

      const res = await request(app)
        .get(`/api/lessons/${epochLesson.id}`)
        .set(authHeader(student1Token));

      expect(res.status).toBe(200);
      expect(res.body.lesson.isOverdue).toBe(true);

      await prisma.lesson.delete({ where: { id: epochLesson.id } });
    });

    it('T5-HW-16: distant future deadline (2099-12-31) computes isOverdue: false', async () => {
      const distantFutureLesson = await prisma.lesson.create({
        data: {
          courseId,
          teacherId,
          title: 'Distant Future Lesson',
          homeworkText: 'Future questions.',
          homeworkDueAt: new Date('2099-12-31T23:59:59.999Z'),
        },
      });

      const res = await request(app)
        .get(`/api/lessons/${distantFutureLesson.id}`)
        .set(authHeader(student1Token));

      expect(res.status).toBe(200);
      expect(res.body.lesson.isOverdue).toBe(false);

      await prisma.lesson.delete({ where: { id: distantFutureLesson.id } });
    });

    it('T5-HW-17: past by 1 second computes isOverdue: true accurately in register and lesson endpoint', async () => {
      const oneSecPastLesson = await prisma.lesson.create({
        data: {
          courseId,
          teacherId,
          title: 'One Second Past Lesson',
          homeworkText: 'Past 1s questions.',
          homeworkDueAt: new Date(Date.now() - 1000),
        },
      });

      const resLesson = await request(app)
        .get(`/api/lessons/${oneSecPastLesson.id}`)
        .set(authHeader(student1Token));

      expect(resLesson.status).toBe(200);
      expect(resLesson.body.lesson.isOverdue).toBe(true);

      const resRegister = await request(app)
        .get(`/api/teachers/assignments/${oneSecPastLesson.id}/register`)
        .set(authHeader(teacherToken));

      expect(resRegister.status).toBe(200);
      const student1Row = resRegister.body.students.find((s: any) => s.studentId === student1Id);
      expect(student1Row.isOverdue).toBe(true);

      await prisma.lesson.delete({ where: { id: oneSecPastLesson.id } });
    });

    it('T5-HW-18: lesson without homework due date (null) computes isOverdue: false and null due date', async () => {
      const nullDueLesson = await prisma.lesson.create({
        data: {
          courseId,
          teacherId,
          title: 'Null Due Lesson',
          homeworkText: 'No deadline questions.',
          homeworkDueAt: null,
        },
      });

      const res = await request(app)
        .get(`/api/lessons/${nullDueLesson.id}`)
        .set(authHeader(student1Token));

      expect(res.status).toBe(200);
      expect(res.body.lesson.isOverdue).toBe(false);
      expect(res.body.lesson.homeworkDueAt).toBeNull();

      await prisma.lesson.delete({ where: { id: nullDueLesson.id } });
    });
  });
});
