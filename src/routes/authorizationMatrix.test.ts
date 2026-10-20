import request from 'supertest';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import app from '../app';

/**
 * Cross-role authorization matrix.
 *
 * The defect this suite exists to catch: `GET /api/analytics/funnel` is declared
 * as a four-line `router.get('/funnel', authMiddleware, roleMiddleware(...),
 * handler)` call, so the role gate is not visible on the same line as the path.
 * A reader scanning for "which routes are admin-only?" by grepping the route
 * path and its guards on one line sees nothing, and concludes the endpoint is
 * unguarded. Every assertion below therefore goes through real HTTP rather than
 * through the Express route table, so a gate that is moved, dropped, or replaced
 * by a handler-local check is caught regardless of where it lives in the file.
 *
 * Expectations are transcribed from the real middleware chains, not guessed:
 *
 *   GET  /api/analytics/funnel              analytics.routes.ts:46   auth + SUPER_ADMIN
 *   GET  /api/admin/users/dashboard-stats    admin.routes.ts:21-25    router.use auth + SUPER_ADMIN
 *   GET  /api/teachers/stats                 teacher.routes.ts:455    auth + TEACHER/ASSISTANT/SUPER_ADMIN + isApprovedUser
 *   GET  /api/parents/my-children            parent.routes.ts:19      auth only; PARENT enforced in controller
 *   GET  /api/store/my-courses               store.routes.ts:15       auth + STUDENT
 *   POST /api/attendance/sessions            attendance.routes.ts:262 auth + TEACHER/ASSISTANT/SUPER_ADMIN
 *   POST /api/teachers/students/:id/enroll   teacher.routes.ts:488    auth + TEACHER/ASSISTANT/SUPER_ADMIN + isApprovedUser
 *
 * Note the two mount paths that do not match their colloquial names:
 *   - dashboard-stats hangs off /api/admin/users (adminRoutes), not /api/admin
 *   - the teacher surface is /api/teachers (plural); /api/teacher is closed
 *     off as a duplicate mount, see routeMounts.routes.test.ts
 */

import prisma from '../config/prisma';

const PASSWORD = 'AuthzMatrix@2026';

// Phones are unique across the whole suite and reserved to this file. They must
// never be reused by another suite: `User.phone` is a unique column and the
// suites share one database.
const PHONES = {
  STUDENT: '01000000901',
  TEACHER: '01000000902',
  PARENT: '01000000903',
  ASSISTANT: '01000000905',
  SUPER_ADMIN: '01000000904',
} as const;

type Role = keyof typeof PHONES;
const ROLES = Object.keys(PHONES) as Role[];

// Every fixture this suite creates is namespaced by these prefixes so cleanup can
// be both re-runnable and incapable of touching another suite's rows. Nothing
// here is ever deleted with an unfiltered deleteMany.
const COURSE_PREFIX = 'AuthzMatrix-Course-';
const SESSION_PREFIX = 'AuthzMatrix-Session-';
const GRADE = 'grade-authz-matrix';

const tokens: Partial<Record<Role, string>> = {};

let courseForTeacher: string;
let courseForAssistant: string;
let STUDENT_ID: string;

/**
 * Delete only the rows this suite owns. Order matters: CourseEnrollment has an
 * FK to User with no onDelete action, so a user that owns an enrollment cannot
 * be deleted — the enrollment has to go first.
 */
const cleanupFixtures = async (): Promise<void> => {
  const courses = await prisma.course.findMany({
    where: { title: { startsWith: COURSE_PREFIX } },
    select: { id: true },
  });
  const courseIds = courses.map((c) => c.id);

  if (courseIds.length > 0) {
    await prisma.courseEnrollment.deleteMany({ where: { courseId: { in: courseIds } } });
    await prisma.lessonProgress.deleteMany({ where: { courseId: { in: courseIds } } });
    await prisma.course.deleteMany({ where: { id: { in: courseIds } } });
  }

  await prisma.attendanceSession.deleteMany({
    where: { subject: { startsWith: SESSION_PREFIX } },
  });
};

beforeAll(async () => {
  await cleanupFixtures();

  // Upsert rather than delete-then-create: CourseEnrollment.studentId has no
  // onDelete action, so removing a user that owns an enrollment is rejected by
  // the database. Upserting keeps the suite idempotent without residue.
  const upserted: Partial<Record<Role, string>> = {};

  for (const role of ROLES) {
    const phone = PHONES[role];
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
        name: `AuthzMatrix ${role}`,
        phone,
        email: `authz-matrix-${phone}@example.com`,
        password: await bcrypt.hash(PASSWORD, 10),
        role,
        status: 'approved',
        isApproved: true,
        isVerified: true,
      },
    });
    upserted[role] = row.id;
  }

  // The assistant only ever acts through its parent teacher's ownership scope
  // (resolveOwnerId / getOwnerId both collapse ASSISTANT to parentTeacherId), so
  // it must be wired to a real teacher for the staff endpoints to behave.
  await prisma.user.update({
    where: { phone: PHONES.ASSISTANT },
    data: { parentTeacherId: upserted.TEACHER },
  });

  const stamp = Date.now();

  const teacherCourse = await prisma.course.create({
    data: {
      teacherId: upserted.TEACHER!,
      title: `${COURSE_PREFIX}teacher-${stamp}`,
      subject: 'Physics',
      grade: GRADE,
      price: 150,
      priceMinor: 15000,
      currency: 'EGP',
      isPublished: true,
    },
    select: { id: true },
  });
  courseForTeacher = teacherCourse.id;

  const assistantCourse = await prisma.course.create({
    data: {
      teacherId: upserted.TEACHER!,
      title: `${COURSE_PREFIX}assistant-${stamp}`,
      subject: 'Chemistry',
      grade: GRADE,
      price: 150,
      priceMinor: 15000,
      currency: 'EGP',
      isPublished: true,
    },
    select: { id: true },
  });
  courseForAssistant = assistantCourse.id;

  STUDENT_ID = upserted.STUDENT!;

  for (const role of ROLES) {
    const res = await request(app)
      .post('/api/auth/login')
      .set('X-Device-Name', 'authorization-matrix')
      .send({ identifier: PHONES[role], password: PASSWORD });
    expect(res.status).toBe(200);
    tokens[role] = res.body.token as string;
  }
});

afterAll(async () => {
  await cleanupFixtures();
  await prisma.$disconnect();
});

// The manual-enroll handler is not idempotent: enrolling an already-APPROVED
// pair answers 400. Resetting the two fixture pairs before each probe means every
// role is measured from the same starting state, and no enrollment this suite
// creates can leak into a later test's expectation.
beforeEach(async () => {
  await prisma.courseEnrollment.deleteMany({
    where: { courseId: { in: [courseForTeacher, courseForAssistant] } },
  });
});

/** Issue a request as one of the roles, or with no credentials at all. */
const call = async (
  method: 'get' | 'post',
  path: string,
  role: Role | null,
  body?: Record<string, unknown>,
) => {
  const headers: Record<string, string> = {};
  if (role) headers.Authorization = `Bearer ${tokens[role]}`;
  const agent = method === 'get' ? request(app).get(path) : request(app).post(path);
  if (Object.keys(headers).length > 0) agent.set(headers);
  if (body !== undefined) agent.send(body);
  return agent;
};

describe('authorization matrix: read-only sensitive endpoints', () => {
  type Expectation = Record<Role, number>;

  const READ_ENDPOINTS: Array<{
    label: string;
    path: string;
    expected: Expectation;
  }> = [
    {
      label: 'GET /api/analytics/funnel',
      path: '/api/analytics/funnel',
      // roleMiddleware('SUPER_ADMIN') — platform-wide conversion counts.
      expected: {
        STUDENT: 403,
        TEACHER: 403,
        PARENT: 403,
        ASSISTANT: 403,
        SUPER_ADMIN: 200,
      },
    },
    {
      label: 'GET /api/admin/users/dashboard-stats',
      path: '/api/admin/users/dashboard-stats',
      // router.use(roleMiddleware('SUPER_ADMIN')) on the whole admin router.
      expected: {
        STUDENT: 403,
        TEACHER: 403,
        PARENT: 403,
        ASSISTANT: 403,
        SUPER_ADMIN: 200,
      },
    },
    {
      label: 'GET /api/teachers/stats',
      path: '/api/teachers/stats',
      // roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN') + isApprovedUser.
      expected: {
        STUDENT: 403,
        TEACHER: 200,
        PARENT: 403,
        ASSISTANT: 200,
        SUPER_ADMIN: 200,
      },
    },
    {
      label: 'GET /api/parents/my-children',
      path: '/api/parents/my-children',
      // The router applies authMiddleware ONLY (parent.routes.ts:19). The PARENT
      // gate lives inside the handler (parent.controller.ts:155), so the
      // observable contract is still "PARENT only" — proven here over HTTP.
      expected: {
        STUDENT: 403,
        TEACHER: 403,
        PARENT: 200,
        ASSISTANT: 403,
        SUPER_ADMIN: 403,
      },
    },
    {
      label: 'GET /api/store/my-courses',
      path: '/api/store/my-courses',
      // roleMiddleware('STUDENT') — the student's own purchase list.
      expected: {
        STUDENT: 200,
        TEACHER: 403,
        PARENT: 403,
        ASSISTANT: 403,
        SUPER_ADMIN: 403,
      },
    },
  ];

  for (const endpoint of READ_ENDPOINTS) {
    describe(endpoint.label, () => {
      for (const role of ROLES) {
        // The test name carries the endpoint and the role, so a failure here
        // names the exact broken cell of the matrix.
        it(`${role} receives ${endpoint.expected[role]}`, async () => {
          const res = await call('get', endpoint.path, role);
          expect(res.status).toBe(endpoint.expected[role]);
        });
      }

      it('anonymous receives 401, never 403 and never data', async () => {
        const res = await call('get', endpoint.path, null);
        expect(res.status).toBe(401);
      });
    });
  }

  it('the analytics funnel body is withheld from every non-admin role', async () => {
    // A 403 is only meaningful if the payload is actually empty: an endpoint
    // that returned 200 with a redacted body would still leak shape.
    for (const role of ['STUDENT', 'TEACHER', 'PARENT', 'ASSISTANT'] as const) {
      const res = await call('get', '/api/analytics/funnel', role);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toMatch(/stats/i);
    }
  });

  it('the dashboard-stats body is withheld from every non-admin role', async () => {
    for (const role of ['STUDENT', 'TEACHER', 'PARENT', 'ASSISTANT'] as const) {
      const res = await call('get', '/api/admin/users/dashboard-stats', role);
      expect(res.status).toBe(403);
      expect(res.body.totalUsers).toBeUndefined();
      expect(res.body.totalStudents).toBeUndefined();
    }
  });

  it('a PARENT cannot enumerate children through any other role identity', async () => {
    // The students in this suite have no verified StudentParentRelation, so even
    // the one role that is allowed in must see an empty list rather than every
    // student in the database.
    const res = await call('get', '/api/parents/my-children', 'PARENT');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ children: [] });
  });

  it('refuses a token whose role claim was forged, on more than one endpoint', async () => {
    // auth.middleware rebuilds req.user from the database row rather than
    // trusting decoded.role, so editing the claim changes nothing. Asserted on
    // two different routers to show the property belongs to the middleware and
    // not to a single handler.
    const jwt = require('jsonwebtoken');
    const decoded = jwt.decode(tokens.STUDENT!) as Record<string, unknown>;
    const { exp: _exp, iat: _iat, ...claims } = decoded;

    const forged = jwt.sign(
      { ...claims, role: 'SUPER_ADMIN' },
      process.env.JWT_SECRET as string,
      { expiresIn: '1h' },
    );

    for (const path of ['/api/analytics/funnel', '/api/admin/users/dashboard-stats']) {
      const res = await request(app).get(path).set('Authorization', `Bearer ${forged}`);
      expect(res.status).toBe(403);
    }
  });
});

describe('POST /api/attendance/sessions is staff-only', () => {
  // Regression guard: this route once answered 201 for a STUDENT, who could then
  // open their own attendance session and drive their own academic record. The
  // gate now lives in the middleware chain (attendance.routes.ts:260-262).

  it.each(['STUDENT', 'PARENT'] as const)(
    'rejects %s with 403 and persists no session',
    async (role) => {
      const subject = `${SESSION_PREFIX}denied-${role}`;
      await prisma.attendanceSession.deleteMany({ where: { subject } });

      const res = await call('post', '/api/attendance/sessions', role, {
        subject,
        grade: GRADE,
      });

      expect(res.status).toBe(403);
      expect(await prisma.attendanceSession.count({ where: { subject } })).toBe(0);
    },
  );

  it.each(['TEACHER', 'ASSISTANT', 'SUPER_ADMIN'] as const)(
    'allows %s to create a session',
    async (role) => {
      const subject = `${SESSION_PREFIX}allowed-${role}`;
      await prisma.attendanceSession.deleteMany({ where: { subject } });

      const res = await call('post', '/api/attendance/sessions', role, {
        subject,
        grade: GRADE,
      });

      expect(res.status).toBe(201);
      expect(res.body.session.subject).toBe(subject);

      // The session is really in the database, owned by the acting principal.
      const owner = await prisma.user.findUnique({ where: { phone: PHONES[role] } });
      const stored = await prisma.attendanceSession.findFirst({ where: { subject } });
      expect(stored).not.toBeNull();

      const teacher = await prisma.user.findUnique({ where: { phone: PHONES.TEACHER } });
      const expectedOwner =
        role === 'ASSISTANT' ? teacher!.id : owner!.id;
      expect(stored!.ownerId).toBe(expectedOwner);
    },
  );

  it('rejects an anonymous caller with 401', async () => {
    const subject = `${SESSION_PREFIX}denied-anon`;
    const res = await call('post', '/api/attendance/sessions', null, {
      subject,
      grade: GRADE,
    });
    expect(res.status).toBe(401);
    expect(await prisma.attendanceSession.count({ where: { subject } })).toBe(0);
  });
});

describe('POST /api/teachers/students/:studentId/enroll is staff-only and owner-scoped', () => {
  // There is no POST /api/teacher/enrollments: /api/teacher is a closed
  // duplicate mount (routeMounts.routes.test.ts). The real endpoints are
  // GET|PUT /api/teachers/enrollments[/:id] and this manual enroll route.

  // The student id is captured in the outer beforeAll via prisma, so the path is
  // built from the database row rather than a hardcoded id.
  const enrollPath = () => `/api/teachers/students/${STUDENT_ID}/enroll`;

  it.each(['STUDENT', 'PARENT'] as const)('rejects %s with 403 and enrolls nobody', async (role) => {
    const res = await call('post', enrollPath(), role, {
      courseId: courseForTeacher,
    });

    expect(res.status).toBe(403);
    expect(
      await prisma.courseEnrollment.count({ where: { courseId: courseForTeacher } }),
    ).toBe(0);
  });

  it('rejects an anonymous caller with 401', async () => {
    const res = await call('post', enrollPath(), null, {
      courseId: courseForTeacher,
    });
    expect(res.status).toBe(401);
    expect(
      await prisma.courseEnrollment.count({ where: { courseId: courseForTeacher } }),
    ).toBe(0);
  });

  it('allows the owning TEACHER and writes an APPROVED enrollment', async () => {
    const res = await call('post', enrollPath(), 'TEACHER', {
      courseId: courseForTeacher,
    });

    expect(res.status).toBe(200);
    const stored = await prisma.courseEnrollment.findFirst({
      where: { studentId: STUDENT_ID, courseId: courseForTeacher },
    });
    expect(stored?.status).toBe('APPROVED');
    expect(stored?.paymentMethod).toBe('TEACHER_MANUAL');
  });

  it('allows an ASSISTANT to act through its parent teacher ownership scope', async () => {
    const res = await call('post', enrollPath(), 'ASSISTANT', {
      courseId: courseForAssistant,
    });

    expect(res.status).toBe(200);
    const stored = await prisma.courseEnrollment.findFirst({
      where: { studentId: STUDENT_ID, courseId: courseForAssistant },
    });
    expect(stored?.status).toBe('APPROVED');
  });

  it('refuses SUPER_ADMIN on another teacher\'s course (ownership, not a role gap)', async () => {
    // The role gate admits SUPER_ADMIN, but enrollStudentByTeacher scopes the
    // lookup to `teacherId: ownerId` and ownerId for a non-assistant is the
    // caller's own id — so an admin cannot enroll into a teacher's course.
    // Pinned so that a future change is a deliberate decision, not a surprise.
    const res = await call('post', enrollPath(), 'SUPER_ADMIN', {
      courseId: courseForTeacher,
    });

    expect(res.status).toBe(403);
    expect(
      await prisma.courseEnrollment.count({ where: { courseId: courseForTeacher } }),
    ).toBe(0);
  });

  it('refuses a course the acting teacher does not own or that does not exist', async () => {
    // An unresolvable course must not produce an enrollment on either course.
    const res = await call(
      'post',
      enrollPath(),
      'TEACHER',
      { courseId: 'authz-matrix-course-that-does-not-exist' },
    );

    expect(res.status).toBe(403);
    expect(
      await prisma.courseEnrollment.count({
        where: { studentId: STUDENT_ID, courseId: { in: [courseForTeacher, courseForAssistant] } },
      }),
    ).toBe(0);
  });
});

describe('GET /api/teachers/enrollments is staff-only', () => {
  // The read side of the same teacher surface. Guards the case where a route
  // registration is added without its roleMiddleware and therefore leaks every
  // enrollment in the platform to any signed-in student.

  it.each(['STUDENT', 'PARENT'] as const)('rejects %s with 403', async (role) => {
    const res = await call('get', '/api/teachers/enrollments', role);
    expect(res.status).toBe(403);
  });

  it('rejects an anonymous caller with 401', async () => {
    const res = await call('get', '/api/teachers/enrollments', null);
    expect(res.status).toBe(401);
  });

  it('allows the owning TEACHER and returns only this teacher\'s enrollments', async () => {
    // Seed one enrollment on this suite's own course so the scoping assertion
    // below is meaningful rather than vacuously true on an empty list.
    await prisma.courseEnrollment.create({
      data: {
        studentId: STUDENT_ID,
        courseId: courseForTeacher,
        status: 'APPROVED',
        paymentMethod: 'TEACHER_MANUAL',
      },
    });

    const res = await call('get', '/api/teachers/enrollments', 'TEACHER');
    expect(res.status).toBe(200);
    // A bare array of {studentPhone, courseTitle, status, ...} (enrollment.controller.ts:53-64).
    expect(Array.isArray(res.body)).toBe(true);

    const mine = res.body.filter(
      (e: { courseId?: string; courseTitle: string }) =>
        e.courseTitle.startsWith(COURSE_PREFIX),
    );
    expect(mine.length).toBeGreaterThanOrEqual(1);
    // Scoped to the teacher: nothing from any other owner's course may appear.
    for (const entry of res.body as Array<{ courseTitle: string }>) {
      expect(entry.courseTitle.startsWith(COURSE_PREFIX)).toBe(true);
    }
  });

  it('allows an ASSISTANT and resolves it through its parent teacher', async () => {
    const res = await call('get', '/api/teachers/enrollments', 'ASSISTANT');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('REPORTED FINDING: GET /api/lessons has no authentication gate', () => {
  // lesson.routes.ts:30-31 registers `router.get('/', getLessons)` and
  // `router.get('/public', getLessons)` with NO authMiddleware and NO
  // roleMiddleware, unlike every other route in that router. The payload is
  // metadata only (ids, titles, subject/grade, hasVideo booleans — no videoUrl,
  // pdfUrl, homeworkText or quiz content) and the query is constrained to
  // lessons of published courses by listLessons, and /public is an explicit
  // deliberate alias. So this is a duplicated public surface rather than a data
  // breach — but the codebase states elsewhere that the public catalogue is
  // GET /api/store/courses (course.routes.ts:60-62), so the ungated primary
  // path is inconsistent with that intent.
  //
  // This test pins CURRENT behaviour (anonymous 200) rather than endorsing it:
  // if someone adds a guard, this test fails and has to be updated deliberately.

  it('serves lesson metadata to an anonymous caller (200, not 401)', async () => {
    const res = await call('get', '/api/lessons', null);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('still withholds the actual media and homework fields', async () => {
    const res = await call('get', '/api/lessons', null);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/videoUrl|pdfUrl|homeworkText|questions/);
  });

  it('is the same handler behind the explicit /public alias', async () => {
    const [primary, alias] = await Promise.all([
      call('get', '/api/lessons', null),
      call('get', '/api/lessons/public', null),
    ]);
    expect(primary.status).toBe(200);
    expect(alias.status).toBe(200);
    expect(Array.isArray(alias.body)).toBe(true);
  });
});