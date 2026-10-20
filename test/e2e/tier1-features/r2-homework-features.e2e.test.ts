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
  teacher: '01000008201',
  assistant: '01000008202',
  student1: '01000008203',
  student2: '01000008204',
  outsider: '01000008205',
};

describe('Tier 1: R2 Homework Lifecycle & Register Features', () => {
  let teacherToken: string;
  let teacherId: string;
  let assistantToken: string;
  let student1Token: string;
  let student1Id: string;
  let student2Token: string;
  let student2Id: string;
  let courseId: string;
  let normalLessonId: string;
  let overdueLessonId: string;

  beforeAll(async () => {
    await cleanE2EData(Object.values(PHONES));

    const teacher = await ensureE2EUser({ phone: PHONES.teacher, role: 'TEACHER', name: 'HW Teacher' });
    teacherId = teacher.id;

    const assistant = await ensureE2EUser({
      phone: PHONES.assistant,
      role: 'ASSISTANT',
      name: 'HW Assistant',
      parentTeacherId: teacherId,
    });

    const student1 = await ensureE2EUser({ phone: PHONES.student1, role: 'STUDENT', name: 'HW Student 1' });
    student1Id = student1.id;

    const student2 = await ensureE2EUser({ phone: PHONES.student2, role: 'STUDENT', name: 'HW Student 2' });
    student2Id = student2.id;

    const tLogin = await loginUser(PHONES.teacher);
    teacherToken = tLogin.token;

    const aLogin = await loginUser(PHONES.assistant);
    assistantToken = aLogin.token;

    const s1Login = await loginUser(PHONES.student1);
    student1Token = s1Login.token;

    const s2Login = await loginUser(PHONES.student2);
    student2Token = s2Login.token;

    // Create course and enrolled students
    const course = await prisma.course.create({
      data: {
        teacherId,
        title: 'E2E Homework Test Course',
        isPublished: true,
      },
    });
    courseId = course.id;

    await prisma.courseEnrollment.createMany({
      data: [
        { studentId: student1Id, courseId, paymentMethod: 'CASH', status: 'APPROVED' },
        { studentId: student2Id, courseId, paymentMethod: 'CASH', status: 'APPROVED' },
      ],
    });

    // Lesson 1: Normal deadline in future
    const normalLesson = await prisma.lesson.create({
      data: {
        courseId,
        teacherId,
        title: 'E2E Future Deadline Lesson',
        homeworkText: 'Write an essay about science.',
        homeworkDueAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // +1 day
      },
    });
    normalLessonId = normalLesson.id;

    // Lesson 2: Overdue deadline in past
    const overdueLesson = await prisma.lesson.create({
      data: {
        courseId,
        teacherId,
        title: 'E2E Past Deadline Lesson',
        homeworkText: 'Solve math problem set.',
        homeworkDueAt: new Date(Date.now() - 60 * 60 * 1000), // -1 hour
      },
    });
    overdueLessonId = overdueLesson.id;
  }, 60000);

  afterAll(async () => {
    await cleanE2EData(Object.values(PHONES), [courseId]);
    await prisma.$disconnect();
  });

  // =========================================================================
  // Feature 5: Student Homework Submission (5 test cases)
  // =========================================================================
  describe('Feature 5: Student Homework Submission', () => {
    it('T1-F05-01: student submits valid homework text via POST /api/lessons/:id/homework', async () => {
      const res = await request(app)
        .post(`/api/lessons/${normalLessonId}/homework`)
        .set(authHeader(student1Token))
        .send({ answer: 'Science is the systematic study of structure and behaviour.' });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('tracking');
    });

    it('T1-F05-02: tracking status transitions to SUBMITTED in database', async () => {
      const tracking = await prisma.tracking.findUnique({
        where: { studentId_lessonId: { studentId: student1Id, lessonId: normalLessonId } },
      });
      expect(tracking).toBeDefined();
      expect(tracking?.hwStatus).toBe('SUBMITTED');
    });

    it('T1-F05-03: hwSubmittedAt timestamp is recorded upon submission', async () => {
      const tracking = await prisma.tracking.findUnique({
        where: { studentId_lessonId: { studentId: student1Id, lessonId: normalLessonId } },
      });
      expect(tracking?.hwSubmittedAt).toBeInstanceOf(Date);
    });

    it('T1-F05-04: submitted text is serialized and stored in essayAnswers JSON', async () => {
      const tracking = await prisma.tracking.findUnique({
        where: { studentId_lessonId: { studentId: student1Id, lessonId: normalLessonId } },
      });
      expect(tracking?.essayAnswers).toBeDefined();
      const parsed = JSON.parse(tracking!.essayAnswers!);
      expect(parsed.answer).toContain('systematic study');
    });

    it('T1-F05-05: student views tracking record with hwStatus SUBMITTED', async () => {
      const res = await request(app)
        .get(`/api/trackings/${normalLessonId}`)
        .set(authHeader(student1Token));

      expect(res.status).toBe(200);
      expect(res.body.tracking.hwStatus).toBe('SUBMITTED');
    });
  });

  // =========================================================================
  // Feature 6: Teacher Homework Register & Roster (5 test cases)
  // =========================================================================
  describe('Feature 6: Teacher Homework Register & Roster', () => {
    it('T1-F06-01: teacher accesses assignment register endpoint', async () => {
      const res = await request(app)
        .get(`/api/teachers/assignments/${normalLessonId}/register`)
        .set(authHeader(teacherToken));

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('students');
    });

    it('T1-F06-02: register lists enrolled students and their homework status', async () => {
      const res = await request(app)
        .get(`/api/teachers/assignments/${normalLessonId}/register`)
        .set(authHeader(teacherToken));

      expect(res.status).toBe(200);
      const student1Row = res.body.students.find((r: any) => r.studentId === student1Id);
      expect(student1Row).toBeDefined();
      expect(student1Row.status).toBe('SUBMITTED');
    });

    it('T1-F06-03: register includes student submission text for teacher inspection', async () => {
      const res = await request(app)
        .get(`/api/teachers/assignments/${normalLessonId}/register`)
        .set(authHeader(teacherToken));

      const student1Row = res.body.students.find((r: any) => r.studentId === student1Id);
      expect(student1Row.answer).toContain('systematic study');
    });

    it('T1-F06-04: unsubmitted enrolled student displays status NOT_SUBMITTED', async () => {
      const res = await request(app)
        .get(`/api/teachers/assignments/${normalLessonId}/register`)
        .set(authHeader(teacherToken));

      const student2Row = res.body.students.find((r: any) => r.studentId === student2Id);
      expect(student2Row).toBeDefined();
      expect(student2Row.status).toBe('NOT_SUBMITTED');
    });

    it('T1-F06-05: assistant of the teacher can access the homework register', async () => {
      const res = await request(app)
        .get(`/api/teachers/assignments/${normalLessonId}/register`)
        .set(authHeader(assistantToken));

      expect(res.status).toBe(200);
      expect(res.body.students.length).toBeGreaterThanOrEqual(2);
    });
  });

  // =========================================================================
  // Feature 7: Teacher Grading & Max-Grade Validation (5 test cases)
  // =========================================================================
  describe('Feature 7: Teacher Grading & Assessment', () => {
    it('T1-F07-01: teacher grades submission with score and max score via POST /api/teachers/assignments/:id/grade', async () => {
      const res = await request(app)
        .post(`/api/teachers/assignments/${normalLessonId}/grade`)
        .set(authHeader(teacherToken))
        .send({
          studentId: student1Id,
          grade: 9,
          maxGrade: 10,
          comment: 'Excellent work!',
        });

      expect(res.status).toBe(200);
      expect(res.body.result.hwStatus).toBe('GRADED');
      expect(res.body.result.hwGrade).toBe(9);
    });

    it('T1-F07-02: hwStatus reaches terminal state GRADED in database', async () => {
      const tracking = await prisma.tracking.findUnique({
        where: { studentId_lessonId: { studentId: student1Id, lessonId: normalLessonId } },
      });
      expect(tracking?.hwStatus).toBe('GRADED');
    });

    it('T1-F07-03: records teacher ID in hwGradedById for auditability', async () => {
      const tracking = await prisma.tracking.findUnique({
        where: { studentId_lessonId: { studentId: student1Id, lessonId: normalLessonId } },
      });
      expect(tracking?.hwGradedById).toBe(teacherId);
    });

    it('T1-F07-04: hwGradedAt timestamp is recorded upon grading', async () => {
      const tracking = await prisma.tracking.findUnique({
        where: { studentId_lessonId: { studentId: student1Id, lessonId: normalLessonId } },
      });
      expect(tracking?.hwGradedAt).toBeInstanceOf(Date);
    });

    it('T1-F07-05: student tracking query exposes final grade and teacher comment', async () => {
      const res = await request(app)
        .get(`/api/trackings/${normalLessonId}`)
        .set(authHeader(student1Token));

      expect(res.status).toBe(200);
      expect(res.body.tracking.hwGrade).toBe(9);
      expect(res.body.tracking.hwMaxGrade).toBe(10);
      expect(res.body.tracking.hwComment).toBe('Excellent work!');
    });
  });

  // =========================================================================
  // Feature 8: Homework Revision Loop & Resubmission Cap (5 test cases)
  // =========================================================================
  describe('Feature 8: Homework Revision Loop & Resubmission Cap', () => {
    beforeAll(async () => {
      // Student 2 submits on normalLessonId
      await request(app)
        .post(`/api/lessons/${normalLessonId}/homework`)
        .set(authHeader(student2Token))
        .send({ answer: 'First attempt draft.' });
    });

    it('T1-F08-01: teacher returns submission for revision with mandatory feedback', async () => {
      const res = await request(app)
        .post(`/api/teachers/assignments/${normalLessonId}/return`)
        .set(authHeader(teacherToken))
        .send({
          studentId: student2Id,
          comment: 'Please elaborate more on paragraph 2.',
        });

      expect(res.status).toBe(200);
      expect(res.body.result.hwStatus).toBe('NEEDS_REVISION');
    });

    it('T1-F08-02: hwStatus transitions to NEEDS_REVISION in database', async () => {
      const tracking = await prisma.tracking.findUnique({
        where: { studentId_lessonId: { studentId: student2Id, lessonId: normalLessonId } },
      });
      expect(tracking?.hwStatus).toBe('NEEDS_REVISION');
    });

    it('T1-F08-03: hwResubmitCount remains 0 upon return until student resubmits', async () => {
      const tracking = await prisma.tracking.findUnique({
        where: { studentId_lessonId: { studentId: student2Id, lessonId: normalLessonId } },
      });
      expect(tracking?.hwResubmitCount).toBe(0);
    });

    it('T1-F08-04: student submits revised answer while status is NEEDS_REVISION', async () => {
      const res = await request(app)
        .post(`/api/lessons/${normalLessonId}/homework`)
        .set(authHeader(student2Token))
        .send({ answer: 'Second revised attempt with paragraph 2 expanded.' });

      expect(res.status).toBe(201);
    });

    it('T1-F08-05: resubmission resets status back to SUBMITTED awaiting review', async () => {
      const tracking = await prisma.tracking.findUnique({
        where: { studentId_lessonId: { studentId: student2Id, lessonId: normalLessonId } },
      });
      expect(tracking?.hwStatus).toBe('SUBMITTED');
      expect(tracking?.hwResubmitCount).toBe(1);
    });
  });

  // =========================================================================
  // Feature 9: Homework Overdue Calculation (isOverdue) (5 test cases)
  // =========================================================================
  describe('Feature 9: Homework Overdue Calculation (isOverdue / late)', () => {
    it('T1-F09-01: on-time submission does NOT set late flag in essayAnswers', async () => {
      const tracking = await prisma.tracking.findUnique({
        where: { studentId_lessonId: { studentId: student1Id, lessonId: normalLessonId } },
      });
      const parsed = JSON.parse(tracking!.essayAnswers!);
      expect(parsed.late).toBe(false);
    });

    it('T1-F09-02: late submission past homeworkDueAt records late: true in essayAnswers', async () => {
      const res = await request(app)
        .post(`/api/lessons/${overdueLessonId}/homework`)
        .set(authHeader(student1Token))
        .send({ answer: 'Late submission for overdue lesson.' });

      expect(res.status).toBe(201);

      const tracking = await prisma.tracking.findUnique({
        where: { studentId_lessonId: { studentId: student1Id, lessonId: overdueLessonId } },
      });
      expect(tracking).toBeDefined();
      const parsed = JSON.parse(tracking!.essayAnswers!);
      expect(parsed.late).toBe(true);
    });

    it('T1-F09-03: late work is accepted rather than rejected with error', async () => {
      const tracking = await prisma.tracking.findUnique({
        where: { studentId_lessonId: { studentId: student1Id, lessonId: overdueLessonId } },
      });
      expect(tracking?.hwStatus).toBe('SUBMITTED');
    });

    it('T1-F09-04: unsubmitted student with past homeworkDueAt is identified as overdue in register', async () => {
      const res = await request(app)
        .get(`/api/teachers/assignments/${overdueLessonId}/register`)
        .set(authHeader(teacherToken));

      expect(res.status).toBe(200);
      const student2Row = res.body.students.find((r: any) => r.studentId === student2Id);
      expect(student2Row.status).toBe('NOT_SUBMITTED');
      expect(student2Row.isOverdue).toBe(true);
    });

    it('T1-F09-05: getLessonById exposes homeworkDueAt field to clients', async () => {
      const res = await request(app)
        .get(`/api/lessons/${overdueLessonId}`)
        .set(authHeader(student1Token));

      expect(res.status).toBe(200);
      expect(res.body.lesson).toHaveProperty('homeworkDueAt');
      expect(new Date(res.body.lesson.homeworkDueAt).getTime()).toBeLessThan(Date.now());
    });
  });
});
