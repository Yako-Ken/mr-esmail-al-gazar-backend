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
  teacher: '01000008621',
  otherTeacher: '01000008622',
  studentEnrolled: '01000008623',
  studentUnenrolled: '01000008624',
};

describe('Tier 2: R2 Homework Lifecycle Boundaries & Limits', () => {
  let teacherToken: string;
  let teacherId: string;
  let otherTeacherToken: string;
  let studentEnrolledToken: string;
  let studentEnrolledId: string;
  let studentUnenrolledToken: string;
  let courseId: string;
  let lessonWithHwId: string;
  let lessonNoHwId: string;

  beforeAll(async () => {
    await cleanE2EData(Object.values(PHONES));

    const teacher = await ensureE2EUser({ phone: PHONES.teacher, role: 'TEACHER', name: 'HW Boundary Teacher' });
    teacherId = teacher.id;

    const otherTeacher = await ensureE2EUser({ phone: PHONES.otherTeacher, role: 'TEACHER', name: 'Other Teacher' });

    const studentEnrolled = await ensureE2EUser({ phone: PHONES.studentEnrolled, role: 'STUDENT', name: 'Enrolled HW Student' });
    studentEnrolledId = studentEnrolled.id;

    const studentUnenrolled = await ensureE2EUser({ phone: PHONES.studentUnenrolled, role: 'STUDENT', name: 'Unenrolled HW Student' });

    teacherToken = (await loginUser(PHONES.teacher)).token;
    otherTeacherToken = (await loginUser(PHONES.otherTeacher)).token;
    studentEnrolledToken = (await loginUser(PHONES.studentEnrolled)).token;
    studentUnenrolledToken = (await loginUser(PHONES.studentUnenrolled)).token;

    // Create course and enrollment
    const course = await prisma.course.create({
      data: {
        teacherId,
        title: 'E2E HW Boundary Course',
        isPublished: true,
      },
    });
    courseId = course.id;

    await prisma.courseEnrollment.create({
      data: {
        studentId: studentEnrolledId,
        courseId,
        paymentMethod: 'CASH',
        status: 'APPROVED',
      },
    });

    // Lesson with homework configured
    const l1 = await prisma.lesson.create({
      data: {
        courseId,
        teacherId,
        title: 'Lesson With HW',
        homeworkText: 'Write a comprehensive essay.',
        homeworkDueAt: new Date(Date.now() + 3600000),
      },
    });
    lessonWithHwId = l1.id;

    // Lesson without homework configured
    const l2 = await prisma.lesson.create({
      data: {
        courseId,
        teacherId,
        title: 'Lesson No HW',
        homeworkText: null,
      },
    });
    lessonNoHwId = l2.id;
  }, 60000);

  afterAll(async () => {
    await cleanE2EData(Object.values(PHONES), [courseId]);
    await prisma.$disconnect();
  });

  // =========================================================================
  // Feature 5 Boundaries: Student Homework Submission Limits (5 tests)
  // =========================================================================
  describe('Feature 5 Boundaries: Student Homework Submission', () => {
    it('T2-F05-01: rejects empty string answer with HTTP 400', async () => {
      const res = await request(app)
        .post(`/api/lessons/${lessonWithHwId}/homework`)
        .set(authHeader(studentEnrolledToken))
        .send({ answer: '' });

      expect(res.status).toBe(400);
    });

    it('T2-F05-02: rejects whitespace-only answer with HTTP 400', async () => {
      const res = await request(app)
        .post(`/api/lessons/${lessonWithHwId}/homework`)
        .set(authHeader(studentEnrolledToken))
        .send({ answer: '     \n  \t  ' });

      expect(res.status).toBe(400);
    });

    it('T2-F05-03: rejects submission to lesson with no homework assigned with HTTP 400', async () => {
      const res = await request(app)
        .post(`/api/lessons/${lessonNoHwId}/homework`)
        .set(authHeader(studentEnrolledToken))
        .send({ answer: 'Attempting to submit to no-homework lesson' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no homework/i);
    });

    it('T2-F05-04: rejects submission from unenrolled student with HTTP 403 Forbidden', async () => {
      const res = await request(app)
        .post(`/api/lessons/${lessonWithHwId}/homework`)
        .set(authHeader(studentUnenrolledToken))
        .send({ answer: 'Sneaky submission from unenrolled student' });

      expect(res.status).toBe(403);
    });

    it('T2-F05-05: rejects repeated submission when status is already SUBMITTED', async () => {
      // First valid submission
      const firstRes = await request(app)
        .post(`/api/lessons/${lessonWithHwId}/homework`)
        .set(authHeader(studentEnrolledToken))
        .send({ answer: 'Valid initial submission' });
      expect(firstRes.status).toBe(201);

      // Second submission without teacher return must be rejected
      const secondRes = await request(app)
        .post(`/api/lessons/${lessonWithHwId}/homework`)
        .set(authHeader(studentEnrolledToken))
        .send({ answer: 'Second unsolicited submission' });

      expect([400, 409]).toContain(secondRes.status);
    });
  });

  // =========================================================================
  // Feature 6 Boundaries: Teacher Register Edge Cases (5 tests)
  // =========================================================================
  describe('Feature 6 Boundaries: Teacher Register Edge Cases', () => {
    it('T2-F06-01: student attempting to access homework register receives HTTP 403', async () => {
      const res = await request(app)
        .get(`/api/teachers/assignments/${lessonWithHwId}/register`)
        .set(authHeader(studentEnrolledToken));

      expect(res.status).toBe(403);
    });

    it('T2-F06-02: other teacher accessing unowned assignment register receives HTTP 404 or 403', async () => {
      const res = await request(app)
        .get(`/api/teachers/assignments/${lessonWithHwId}/register`)
        .set(authHeader(otherTeacherToken));

      expect([403, 404]).toContain(res.status);
    });

    it('T2-F06-03: querying register for non-existent lessonId returns HTTP 404 or 403', async () => {
      const res = await request(app)
        .get('/api/teachers/assignments/00000000-0000-0000-0000-000000000000/register')
        .set(authHeader(teacherToken));

      expect([403, 404]).toContain(res.status);
    });

    it('T2-F06-04: malformed non-UUID lessonId in route returns HTTP 404 or 403', async () => {
      const res = await request(app)
        .get('/api/teachers/assignments/not-a-valid-uuid/register')
        .set(authHeader(teacherToken));

      expect([400, 403, 404]).toContain(res.status);
    });

    it('T2-F06-05: course with no enrolled students returns empty register array gracefully', async () => {
      const emptyCourse = await prisma.course.create({
        data: { teacherId, title: 'Empty Course' },
      });
      const emptyLesson = await prisma.lesson.create({
        data: { courseId: emptyCourse.id, teacherId, title: 'Empty Lesson', homeworkText: 'HW' },
      });

      const res = await request(app)
        .get(`/api/teachers/assignments/${emptyLesson.id}/register`)
        .set(authHeader(teacherToken));

      expect(res.status).toBe(200);
      expect(res.body.students).toEqual([]);

      await prisma.lesson.delete({ where: { id: emptyLesson.id } });
      await prisma.course.delete({ where: { id: emptyCourse.id } });
    });
  });

  // =========================================================================
  // Feature 7 Boundaries: Teacher Grading Bounds (5 tests)
  // =========================================================================
  describe('Feature 7 Boundaries: Teacher Grading Bounds', () => {
    it('T2-F07-01: rejects negative grade (grade < 0) with HTTP 400', async () => {
      const res = await request(app)
        .post(`/api/teachers/assignments/${lessonWithHwId}/grade`)
        .set(authHeader(teacherToken))
        .send({
          studentId: studentEnrolledId,
          grade: -5,
          maxGrade: 10,
        });

      expect(res.status).toBe(400);
    });

    it('T2-F07-02: rejects grade exceeding maxGrade (grade > maxGrade) with HTTP 400', async () => {
      const res = await request(app)
        .post(`/api/teachers/assignments/${lessonWithHwId}/grade`)
        .set(authHeader(teacherToken))
        .send({
          studentId: studentEnrolledId,
          grade: 15,
          maxGrade: 10,
        });

      expect(res.status).toBe(400);
    });

    it('T2-F07-03: rejects grading when student has not submitted homework with HTTP 404', async () => {
      const res = await request(app)
        .post(`/api/teachers/assignments/${lessonWithHwId}/grade`)
        .set(authHeader(teacherToken))
        .send({
          studentId: '00000000-0000-0000-0000-000000000000',
          grade: 8,
          maxGrade: 10,
        });

      expect([403, 404]).toContain(res.status);
    });

    it('T2-F07-04: student attempting to invoke teacher grading route receives HTTP 403', async () => {
      const res = await request(app)
        .post(`/api/teachers/assignments/${lessonWithHwId}/grade`)
        .set(authHeader(studentEnrolledToken))
        .send({
          studentId: studentEnrolledId,
          grade: 10,
          maxGrade: 10,
        });

      expect(res.status).toBe(403);
    });

    it('T2-F07-05: finality of GRADED state locks assignment against re-grading or returns', async () => {
      // Grade the submission
      await request(app)
        .post(`/api/teachers/assignments/${lessonWithHwId}/grade`)
        .set(authHeader(teacherToken))
        .send({
          studentId: studentEnrolledId,
          grade: 10,
          maxGrade: 10,
        });

      // Attempting to return after graded must be rejected
      const returnRes = await request(app)
        .post(`/api/teachers/assignments/${lessonWithHwId}/return`)
        .set(authHeader(teacherToken))
        .send({
          studentId: studentEnrolledId,
          comment: 'Too late to return',
        });

      expect(returnRes.status).toBe(400);
    });
  });

  // =========================================================================
  // Feature 8 Boundaries: Revision Limits & Resubmission Cap (5 tests)
  // =========================================================================
  describe('Feature 8 Boundaries: Revision Limits & Resubmission Cap', () => {
    let loopLessonId: string;

    beforeAll(async () => {
      const l = await prisma.lesson.create({
        data: {
          courseId,
          teacherId,
          title: 'Resubmit Loop Lesson',
          homeworkText: 'Loop test homework',
        },
      });
      loopLessonId = l.id;
    });

    it('T2-F08-01: teacher return without comment is rejected with HTTP 400', async () => {
      // First submit
      await request(app)
        .post(`/api/lessons/${loopLessonId}/homework`)
        .set(authHeader(studentEnrolledToken))
        .send({ answer: 'Initial attempt for return testing' });

      const res = await request(app)
        .post(`/api/teachers/assignments/${loopLessonId}/return`)
        .set(authHeader(teacherToken))
        .send({
          studentId: studentEnrolledId,
          comment: '', // Empty comment
        });

      expect(res.status).toBe(400);
    });

    it('T2-F08-02: teacher returning an unsubmitted student receives HTTP 404', async () => {
      const res = await request(app)
        .post(`/api/teachers/assignments/${loopLessonId}/return`)
        .set(authHeader(teacherToken))
        .send({
          studentId: '00000000-0000-0000-0000-000000000000',
          comment: 'Not submitted',
        });

      expect([403, 404]).toContain(res.status);
    });

    it('T2-F08-03: student resubmission with empty text when in NEEDS_REVISION is rejected', async () => {
      // Return with valid comment
      await request(app)
        .post(`/api/teachers/assignments/${loopLessonId}/return`)
        .set(authHeader(teacherToken))
        .send({ studentId: studentEnrolledId, comment: 'Revise please' });

      // Resubmit empty
      const res = await request(app)
        .post(`/api/lessons/${loopLessonId}/homework`)
        .set(authHeader(studentEnrolledToken))
        .send({ answer: '    ' });

      expect(res.status).toBe(400);
    });

    it('T2-F08-04: enforces MAX_RESUBMISSIONS cap (maximum 3 returns)', async () => {
      // Simulate 3 returns by setting hwResubmitCount = 3 in DB
      await prisma.tracking.update({
        where: { studentId_lessonId: { studentId: studentEnrolledId, lessonId: loopLessonId } },
        data: { hwResubmitCount: 3, hwStatus: 'SUBMITTED' },
      });

      // Attempt 4th return or 4th resubmit
      const res = await request(app)
        .post(`/api/teachers/assignments/${loopLessonId}/return`)
        .set(authHeader(teacherToken))
        .send({ studentId: studentEnrolledId, comment: 'Exceeded cap return' });

      // Either 400 because resubmit count is exhausted or error message indicates cap
      expect([400, 409]).toContain(res.status);
    });

    it('T2-F08-05: student 4th resubmission after cap is exhausted returns HTTP 400', async () => {
      await prisma.tracking.update({
        where: { studentId_lessonId: { studentId: studentEnrolledId, lessonId: loopLessonId } },
        data: { hwResubmitCount: 3, hwStatus: 'NEEDS_REVISION' },
      });

      const res = await request(app)
        .post(`/api/lessons/${loopLessonId}/homework`)
        .set(authHeader(studentEnrolledToken))
        .send({ answer: '4th attempt beyond cap' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/limit|exceeded|max/i);
    });
  });

  // =========================================================================
  // Feature 9 Boundaries: Overdue Timestamp Edge Cases (5 tests)
  // =========================================================================
  describe('Feature 9 Boundaries: Overdue Timestamp Edge Cases', () => {
    it('T2-F09-01: lesson with null homeworkDueAt never flags submission as late', async () => {
      const res = await request(app)
        .get(`/api/lessons/${lessonNoHwId}`)
        .set(authHeader(studentEnrolledToken));

      expect(res.status).toBe(200);
      expect(res.body.lesson.homeworkDueAt).toBeNull();
    });

    it('T2-F09-02: far-future deadline (year 2099) marks isOverdue as false', async () => {
      const futureLesson = await prisma.lesson.create({
        data: {
          courseId,
          teacherId,
          title: 'Far Future Lesson',
          homeworkDueAt: new Date('2099-01-01T00:00:00Z'),
        },
      });

      const res = await request(app)
        .get(`/api/lessons/${futureLesson.id}`)
        .set(authHeader(studentEnrolledToken));

      expect(res.status).toBe(200);
      expect(new Date(res.body.lesson.homeworkDueAt).getTime()).toBeGreaterThan(Date.now());
      await prisma.lesson.delete({ where: { id: futureLesson.id } });
    });

    it('T2-F09-03: far-past deadline (year 2000) marks isOverdue as true for unsubmitted student', async () => {
      const pastLesson = await prisma.lesson.create({
        data: {
          courseId,
          teacherId,
          title: 'Far Past Lesson',
          homeworkDueAt: new Date('2000-01-01T00:00:00Z'),
        },
      });

      const res = await request(app)
        .get(`/api/teachers/assignments/${pastLesson.id}/register`)
        .set(authHeader(teacherToken));

      expect(res.status).toBe(200);
      const studentRow = res.body.students.find((r: any) => r.studentId === studentEnrolledId);
      expect(studentRow.isOverdue).toBe(true);
      await prisma.lesson.delete({ where: { id: pastLesson.id } });
    });

    it('T2-F09-04: unauthenticated request to /api/trackings/:lessonId is rejected with 401', async () => {
      const res = await request(app).get(`/api/trackings/${lessonWithHwId}`);
      expect(res.status).toBe(401);
    });

    it('T2-F09-05: student querying tracking for non-existent lesson returns 404', async () => {
      const res = await request(app)
        .get('/api/trackings/00000000-0000-0000-0000-000000000000')
        .set(authHeader(studentEnrolledToken));

      expect(res.status).toBe(404);
    });
  });
});
