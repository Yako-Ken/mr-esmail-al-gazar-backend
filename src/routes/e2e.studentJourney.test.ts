import request from 'supertest';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import app from '../app';

/**
 * End-to-end student journey: register -> login -> buy -> open -> submit.
 *
 * Every step asserts persisted state, not just a status code, because the whole
 * point of this journey is the seam between "the API said yes" and "the database
 * actually agrees".
 *
 * The central question the journey answers: what exactly grants a student access
 * to a paid lesson? The answer is read from lesson.service.ts:getLessonById, which
 * is the single canonical gate reused by GET /api/lessons/:id,
 * GET /api/lessons/:id/playback, POST /api/lessons/:id/homework,
 * POST /api/trackings/homework/submit and GET /api/trackings/:lessonId.
 *
 * Verified reading of that function (src/services/lesson.service.ts:482-487):
 *
 *     const enrollment = await prisma.courseEnrollment.findUnique({
 *       where: { studentId_courseId: { studentId: authUser.id, courseId: lesson.courseId } },
 *     });
 *     if (!enrollment || enrollment.status !== 'APPROVED') {
 *       throw new ForbiddenError('You do not have access to this lesson');
 *     }
 *
 * Only a CourseEnrollment with status APPROVED is consulted. Neither a PAID
 * PaymentOrder nor a CourseEntitlement is read here, even though the webhook
 * writes both (payment.controller.ts:259-278). This suite pins that reality in
 * both directions: money alone and entitlement alone are both insufficient, and
 * the approved enrollment is what actually flips the gate.
 *
 * Step 9 departs from the happy path: recording homework is broken in this
 * checkout because the generated Prisma client predates the HomeworkStatus enum.
 * See the long comment on that describe block for the root cause, the blast
 * radius and the reason the generated client cannot simply be refreshed.
 */

import prisma from '../config/prisma';

const PASSWORD = 'Journey@2026';
const LESSON_VIDEO_URL = 'https://example.test/journey-video.mp4';

// Reserved phone block for this file only. `User.phone` is unique across the
// whole suite and every suite shares one database, so these must never collide
// with another suite's fixtures.
const TEACHER_PHONE = '01000000911';
const STUDENT_PHONE = '01000000912';
const OUTSIDER_PHONE = '01000000913';
const MY_PHONES = [TEACHER_PHONE, STUDENT_PHONE, OUTSIDER_PHONE];

const COURSE_PREFIX = 'E2EJourney-PaidCourse-';
const LESSON_TITLE = 'E2EJourney Paid Lesson';
const HW_ANSWER = 'إجابتي على الواجب — solved in the journey test.';

let courseId: string;
let lessonId: string;
let studentId: string;
let outsiderId: string;
let teacherToken: string;
let studentToken: string;
let outsiderToken: string;
let paymentOrderId: string;

/**
 * Remove only rows this file created, in foreign-key order. Nothing is ever
 * deleted with an unfiltered deleteMany, so another suite's fixtures survive.
 *
 * PaymentOrder and CourseEntitlement hold a bare courseId string with no
 * relation to Course, so deleting the course does NOT cascade to them — they are
 * removed explicitly.
 */
const cleanupJourney = async (): Promise<void> => {
  const courses = await prisma.course.findMany({
    where: { title: { startsWith: COURSE_PREFIX } },
    select: { id: true },
  });
  const courseIds = courses.map((c) => c.id);

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

  // Safe to delete the users now: the enrollments that referenced them are gone,
  // and User.phone is what this suite keys on.
  await prisma.user.deleteMany({ where: { phone: { in: MY_PHONES } } });
};

const login = async (phone: string, device: string): Promise<string> => {
  const res = await request(app)
    .post('/api/auth/login')
    .set('X-Device-Name', device)
    .send({ identifier: phone, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.token as string;
};

beforeAll(async () => {
  await cleanupJourney();

  // The teacher is provisioned by an admin in production, never self-registered.
  await prisma.user.create({
    data: {
      name: 'Journey Teacher',
      phone: TEACHER_PHONE,
      email: `journey-teacher-${TEACHER_PHONE}@example.com`,
      password: await bcrypt.hash(PASSWORD, 10),
      role: 'TEACHER',
      status: 'approved',
      isApproved: true,
      isVerified: true,
    },
  });
  teacherToken = await login(TEACHER_PHONE, 'e2e-journey-teacher');
});

afterAll(async () => {
  await cleanupJourney();
  await prisma.$disconnect();
});

describe('step 1 — a student self-registers', () => {
  it('is accepted, and the STUDENT row is really in the database', async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Journey Student',
      phone: STUDENT_PHONE,
      email: `journey-student-${STUDENT_PHONE}@example.com`,
      password: PASSWORD,
      role: 'STUDENT',
    });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('STUDENT');
    // Never echo the token value back into the report/log.
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(0);

    const stored = await prisma.user.findUnique({ where: { phone: STUDENT_PHONE } });
    expect(stored).not.toBeNull();
    expect(stored!.role).toBe('STUDENT');
    expect(stored!.status).toBe('approved');
    expect(stored!.isApproved).toBe(true);
    // The password column must hold a hash, never the plaintext.
    expect(stored!.password).not.toBe(PASSWORD);
    studentId = stored!.id;
  });

  it('refuses to self-register a privileged role', async () => {
    // registerSchema restricts role to STUDENT|PARENT, and the controller
    // re-checks it (auth.controller.ts:109) as defence in depth.
    const res = await request(app).post('/api/auth/register').send({
      name: 'Journey Escalation',
      phone: '01000000914',
      email: 'journey-escalation@example.com',
      password: PASSWORD,
      role: 'SUPER_ADMIN',
    });

    expect(res.status).toBe(400);
    expect(await prisma.user.count({ where: { phone: '01000000914' } })).toBe(0);
  });
});

describe('step 2 — the student logs in and receives a working token', () => {
  it('returns a token that resolves back to the database row', async () => {
    studentToken = await login(STUDENT_PHONE, 'e2e-journey-student');
    expect(typeof studentToken).toBe('string');
    expect(studentToken.split('.')).toHaveLength(3);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${studentToken}`);

    expect(me.status).toBe(200);
    expect(me.body.user?.id ?? me.body.id).toBe(studentId);
    expect(me.body.user?.phone ?? me.body.phone).toBe(STUDENT_PHONE);
  });

  it('rejects the wrong password and does not mint a token', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('X-Device-Name', 'e2e-journey-student')
      .send({ identifier: STUDENT_PHONE, password: 'not-the-password' });

    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
  });

  it('creates an unrelated second student who is never enrolled anywhere', async () => {
    // Step 10 needs a bystander with a valid session but no relationship to the
    // course, to prove the gate is per-student rather than "logged in".
    const created = await request(app).post('/api/auth/register').send({
      name: 'Journey Outsider',
      phone: OUTSIDER_PHONE,
      email: `journey-outsider-${OUTSIDER_PHONE}@example.com`,
      password: PASSWORD,
      role: 'STUDENT',
    });
    expect(created.status).toBe(201);

    outsiderId = created.body.user.id as string;
    outsiderToken = await login(OUTSIDER_PHONE, 'e2e-journey-outsider');
    expect(
      await prisma.courseEnrollment.count({ where: { studentId: outsiderId } }),
    ).toBe(0);
  });
});

describe('step 3 — the teacher publishes a PAID course with a lesson', () => {
  it('creates the course as unpublished and priced above zero', async () => {
    const res = await request(app)
      .post('/api/courses')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({
        title: `${COURSE_PREFIX}${Date.now()}`,
        description: 'A paid course used by the end-to-end journey suite.',
        subject: 'Physics',
        grade: 'grade-2',
        price: '249.00',
      });

    expect(res.status).toBe(201);
    expect(res.body.course.priceMinor).toBe(24900);
    expect(res.body.course.isPublished).toBe(false);
    courseId = res.body.course.id as string;

    const stored = await prisma.course.findUnique({ where: { id: courseId } });
    expect(stored?.priceMinor).toBe(24900);
    expect(stored?.isPublished).toBe(false);
  });

  it('adds a lesson carrying homework, so step 9 has something to submit', async () => {
    const res = await request(app)
      .post('/api/lessons')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({
        title: LESSON_TITLE,
        courseId,
        videoUrl: LESSON_VIDEO_URL,
        homeworkText: 'Complete questions 1 to 5 and show your working.',
      });

    // createLesson answers 200 with { success, data }, not 201 with { lesson }.
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    lessonId = res.body.data.id as string;
    expect(lessonId).toEqual(expect.any(String));

    const stored = await prisma.lesson.findUnique({ where: { id: lessonId } });
    expect(stored?.courseId).toBe(courseId);
    expect(stored?.videoUrl).toBe(LESSON_VIDEO_URL);
    expect(stored?.homeworkText).toBeTruthy();
  });

  it('publishes the course, which is what makes the lesson reachable at all', async () => {
    // Publishing requires at least one lesson first (course.service.ts:115-118).
    const res = await request(app)
      .put(`/api/courses/${courseId}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ isPublished: 'true' });

    expect(res.status).toBe(200);
    expect(res.body.course.isPublished).toBe(true);

    const stored = await prisma.course.findUnique({ where: { id: courseId } });
    expect(stored?.isPublished).toBe(true);
    expect(stored?.publishedAt).not.toBeNull();
  });

  it('refuses to publish an empty course, so "published" really means reachable', async () => {
    const draft = await request(app)
      .post('/api/courses')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ title: `${COURSE_PREFIX}empty-${Date.now()}`, price: '10.00' });

    const draftId = draft.body.course.id as string;
    const res = await request(app)
      .put(`/api/courses/${draftId}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ isPublished: 'true' });

    expect(res.status).toBe(400);

    // Removed immediately rather than left for afterAll: a second course row
    // existing for the rest of the suite widens the window in which another
    // suite's non-transactional count/groupBy pair can disagree about it.
    await prisma.course.delete({ where: { id: draftId } });
  });
});

describe('steps 4-8 — what actually grants access to the paid lesson', () => {
  const openLesson = () =>
    request(app)
      .get(`/api/lessons/${lessonId}`)
      .set('Authorization', `Bearer ${studentToken}`);

  it('step 4: a student with no enrollment is denied', async () => {
    const res = await openLesson();

    expect(res.status).toBe(403);
    // And nothing about the lesson leaks in the denial.
    expect(JSON.stringify(res.body)).not.toContain(LESSON_TITLE);
    expect(await prisma.courseEnrollment.count({ where: { studentId: studentId } })).toBe(0);
  });

  it('step 5: a settled PAID PaymentOrder alone still grants nothing', async () => {
    const order = await prisma.paymentOrder.create({
      data: {
        studentId,
        courseId,
        amountMinor: 24900,
        currency: 'EGP',
        provider: 'PAYMOB_WEB',
        status: 'PAID',
        paidAt: new Date(),
        idempotencyKey: `e2e-journey-${Date.now()}`,
      },
      select: { id: true, status: true },
    });
    paymentOrderId = order.id;

    const stored = await prisma.paymentOrder.findUnique({ where: { id: paymentOrderId } });
    expect(stored?.status).toBe('PAID');
    expect(stored?.paidAt).not.toBeNull();
  });

  it('step 6: the student is STILL denied — a PAID order is not an entitlement', async () => {
    // The gap this documents: money in the ledger is not access. The canonical
    // gate reads CourseEnrollment only, so an order marked PAID without the
    // enrollment the webhook would have written leaves the student locked out.
    const res = await openLesson();

    expect(res.status).toBe(403);

    // Prove the denial is caused by the missing enrollment and not by some
    // unrelated rejection: the order is genuinely settled and no enrollment or
    // entitlement row exists.
    expect(
      (await prisma.paymentOrder.findUnique({ where: { id: paymentOrderId } }))?.status,
    ).toBe('PAID');
    expect(
      await prisma.courseEnrollment.count({ where: { studentId, courseId } }),
    ).toBe(0);
    expect(
      await prisma.courseEntitlement.count({ where: { studentId, courseId } }),
    ).toBe(0);
  });

  it('step 7: a CourseEntitlement alone is ALSO not enough — it is never read', async () => {
    // This contradicts a natural reading of the data model, so it is asserted
    // explicitly: getLessonById does not query CourseEntitlement at all.
    await prisma.courseEntitlement.create({
      data: {
        studentId,
        courseId,
        sourceOrderId: paymentOrderId,
        status: 'ACTIVE',
      },
    });

    const entitlement = await prisma.courseEntitlement.findFirst({
      where: { studentId, courseId },
    });
    expect(entitlement?.status).toBe('ACTIVE');

    // Ownership is recorded in the database and access is still refused.
    const res = await openLesson();
    expect(res.status).toBe(403);
    expect(
      await prisma.courseEnrollment.count({ where: { studentId, courseId } }),
    ).toBe(0);
  });

  it('step 8: the APPROVED CourseEnrollment is what flips the gate open', async () => {
    // This mirrors exactly what the verified webhook writes in one transaction:
    // PaymentOrder -> PAID, CourseEntitlement -> ACTIVE, and
    // CourseEnrollment -> APPROVED (payment.controller.ts:250-278). Access
    // depends on the third write, not the first two.
    await prisma.courseEnrollment.create({
      data: {
        studentId,
        courseId,
        status: 'APPROVED',
        paymentMethod: 'PAYMOB',
      },
    });

    const stored = await prisma.courseEnrollment.findFirst({
      where: { studentId, courseId },
    });
    expect(stored?.status).toBe('APPROVED');

    const res = await openLesson();
    expect(res.status).toBe(200);
    // GET /api/lessons/:id answers a FLAT lesson object, not { lesson: {...} }.
    expect(res.body.id).toBe(lessonId);
    expect(res.body.courseId).toBe(courseId);
    expect(res.body.title).toBe(LESSON_TITLE);
    expect(res.body.hwStatus).toBe('NOT_SUBMITTED');
  });

  it('a PENDING enrollment is treated exactly like no enrollment', async () => {
    // Guards the other half of the `status !== 'APPROVED'` condition, so a
    // future refactor cannot weaken it to "an enrollment exists".
    await prisma.courseEnrollment.update({
      where: { studentId_courseId: { studentId, courseId } },
      data: { status: 'PENDING' },
    });

    const res = await openLesson();
    expect(res.status).toBe(403);

    await prisma.courseEnrollment.update({
      where: { studentId_courseId: { studentId, courseId } },
      data: { status: 'APPROVED' },
    });
    expect((await openLesson()).status).toBe(200);
  });
});

describe('step 9 — homework submission on the unlocked lesson', () => {
  // ── Authorization layer of homework submission ────────────────────────────
  // These run BEFORE any write is attempted, so they are unaffected by the
  // serialization defect pinned further down and genuinely verify that the
  // submit route re-uses the canonical lesson gate.

  it('rejects an empty answer before touching the database', async () => {
    const res = await request(app)
      .post(`/api/lessons/${lessonId}/homework`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ answer: '   ' });

    expect(res.status).toBe(400);
    expect(await prisma.tracking.count({ where: { studentId, lessonId } })).toBe(0);
  });

  it('rejects the unrelated student with 403 and writes no tracking row', async () => {
    const res = await request(app)
      .post(`/api/lessons/${lessonId}/homework`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ answer: 'outsider homework attempt' });

    expect(res.status).toBe(403);
    expect(await prisma.tracking.count({ where: { studentId: outsiderId } })).toBe(0);
  });

  // ── DEFECT PIN: recording homework is broken in this checkout ──────────────
  //
  // Tracked through every route that persists homework:
  //   POST /api/lessons/:id/homework        -> 500 to the caller
  //   POST /api/trackings/homework/submit   -> same failure (writes 'PENDING')
  //
  // Root cause is a MISMATCH between prisma/schema.prisma and the generated
  // client in node_modules. schema.prisma:17-23 declares
  //     enum HomeworkStatus { NOT_SUBMITTED SUBMITTED UNDER_REVIEW NEEDS_REVISION GRADED }
  // and schema.prisma:218 types Tracking.hwStatus as that enum, but the
  // generated Prisma client still describes hwStatus as a plain `String` — it
  // predates the HomeworkStatus enum (see the untracked migration
  // prisma/migrations/20261005000000_homework_lifecycle/). test/globalSetup.ts
  // pushes the schema with `--skip-generate`, so the mismatch survives into
  // every test run. The DATABASE column is the real enum (db push builds it from
  // schema.prisma), so the query engine rejects what the client sends:
  //     PrismaClientKnownRequestError P2032 — Error converting field "hwStatus"
  //     of expected non-nullable type "String", found incompatible value
  //     "SUBMITTED"   (raised via src/services/lesson.service.ts:77)
  //
  // Two distinct consequences, both pinned below:
  //   1. The write is NOT atomic. The caller gets a 500, yet the Tracking row IS
  //      inserted with hwStatus = 'SUBMITTED'. A partially-applied write reported
  //      as a failure is worse than a clean rejection.
  //   2. Once any Tracking row exists, reads break too. Deserialising hwStatus
  //      raises the same P2032, so GET /api/lessons/:id starts returning 500 for
  //      that student — the lesson page a student already paid for becomes
  //      permanently unreachable after a single submission.
  //
  // These tests pin CURRENT behaviour rather than endorsing it. Running
  // `npx prisma generate` fixes the runtime and makes them fail — which is the
  // point: it tells whoever regenerates the client that homework submission was
  // dead and now needs a real assertion.
  //
  // CAVEAT for whoever fixes it: regenerating the client alone turns `hwStatus`
  // into the `HomeworkStatus` enum and exposes a pre-existing type error in
  // src/services/student.service.ts:568 and :575 (it writes a `string` validated
  // against ['APPROVED','REJECTED'], neither of which is a valid HomeworkStatus
  // value). That breaks compilation of every suite, so the client cannot be
  // regenerated in isolation.

  // The Prisma client is now generated against the HomeworkStatus enum and
  // student.service validates the status against that vocabulary, so the write
  // and the read-back both succeed. These two cases previously pinned a defect
  // (a 500 with a non-atomic write, then a permanently broken lesson page); they
  // now pin the fixed contract so it cannot regress.

  it('accepts the submission and persists it as SUBMITTED', async () => {
    expect(await prisma.tracking.count({ where: { studentId, lessonId } })).toBe(0);

    const res = await request(app)
      .post(`/api/lessons/${lessonId}/homework`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ answer: HW_ANSWER });

    expect(res.status).toBe(201);
    // This endpoint answers `{ success, tracking }`; the legacy
    // /api/tracking/submit-homework route answers `{ message, status, fileUrl }`.
    // Assert the shape this route actually returns.
    expect(res.body.success).toBe(true);
    expect(res.body.tracking.hwStatus).toBe('SUBMITTED');

    // Read back through Prisma — this deserialisation used to throw P2032.
    const row = await prisma.tracking.findUnique({
      where: { studentId_lessonId: { studentId, lessonId } },
    });
    expect(row?.hwStatus).toBe('SUBMITTED');
    expect(row?.hwSubmittedAt).not.toBeNull();

    // The raw column really is the Postgres enum, not a loose string.
    const raw = await prisma.$queryRaw<Array<{ data_type: string; udt: string }>>`
      SELECT data_type, udt_name AS udt
      FROM information_schema.columns
      WHERE table_name = 'Tracking' AND column_name = 'hwStatus'
    `;
    expect(raw[0]?.data_type).toBe('USER-DEFINED');
    expect(raw[0]?.udt).toBe('HomeworkStatus');
  });

  it('serves the lesson normally afterwards and still blocks an unrelated student', async () => {
    const raw = await prisma.$queryRaw<Array<{ hwStatus: string }>>`
      SELECT "hwStatus"::text AS "hwStatus"
      FROM "Tracking"
      WHERE "studentId" = ${studentId} AND "lessonId" = ${lessonId}
    `;
    expect(raw[0].hwStatus).toBe('SUBMITTED');

    const row = await prisma.tracking.findUnique({
      where: { studentId_lessonId: { studentId, lessonId } },
    });
    expect(row?.hwStatus).toBe('SUBMITTED');

    const res = await request(app)
      .get(`/api/lessons/${lessonId}`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(200);

    const outsider = await request(app)
      .get(`/api/lessons/${lessonId}`)
      .set('Authorization', `Bearer ${outsiderToken}`);
    expect(outsider.status).toBe(403);
  });

  it('the DB column really is an enum, so this is a client/schema mismatch', async () => {
    // Read the live column type from information_schema. If this ever reports
    // `character varying`, the schema and database have diverged in the other
    // direction and the diagnosis above needs revisiting.
    const rows = await prisma.$queryRaw<Array<{ data_type: string; udt_name: string }>>`
      SELECT data_type, udt_name
      FROM information_schema.columns
      WHERE table_name = 'Tracking' AND column_name = 'hwStatus'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('USER-DEFINED');
    expect(rows[0].udt_name).toBe('HomeworkStatus');
  });
});

describe('step 10 — an unrelated student is still locked out of the same lesson', () => {
  it('cannot open the lesson even though the course is published and paid-for', async () => {
    const res = await request(app)
      .get(`/api/lessons/${lessonId}`)
      .set('Authorization', `Bearer ${outsiderToken}`);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(LESSON_TITLE);
  });

  it('cannot submit homework to a lesson they cannot open', async () => {
    // Same assertion as in step 9, kept here so the isolation claim is stated
    // once per concern: step 9 proves the authz layer, step 10 states the
    // per-student isolation guarantee.
    const res = await request(app)
      .post(`/api/lessons/${lessonId}/homework`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ answer: 'outsider homework attempt' });

    expect(res.status).toBe(403);
    expect(await prisma.tracking.count({ where: { studentId: outsiderId } })).toBe(0);
  });

  it('cannot reach the lesson through the tracking alias either', async () => {
    // GET /api/trackings/:lessonId calls the same canonical gate, so the lockout
    // cannot be side-stepped by using the other router that exposes lessons.
    const res = await request(app)
      .get(`/api/trackings/${lessonId}`)
      .set('Authorization', `Bearer ${outsiderToken}`);

    expect(res.status).toBe(403);
  });

  it('a PAID order belonging to the enrolled student does not leak to the outsider', async () => {
    // Ties the isolation back to the ledger: the payment is real and settled, and
    // it still confers nothing on anyone else.
    const order = await prisma.paymentOrder.findUnique({ where: { id: paymentOrderId } });
    expect(order?.studentId).toBe(studentId);
    expect(order?.status).toBe('PAID');

    expect(
      await prisma.courseEnrollment.count({ where: { studentId: outsiderId } }),
    ).toBe(0);
    expect(
      await prisma.courseEntitlement.count({ where: { studentId: outsiderId } }),
    ).toBe(0);
  });
});