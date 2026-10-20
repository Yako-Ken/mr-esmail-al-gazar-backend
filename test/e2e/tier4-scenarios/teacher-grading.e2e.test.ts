import request from 'supertest';
import app from '../../../src/app';
import prisma from '../../../src/config/prisma';
import {
  authHeader,
  cleanE2EData,
  createSignedQrToken,
  E2E_JWT_SECRET,
  ensureE2EUser,
  loginUser,
} from '../helpers/test-helper';

const PHONES = {
  teacher: '01000008821',
  student: '01000008822',
};

describe('Tier 4 Scenario 2: Teacher Grading & Attendance Lifecycle', () => {
  let teacherToken: string;
  let teacherId: string;
  let studentToken: string;
  let studentId: string;
  let courseId: string;
  let lessonId: string;
  let sessionId: string;

  beforeAll(async () => {
    await cleanE2EData(Object.values(PHONES));

    const teacher = await ensureE2EUser({
      phone: PHONES.teacher,
      role: 'TEACHER',
      name: 'Classroom Teacher',
    });
    teacherId = teacher.id;

    const student = await ensureE2EUser({
      phone: PHONES.student,
      role: 'STUDENT',
      name: 'Classroom Student',
    });
    studentId = student.id;

    teacherToken = (await loginUser(PHONES.teacher)).token;
    studentToken = (await loginUser(PHONES.student)).token;

    // Create course, enrollment, and lesson
    const course = await prisma.course.create({
      data: {
        teacherId,
        title: 'Classroom Lifecycle Course',
        isPublished: true,
      },
    });
    courseId = course.id;

    await prisma.courseEnrollment.create({
      data: {
        studentId,
        courseId,
        paymentMethod: 'CASH',
        status: 'APPROVED',
      },
    });

    const lesson = await prisma.lesson.create({
      data: {
        courseId,
        teacherId,
        title: 'Classroom Homework Lesson',
        homeworkText: 'Write a chemistry summary.',
        homeworkDueAt: new Date(Date.now() + 24 * 3600 * 1000),
      },
    });
    lessonId = lesson.id;
  }, 60000);

  afterAll(async () => {
    await prisma.attendanceRecord.deleteMany({ where: { studentId } });
    await prisma.attendanceQrUse.deleteMany({ where: { studentId } });
    if (sessionId) {
      await prisma.attendanceSession.deleteMany({ where: { id: sessionId } });
    }
    await cleanE2EData(Object.values(PHONES), [courseId]);
    await prisma.$disconnect();
  });

  // =========================================================================
  // Scenario 2: Step-by-Step Teacher Grading & Attendance
  // =========================================================================
  it('Step 1: Teacher creates classroom attendance session for the day', async () => {
    const res = await request(app)
      .post('/api/attendance/sessions')
      .set(authHeader(teacherToken))
      .send({
        subject: 'Chemistry',
        grade: 'Grade 11',
      });

    expect(res.status).toBe(201);
    expect(res.body.session.subject).toBe('Chemistry');
    sessionId = res.body.session.id;
  });

  it('Step 2: Teacher checks assignment register and sees student in NOT_SUBMITTED state', async () => {
    const res = await request(app)
      .get(`/api/teachers/assignments/${lessonId}/register`)
      .set(authHeader(teacherToken));

    expect(res.status).toBe(200);
    const studentEntry = res.body.students.find((r: any) => r.studentId === studentId);
    expect(studentEntry).toBeDefined();
    expect(studentEntry.status).toBe('NOT_SUBMITTED');
  });

  it('Step 3: Student submits draft; teacher inspects submission and returns for revision', async () => {
    // Student submits initial draft
    const submitRes = await request(app)
      .post(`/api/lessons/${lessonId}/homework`)
      .set(authHeader(studentToken))
      .send({ answer: 'Initial chemistry notes without chemical equations.' });
    expect(submitRes.status).toBe(201);

    // Teacher returns for revision with actionable feedback
    const returnRes = await request(app)
      .post(`/api/teachers/assignments/${lessonId}/return`)
      .set(authHeader(teacherToken))
      .send({
        studentId,
        comment: 'Please include balanced chemical reaction equations.',
      });

    expect(returnRes.status).toBe(200);
    expect(returnRes.body.result.hwStatus).toBe('NEEDS_REVISION');
  });

  it('Step 4: Student resubmits revised work; teacher awards full grade locking the submission', async () => {
    // Student resubmits
    const resubmitRes = await request(app)
      .post(`/api/lessons/${lessonId}/homework`)
      .set(authHeader(studentToken))
      .send({ answer: 'Revised chemistry notes with: 2H2 + O2 -> 2H2O.' });
    expect(resubmitRes.status).toBe(201);

    // Teacher grades
    const gradeRes = await request(app)
      .post(`/api/teachers/assignments/${lessonId}/grade`)
      .set(authHeader(teacherToken))
      .send({
        studentId,
        grade: 10,
        maxGrade: 10,
        comment: 'Excellent revision with proper formulas.',
      });

    expect(gradeRes.status).toBe(200);
    expect(gradeRes.body.result.hwStatus).toBe('GRADED');
    expect(gradeRes.body.result.hwGrade).toBe(10);
  });

  it('Step 5: Teacher scans student QR token to mark attendance and confirms in session register', async () => {
    // Student generates QR token
    const qr = createSignedQrToken(studentId, E2E_JWT_SECRET, 30);

    // Teacher marks attendance
    const markRes = await request(app)
      .post('/api/attendance/mark')
      .set(authHeader(teacherToken))
      .send({
        sessionId,
        qrToken: qr.token,
      });

    expect(markRes.status).toBe(201);
    expect(markRes.body.student.id).toBe(studentId);

    // Verify session register
    const registerRes = await request(app)
      .get(`/api/attendance/sessions/${sessionId}/register`)
      .set(authHeader(teacherToken));

    expect(registerRes.status).toBe(200);
    const record = registerRes.body.students.find((r: any) => r.id === studentId);
    expect(record).toBeDefined();
  });
});
