import request from 'supertest';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import app from '../app';

import prisma from '../config/prisma';

/**
 * Attendance split-brain contract.
 *
 * `AttendanceRecord` is the one authoritative attendance source: the only way to
 * create a row is the staff-gated QR flow (`POST /api/attendance/mark`), which
 * requires a signed single-use student token and burns its `jti` in
 * `AttendanceQrUse`. `Tracking.isPresent` is the legacy column, written by
 * self-report (`POST /api/tracking/attend`, `POST /api/lessons/mark-attendance`)
 * and historically also by homework grading.
 *
 * These tests exist because two independent "present" facts used to disagree:
 * a student scanned by QR was invisible to the parent's statistics, while a
 * student who merely opened a lesson looked present. Every assertion here reads
 * through a real HTTP surface rather than the Express route table, and the
 * "absent" fixtures deliberately carry a `Tracking.isPresent = true` row so a
 * read path that still consults the legacy column cannot pass by accident.
 */

// `phone` is a unique column and every suite shares one database, so these ten
// numbers are reserved to this file. Never reuse another suite's fixture.
const PHONES = {
  PRESENT_STUDENT: '01000000801',
  ABSENT_STUDENT: '01000000802',
  PARENT: '01000000803',
  TEACHER: '01000000804',
  OTHER_TEACHER: '01000000805',
  INTRUDER_STUDENT: '01000000806',
} as const;

const PASSWORD = 'SplitBrain@2026';

// Every row this suite owns is namespaced by these prefixes so cleanup is
// re-runnable and incapable of touching another suite's data. Nothing here is
// ever deleted with an unfiltered deleteMany.
const COURSE_PREFIX = 'SplitBrain-Course-';
const SUBJECT_PREFIX = 'SplitBrain-Subject-';
const GRADE = 'grade-split-brain';

const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};

const login = async (key: keyof typeof PHONES): Promise<string> => {
  const res = await request(app)
    .post('/api/auth/login')
    .set('X-Device-Name', 'attendance-split-brain')
    .send({ identifier: PHONES[key], password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.token as string;
};

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const upsertUser = async (key: keyof typeof PHONES, role: string) => {
  const phone = PHONES[key];
  // Upsert rather than delete-then-create: CourseEnrollment.studentId and
  // AttendanceRecord.studentId have no onDelete action, so the database rejects
  // removing a user that still owns child rows.
  const row = await prisma.user.upsert({
    where: { phone },
    update: {
      role,
      status: 'approved',
      isApproved: true,
      isVerified: true,
      password: await bcrypt.hash(PASSWORD, 10),
    },
    create: {
      name: `SplitBrain ${key}`,
      phone,
      email: `split-brain-${phone}@example.com`,
      password: await bcrypt.hash(PASSWORD, 10),
      role,
      status: 'approved',
      isApproved: true,
      isVerified: true,
    },
  });
  ids[key] = row.id;
};

const cleanupFixtures = async (): Promise<void> => {
  const courses = await prisma.course.findMany({
    where: { title: { startsWith: COURSE_PREFIX } },
    select: { id: true },
  });
  const courseIds = courses.map((c) => c.id);

  if (courseIds.length > 0) {
    await prisma.courseEnrollment.deleteMany({ where: { courseId: { in: courseIds } } });
    await prisma.lessonProgress.deleteMany({ where: { courseId: { in: courseIds } } });
    await prisma.lesson.deleteMany({ where: { courseId: { in: courseIds } } });
    await prisma.course.deleteMany({ where: { id: { in: courseIds } } });
  }

  // Sessions cascade to their records, so removing the session removes the
  // AttendanceRecord rows too.
  await prisma.attendanceSession.deleteMany({
    where: { subject: { startsWith: SUBJECT_PREFIX } },
  });

  const studentIds = Object.values(ids).filter((id) => id);
  if (studentIds.length > 0) {
    await prisma.studentParentRelation.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.tracking.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.attendanceQrUse.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: studentIds } } });
  }
};

let COURSE_ID: string;
let LESSON_ID: string;
let SESSION_ID: string;
const SUBJECT = `${SUBJECT_PREFIX}math`;

beforeAll(async () => {
  await cleanupFixtures();

  await upsertUser('TEACHER', 'TEACHER');
  await upsertUser('OTHER_TEACHER', 'TEACHER');
  await upsertUser('PRESENT_STUDENT', 'STUDENT');
  await upsertUser('ABSENT_STUDENT', 'STUDENT');
  await upsertUser('INTRUDER_STUDENT', 'STUDENT');
  await upsertUser('PARENT', 'PARENT');

  // The parent sees both students, which keeps the "reported present" assertion
  // comparable across the two of them.
  await prisma.studentParentRelation.upsert({
    where: {
      studentId_parentId: {
        studentId: ids.PRESENT_STUDENT,
        parentId: ids.PARENT,
      },
    },
    create: { studentId: ids.PRESENT_STUDENT, parentId: ids.PARENT },
    update: {},
  });
  await prisma.studentParentRelation.upsert({
    where: {
      studentId_parentId: { studentId: ids.ABSENT_STUDENT, parentId: ids.PARENT },
    },
    create: { studentId: ids.ABSENT_STUDENT, parentId: ids.PARENT },
    update: {},
  });

  const course = await prisma.course.create({
    data: {
      teacherId: ids.TEACHER,
      title: `${COURSE_PREFIX}math`,
      subject: SUBJECT,
      grade: GRADE,
      price: 0,
      priceMinor: 0,
      isPublished: true,
    },
  });
  COURSE_ID = course.id;

  const lesson = await prisma.lesson.create({
    data: {
      courseId: COURSE_ID,
      subject: SUBJECT,
      grade: GRADE,
      teacherId: ids.TEACHER,
      title: `${COURSE_PREFIX}lesson`,
      homeworkText: 'Split-brain regression homework',
    },
  });
  LESSON_ID = lesson.id;

  const enrolled = [ids.PRESENT_STUDENT, ids.ABSENT_STUDENT, ids.INTRUDER_STUDENT];
  for (const studentId of enrolled) {
    await prisma.courseEnrollment.upsert({
      where: { studentId_courseId: { studentId, courseId: COURSE_ID } },
      create: {
        studentId,
        courseId: COURSE_ID,
        paymentMethod: 'CREDIT',
        status: 'APPROVED',
      },
      update: { status: 'APPROVED' },
    });
  }

  // The absent student carries a legacy `Tracking.isPresent = true` row: this is
  // exactly what the old read path turned into invented attendance. No
  // AttendanceRecord is ever created for this student.
  await prisma.tracking.upsert({
    where: { studentId_lessonId: { studentId: ids.ABSENT_STUDENT, lessonId: LESSON_ID } },
    create: {
      studentId: ids.ABSENT_STUDENT,
      lessonId: LESSON_ID,
      isPresent: true,
      hwStatus: 'SUBMITTED',
      hwSubmittedAt: new Date(),
    },
    update: { isPresent: true, hwStatus: 'SUBMITTED' },
  });

  for (const key of Object.keys(PHONES) as (keyof typeof PHONES)[]) {
    tokens[key] = await login(key);
  }

  const sessionRes = await request(app)
    .post('/api/attendance/sessions')
    .set(bearer(tokens.TEACHER))
    .send({ subject: SUBJECT, grade: GRADE });
  expect(sessionRes.status).toBe(201);
  SESSION_ID = sessionRes.body.session.id;
});

afterAll(async () => {
  await cleanupFixtures();
  await prisma.$disconnect();
});

/**
 * Drive the real QR flow end to end: the student asks for their own signed
 * one-time token and the teacher scans it. This is the only path that may create
 * an AttendanceRecord, so using it keeps the fixtures honest.
 */
const markPresentByQr = async (studentKey: keyof typeof PHONES): Promise<void> => {
  const tokenRes = await request(app)
    .get('/api/attendance/qr-token')
    .set(bearer(tokens[studentKey]));
  expect(tokenRes.status).toBe(200);

  const markRes = await request(app)
    .post('/api/attendance/mark')
    .set(bearer(tokens.TEACHER))
    .send({ sessionId: SESSION_ID, qrToken: tokenRes.body.token });
  expect(markRes.status).toBe(201);
};

describe('AttendanceRecord is the only authority for attendance', () => {
  it('reports a QR-marked student in the attendance statistics a parent sees', async () => {
    await markPresentByQr('PRESENT_STUDENT');

    // The record itself must exist, otherwise the statistics assertions below
    // would pass for the wrong reason.
    expect(
      await prisma.attendanceRecord.count({
        where: { sessionId: SESSION_ID, studentId: ids.PRESENT_STUDENT },
      }),
    ).toBe(1);

    const res = await request(app)
      .get(`/api/analytics/attendance/students/${ids.PRESENT_STUDENT}`)
      .set(bearer(tokens.PARENT));

    expect(res.status).toBe(200);
    expect(res.body.student.id).toBe(ids.PRESENT_STUDENT);
    expect(res.body.presentCount).toBe(1);
    expect(res.body.sessionCount).toBeGreaterThanOrEqual(1);
    expect(res.body.attendanceRate).toBeGreaterThan(0);
    // The specific session must be named, so a parent can see *when* it happened.
    expect(
      res.body.sessions.map((s: { sessionId: string }) => s.sessionId),
    ).toContain(SESSION_ID);

    // The same fact must be visible on the parent's existing stats surface, so
    // this fix cannot be satisfied by adding a second, disconnected number.
    const stats = await request(app)
      .get(`/api/parents/child/${ids.PRESENT_STUDENT}/stats`)
      .set(bearer(tokens.PARENT));
    expect(stats.status).toBe(200);
    expect(stats.body.physicalAttendanceCount).toBeGreaterThanOrEqual(1);
    expect(stats.body.attendanceRate).toBeGreaterThan(0);
  });

  it('never reports a student with no AttendanceRecord as present, even with a legacy isPresent row', async () => {
    // Guard the premise: the legacy flag is set, the authoritative record is not.
    const legacy = await prisma.tracking.findUnique({
      where: { studentId_lessonId: { studentId: ids.ABSENT_STUDENT, lessonId: LESSON_ID } },
    });
    expect(legacy?.isPresent).toBe(true);
    expect(
      await prisma.attendanceRecord.count({ where: { studentId: ids.ABSENT_STUDENT } }),
    ).toBe(0);

    const res = await request(app)
      .get(`/api/analytics/attendance/students/${ids.ABSENT_STUDENT}`)
      .set(bearer(tokens.PARENT));

    expect(res.status).toBe(200);
    expect(res.body.presentCount).toBe(0);
    expect(res.body.attendanceRate).toBe(0);
    expect(res.body.sessions).toHaveLength(0);

    const stats = await request(app)
      .get(`/api/parents/child/${ids.ABSENT_STUDENT}/stats`)
      .set(bearer(tokens.PARENT));
    expect(stats.status).toBe(200);
    expect(stats.body.physicalAttendanceCount).toBe(0);
    expect(stats.body.attendanceRate).toBe(0);
  });

  it('returns only real records from the teacher register', async () => {
    const res = await request(app)
      .get(`/api/attendance/sessions/${SESSION_ID}/register`)
      .set(bearer(tokens.TEACHER));

    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe(SESSION_ID);

    const rows = res.body.students as {
      id: string;
      name: string;
      present: boolean;
      timestamp: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(ids.PRESENT_STUDENT);
    expect(rows[0].present).toBe(true);
    expect(typeof rows[0].timestamp).toBe('string');

    // The enrolled-but-unscanned students must be reported as a count, never as
    // invented rows, so the teacher still sees the denominator.
    expect(res.body.enrolledCount).toBe(3);
    expect(res.body.presentCount).toBe(1);

    // A register row must be a real AttendanceRecord, not a legacy flag.
    const recordRows = await prisma.attendanceRecord.findMany({
      where: { sessionId: SESSION_ID },
      select: { studentId: true },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(recordRows.map((r) => r.studentId).sort());
  });

  it('rejects a teacher reading another owner\'s register', async () => {
    const res = await request(app)
      .get(`/api/attendance/sessions/${SESSION_ID}/register`)
      .set(bearer(tokens.OTHER_TEACHER));

    expect(res.status).toBe(404);
  });
});

describe('attendance cannot be manufactured', () => {
  it('grading homework changes no attendance record and no isPresent value', async () => {
    const before = {
      records: await prisma.attendanceRecord.count({ where: { studentId: ids.ABSENT_STUDENT } }),
      presentTracking: await prisma.tracking.findUnique({
        where: { studentId_lessonId: { studentId: ids.ABSENT_STUDENT, lessonId: LESSON_ID } },
        select: { isPresent: true, hwStatus: true },
      }),
    };
    expect(before.records).toBe(0);

    const res = await request(app)
      .post(`/api/teachers/assignments/${LESSON_ID}/status`)
      .set(bearer(tokens.TEACHER))
      .send({ status: 'GRADED', studentId: ids.ABSENT_STUDENT });

    expect(res.status).toBe(200);

    const after = await prisma.tracking.findUnique({
      where: { studentId_lessonId: { studentId: ids.ABSENT_STUDENT, lessonId: LESSON_ID } },
      select: { isPresent: true, hwStatus: true },
    });

    expect(after?.hwStatus).toBe('GRADED');
    expect(after?.isPresent).toBe(before.presentTracking?.isPresent);
    expect(
      await prisma.attendanceRecord.count({ where: { studentId: ids.ABSENT_STUDENT } }),
    ).toBe(before.records);

    // And the read path still says absent.
    const stats = await request(app)
      .get(`/api/analytics/attendance/students/${ids.ABSENT_STUDENT}`)
      .set(bearer(tokens.PARENT));
    expect(stats.status).toBe(200);
    expect(stats.body.presentCount).toBe(0);
  });

  it('refuses to let a STUDENT mark another student present', async () => {
    const markRes = await request(app)
      .post('/api/attendance/mark')
      .set(bearer(tokens.INTRUDER_STUDENT))
      .send({
        sessionId: SESSION_ID,
        qrToken: 'whatever',
        studentId: ids.ABSENT_STUDENT,
      });

    expect(markRes.status).toBe(403);
    expect(
      await prisma.attendanceRecord.count({
        where: { sessionId: SESSION_ID, studentId: ids.ABSENT_STUDENT },
      }),
    ).toBe(0);
    expect(
      await prisma.attendanceRecord.count({
        where: { sessionId: SESSION_ID, studentId: ids.INTRUDER_STUDENT },
      }),
    ).toBe(0);

    // The legacy self-report route is the other write path, and it is the one a
    // student can reach. A peer id in the body must never be honoured.
    //
    // Path note: the tracking router is mounted at /api/trackings in app.ts.
    // /api/tracking/attend was a guess that 404'd, which would have made this
    // assertion pass for the wrong reason — a 404 is not a 403.
    const selfReport = await request(app)
      .post('/api/trackings/attend')
      .set(bearer(tokens.INTRUDER_STUDENT))
      .send({ lessonId: LESSON_ID, studentId: ids.ABSENT_STUDENT });

    expect(selfReport.status).toBe(403);
    expect(
      await prisma.attendanceRecord.count({ where: { studentId: ids.ABSENT_STUDENT } }),
    ).toBe(0);

    // And the record-backed surfaces a student could otherwise use to assert or
    // read presence must be closed to students entirely.
    const register = await request(app)
      .get(`/api/attendance/sessions/${SESSION_ID}/register`)
      .set(bearer(tokens.INTRUDER_STUDENT));
    expect(register.status).toBe(403);

    const peerStats = await request(app)
      .get(`/api/analytics/attendance/students/${ids.PRESENT_STUDENT}`)
      .set(bearer(tokens.INTRUDER_STUDENT));
    expect(peerStats.status).toBe(403);
  });

  it('refuses to let a STUDENT self-report through the legacy tracking route', async () => {
    const res = await request(app)
      .post('/api/trackings/attend')
      .set(bearer(tokens.INTRUDER_STUDENT))
      .send({ lessonId: LESSON_ID });

    expect(res.status).toBe(200);

    // The legacy write is still accepted so student lesson-engagement progress
    // keeps working, but it must not create attendance and must not be readable
    // as attendance.
    expect(
      await prisma.attendanceRecord.count({
        where: { sessionId: SESSION_ID, studentId: ids.INTRUDER_STUDENT },
      }),
    ).toBe(0);

    // A teacher may read a student's record-backed statistics; the numbers must
    // still say the student was never scanned.
    const stats = await request(app)
      .get(`/api/analytics/attendance/students/${ids.INTRUDER_STUDENT}`)
      .set(bearer(tokens.TEACHER));
    expect(stats.status).toBe(200);
    expect(stats.body.presentCount).toBe(0);
  });

  it('does not let a teacher roster expose Tracking.isPresent as attendance', async () => {
    const res = await request(app)
      .get('/api/lessons/fetch-students')
      .set(bearer(tokens.TEACHER));

    expect(res.status).toBe(200);
    const students = res.body as {
      id: string;
      lessons: { isPresent: boolean | null }[];
    }[];
    const row = students.find((s) => s.id === ids.ABSENT_STUDENT);
    expect(row).toBeDefined();
    // isPresent is legacy lesson engagement. It must be reported as such (null),
    // never as a truthy attendance claim for a student with no record.
    for (const lesson of row!.lessons) {
      expect(lesson.isPresent).toBeNull();
    }
  });
});
