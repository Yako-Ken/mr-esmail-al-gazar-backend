import request from 'supertest';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import app from '../app';

import prisma from '../config/prisma';

/**
 * Defect 3 — PII leaked into responses and logs beyond the caller's entitlement.
 *
 * `admin.controller.getStudentById` / `getTeacherById` handed the raw service
 * result straight to `res.json`. Those services do `prisma.user.findUnique`
 * with `include` and no `select`, so the response was the entire `User` row:
 * the bcrypt `password` hash, `deviceId`, `sessionVersion`, the unverified
 * `parentPhone` contact hint, and the payment identifiers `vodafoneCashNumber`
 * and `instapayHandle` — plus every linked guardian's phone number, nested in
 * `studentRelations`. `student.controller.getTeacherStudents` forwarded
 * `parentPhone` for every enrolled student, turning one roster call into a bulk
 * export of guardians' contact details.
 *
 * The entitlement line this file draws:
 *   - a student: their own data;
 *   - a linked parent: their own child's phone (must keep working);
 *   - a teacher: their own enrolled students' phone/email;
 *   - SUPER_ADMIN: the fields needed to moderate an account.
 * Nobody is entitled to a password hash, internal session/device state, or a
 * third party's contact details pulled in as a side effect of a profile view.
 *
 * Phone budget: this file owns 01000000930-01000000936.
 */

const PHONES = {
  SUPER_ADMIN: '01000000930',
  TEACHER_A: '01000000931',
  TEACHER_B: '01000000932',
  STUDENT_1: '01000000933',
  STUDENT_2: '01000000934',
  PARENT: '01000000935',
  STRANGER_PARENT: '01000000936',
} as const;

const PASSWORD = 'PiiScope@2026';
const COURSE_PREFIX = 'PiiScope-Course-';

// Sentinel values planted on the student row. Each is a distinct string that
// must never appear anywhere in a response body. The password hash is asserted
// by its bcrypt prefix, so the assertion does not depend on the hash itself.
const DEVICE_ID_SENTINEL = 'deviceid-sentinel-7f3a91';
const WALLET_PHONE_SENTINEL = '01999887766';
const INSTAPAY_SENTINEL = 'instapay-sentinel@wallet.test';
const PARENT_PHONE_HINT_SENTINEL = '01222334455';
const GUARDIAN_PHONE_SENTINEL = '01000000935';

const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const upsertUser = async (key: keyof typeof PHONES, role: string, extra: Record<string, unknown> = {}) => {
  const phone = PHONES[key];
  const row = await prisma.user.upsert({
    where: { phone },
    update: {
      role,
      status: 'approved',
      isApproved: true,
      isVerified: true,
      password: await bcrypt.hash(PASSWORD, 10),
      ...extra,
    },
    create: {
      name: `PiiScope ${key}`,
      phone,
      email: `pii-scope-${phone}@example.com`,
      password: await bcrypt.hash(PASSWORD, 10),
      role,
      status: 'approved',
      isApproved: true,
      isVerified: true,
      ...extra,
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
  const userIds = Object.values(ids).filter(Boolean);
  if (userIds.length > 0) {
    await prisma.studentParentRelation.deleteMany({ where: { studentId: { in: userIds } } });
    await prisma.studentParentRelation.deleteMany({ where: { parentId: { in: userIds } } });
  }
};

beforeAll(async () => {
  await cleanupFixtures();

  await upsertUser('SUPER_ADMIN', 'SUPER_ADMIN');
  await upsertUser('TEACHER_A', 'TEACHER');
  await upsertUser('TEACHER_B', 'TEACHER');
  await upsertUser('PARENT', 'PARENT');
  await upsertUser('STRANGER_PARENT', 'PARENT');
  // The student carries every sensitive scalar the User model holds, so a single
  // profile read would hand all of them over if the row is not projected.
  await upsertUser('STUDENT_1', 'STUDENT', {
    deviceId: DEVICE_ID_SENTINEL,
    vodafoneCashNumber: WALLET_PHONE_SENTINEL,
    instapayHandle: INSTAPAY_SENTINEL,
    parentPhone: PARENT_PHONE_HINT_SENTINEL,
  });
  await upsertUser('STUDENT_2', 'STUDENT');

  await prisma.studentParentRelation.upsert({
    where: {
      studentId_parentId: { studentId: ids.STUDENT_1, parentId: ids.PARENT },
    },
    create: { studentId: ids.STUDENT_1, parentId: ids.PARENT },
    update: {},
  });

  // TEACHER_A owns a course with STUDENT_1 enrolled; TEACHER_B owns one with
  // STUDENT_2. Neither roster may bleed into the other.
  const courseA = await prisma.course.create({
    data: {
      teacherId: ids.TEACHER_A,
      title: `${COURSE_PREFIX}a`,
      subject: `${COURSE_PREFIX}math`,
      grade: `${COURSE_PREFIX}grade-1`,
      price: 0,
      priceMinor: 0,
      isPublished: true,
    },
  });
  const courseB = await prisma.course.create({
    data: {
      teacherId: ids.TEACHER_B,
      title: `${COURSE_PREFIX}b`,
      subject: `${COURSE_PREFIX}math`,
      grade: `${COURSE_PREFIX}grade-1`,
      price: 0,
      priceMinor: 0,
      isPublished: true,
    },
  });

  for (const [studentId, courseId] of [
    [ids.STUDENT_1, courseA.id],
    [ids.STUDENT_2, courseB.id],
  ] as const) {
    await prisma.courseEnrollment.upsert({
      where: { studentId_courseId: { studentId, courseId } },
      create: { studentId, courseId, paymentMethod: 'CREDIT', status: 'APPROVED' },
      update: { status: 'APPROVED' },
    });
  }

  for (const key of Object.keys(PHONES) as (keyof typeof PHONES)[]) {
    const res = await request(app)
      .post('/api/auth/login')
      .set('X-Device-Name', 'pii-scope')
      .send({ identifier: PHONES[key], password: PASSWORD });
    expect(res.status).toBe(200);
    tokens[key] = res.body.token as string;
  }
});

afterAll(async () => {
  jest.restoreAllMocks();
  await cleanupFixtures();
  await prisma.$disconnect();
});

/**
 * Strings that must never appear in a response body or a log line.
 *
 * Deliberately excludes the student's own phone and email: a moderator is
 * entitled to those for account management, and the moderation contract test
 * below asserts they are still returned.
 */
const forbiddenValues = (): string[] => [
  DEVICE_ID_SENTINEL,
  WALLET_PHONE_SENTINEL,
  INSTAPAY_SENTINEL,
  PARENT_PHONE_HINT_SENTINEL,
  GUARDIAN_PHONE_SENTINEL,
];

describe('the admin student profile is a projection, not a database row', () => {
  it('never returns the password hash or the internal session/device state', async () => {
    // Guard the premise: the row really does hold all of this.
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: ids.STUDENT_1 } });
    expect(stored.password).toMatch(/^\$2[aby]\$/);
    expect(stored.deviceId).toBe(DEVICE_ID_SENTINEL);

    const res = await request(app)
      .get(`/api/admin/users/students/${ids.STUDENT_1}`)
      .set(bearer(tokens.SUPER_ADMIN));

    expect(res.status).toBe(200);
    const data = res.body.data;

    expect(data).not.toHaveProperty('password');
    expect(data).not.toHaveProperty('sessionVersion');
    expect(data).not.toHaveProperty('deviceId');
    expect(data).not.toHaveProperty('permissions');
    // A password hash reaching a client is the whole ballgame: assert on the
    // shape, not on the exact string.
    expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$/);
    for (const secret of forbiddenValues()) {
      expect(JSON.stringify(res.body)).not.toContain(secret);
    }
  });

  it('never returns the payment identifiers or the unverified parentPhone hint', async () => {
    const res = await request(app)
      .get(`/api/admin/users/students/${ids.STUDENT_1}`)
      .set(bearer(tokens.SUPER_ADMIN));

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).not.toHaveProperty('vodafoneCashNumber');
    expect(data).not.toHaveProperty('instapayHandle');
    expect(data).not.toHaveProperty('parentPhone');
    expect(JSON.stringify(res.body)).not.toContain(WALLET_PHONE_SENTINEL);
    expect(JSON.stringify(res.body)).not.toContain(INSTAPAY_SENTINEL);
    expect(JSON.stringify(res.body)).not.toContain(PARENT_PHONE_HINT_SENTINEL);
  });

  it('never returns a linked guardian\'s phone number', async () => {
    const res = await request(app)
      .get(`/api/admin/users/students/${ids.STUDENT_1}`)
      .set(bearer(tokens.SUPER_ADMIN));

    expect(res.status).toBe(200);
    // The guardian's phone is a third party's contact detail. Moderation only
    // needs to know *that* a guardian is linked and who they are.
    expect(JSON.stringify(res.body)).not.toContain(GUARDIAN_PHONE_SENTINEL);
    for (const relation of res.body.data.studentRelations as {
      parent?: { phone?: unknown };
    }[]) {
      expect(relation.parent).not.toHaveProperty('phone');
    }
  });

  it('never returns the password hash on the teacher profile either', async () => {
    const res = await request(app)
      .get(`/api/admin/users/teachers/${ids.TEACHER_A}`)
      .set(bearer(tokens.SUPER_ADMIN));

    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('password');
    expect(res.body.data).not.toHaveProperty('sessionVersion');
    expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$/);
  });

  it('still gives a moderator the fields account management actually needs', async () => {
    // The over-redaction guard. A projection that returns nothing is not a fix.
    const res = await request(app)
      .get(`/api/admin/users/students/${ids.STUDENT_1}`)
      .set(bearer(tokens.SUPER_ADMIN));

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.id).toBe(ids.STUDENT_1);
    expect(data.name).toBe('PiiScope STUDENT_1');
    expect(data.phone).toBe(PHONES.STUDENT_1);
    expect(data.email).toBe(`pii-scope-${PHONES.STUDENT_1}@example.com`);
    expect(data.role).toBe('STUDENT');
    expect(data.status).toBe('approved');
    expect(data.isApproved).toBe(true);
    expect(typeof data.createdAt).toBe('string');

    // Guardian linkage survives so the moderator can still tell a linked
    // account from an unlinked one.
    expect(data.studentRelations).toHaveLength(1);
    expect(data.studentRelations[0].parentId).toBe(ids.PARENT);
    expect(data.studentRelations[0].parent.name).toBe('PiiScope PARENT');

    // Enrollment context survives, owner-scoped to the courses this student is in.
    expect(data.courseEnrollments).toHaveLength(1);
    expect(data.courseEnrollments[0].course.title).toBe(`${COURSE_PREFIX}a`);
    expect(data.courseEnrollments[0].course.teacher.name).toBe('PiiScope TEACHER_A');
  });

  it('keeps the moderator gate: a teacher still cannot read an arbitrary student profile', async () => {
    const res = await request(app)
      .get(`/api/admin/users/students/${ids.STUDENT_1}`)
      .set(bearer(tokens.TEACHER_A));

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(PHONES.STUDENT_1);
  });
});

describe('the teacher roster exports the teacher\'s own students, not their guardians', () => {
  it('does not carry every enrolled student\'s guardian phone', async () => {
    const res = await request(app)
      .get('/api/teachers/students')
      .set(bearer(tokens.TEACHER_A));

    expect(res.status).toBe(200);
    const rows = res.body as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(ids.STUDENT_1);
    // One roster call must not become an export of guardians' contact details.
    expect(JSON.stringify(res.body)).not.toContain(GUARDIAN_PHONE_SENTINEL);
    expect(rows[0]).not.toHaveProperty('parentPhone');
  });

  it('still gives the teacher their own student\'s phone and email', async () => {
    const res = await request(app)
      .get('/api/teachers/students')
      .set(bearer(tokens.TEACHER_A));

    expect(res.status).toBe(200);
    const [row] = res.body as { id: string; phone: string; email: string }[];
    expect(row.id).toBe(ids.STUDENT_1);
    expect(row.phone).toBe(PHONES.STUDENT_1);
    expect(row.email).toBe(`pii-scope-${PHONES.STUDENT_1}@example.com`);
  });

  it('does not leak the other teacher\'s student', async () => {
    const res = await request(app)
      .get('/api/teachers/students')
      .set(bearer(tokens.TEACHER_B));

    expect(res.status).toBe(200);
    const rows = res.body as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual([ids.STUDENT_2]);
    expect(JSON.stringify(res.body)).not.toContain(PHONES.STUDENT_1);
  });
});

describe('a parent still sees their own linked child\'s phone', () => {
  it('returns the child phone to the linked parent', async () => {
    const res = await request(app)
      .get('/api/parents/my-children')
      .set(bearer(tokens.PARENT));

    expect(res.status).toBe(200);
    expect(res.body.children).toHaveLength(1);
    expect(res.body.children[0].id).toBe(ids.STUDENT_1);
    // This entitlement is correct and must survive any PII tightening: a parent
    // who has to phone the school about their child needs the number.
    expect(res.body.children[0].phone).toBe(PHONES.STUDENT_1);
  });

  it('gives an unlinked parent nothing at all', async () => {
    const res = await request(app)
      .get('/api/parents/my-children')
      .set(bearer(tokens.STRANGER_PARENT));

    expect(res.status).toBe(200);
    expect(res.body.children).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain(PHONES.STUDENT_1);
  });
});

describe('the PII-serving endpoints write no PII to the log', () => {
  it('keeps raw phone, email, name, wallet and hash out of every log line', async () => {
    const captured: string[] = [];
    const collect =
      (sink: 'log' | 'warn' | 'error') =>
      (...args: unknown[]) => {
        captured.push(
          args
            .map((a) => {
              if (typeof a === 'string') return a;
              try {
                return JSON.stringify(a);
              } catch {
                return String(a);
              }
            })
            .join(' '),
        );
        void sink;
      };
    jest.spyOn(console, 'log').mockImplementation(collect('log'));
    jest.spyOn(console, 'warn').mockImplementation(collect('warn'));
    jest.spyOn(console, 'error').mockImplementation(collect('error'));

    // Capture only the profile/roster reads, so a login trace from the auth
    // flow cannot be mistaken for a leak on these surfaces.
    await request(app)
      .get(`/api/admin/users/students/${ids.STUDENT_1}`)
      .set(bearer(tokens.SUPER_ADMIN));
    await request(app)
      .get(`/api/admin/users/teachers/${ids.TEACHER_A}`)
      .set(bearer(tokens.SUPER_ADMIN));
    await request(app).get('/api/teachers/students').set(bearer(tokens.TEACHER_A));
    await request(app).get('/api/parents/my-children').set(bearer(tokens.PARENT));

    jest.restoreAllMocks();

    const log = captured.join('\n');
    for (const forbidden of [
      PHONES.STUDENT_1,
      PHONES.PARENT,
      GUARDIAN_PHONE_SENTINEL,
      DEVICE_ID_SENTINEL,
      WALLET_PHONE_SENTINEL,
      INSTAPAY_SENTINEL,
      PARENT_PHONE_HINT_SENTINEL,
      'PiiScope STUDENT_1',
    ]) {
      expect(log).not.toContain(forbidden);
    }
    expect(log).not.toMatch(/\$2[aby]\$/);
  });
});