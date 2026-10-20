import request from 'supertest';
import { prisma } from '../config/prisma';
import bcrypt from 'bcryptjs';
import app from '../app';
import { __resetRateLimitsForTests } from '../middlewares/rateLimit.middleware';

/**
 * Parent linking and scoping.
 *
 * A parent account is the one role that reads another person's academic record,
 * so the whole value of the feature rests on one property: a parent sees the
 * students they linked and nothing else. These tests pin that down from both
 * directions â€” a real link grants access, and every shape of unlinked, expired,
 * consumed or forged request does not.
 *
 * Phone range 01000000950-954 is reserved for this file. Suites share one
 * PostgreSQL and jest runs serially (maxWorkers: 1), but fixtures still have to
 * be disjoint or one suite's afterAll deletes another suite's users.
 */


const P = {
  student: '01000000950',
  student2: '01000000951',
  parent: '01000000952',
  parent2: '01000000953',
  outsider: '01000000954',
} as const;

type Key = keyof typeof P;

const PASSWORD = 'ParentScope@2026';
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

let ids: Record<Key, string> = {} as Record<Key, string>;
let tokens: Record<Key, string> = {} as Record<Key, string>;

const roleOf = (k: Key) =>
  k === 'parent' || k === 'parent2' ? 'PARENT' : 'STUDENT';

async function login(phone: string): Promise<string> {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ phone, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

beforeAll(async () => {
  const hash = await bcrypt.hash(PASSWORD, 10);
  for (const key of Object.keys(P) as Key[]) {
    const phone = P[key];
ids[key] = (
      await prisma.user.upsert({
        where: { phone },
        create: {
          phone,
          password: hash,
          role: roleOf(key),
          status: 'APPROVED',
          isApproved: true,
          name: key,
        },
        // Enforced, not just set on first create: a previous run that died
        // mid-suite left rows behind, and a fixture with the wrong role silently
        // inverts the authorization tests that depend on it.
        update: { role: roleOf(key), status: 'APPROVED', isApproved: true },
      })
    ).id;
  }
  for (const key of Object.keys(P) as Key[]) tokens[key] = await login(P[key]);
}, 60_000);

/** Clears relations so each test starts from an unlinked world. */
async function resetLinks() {
  __resetRateLimitsForTests();
  await prisma.studentParentRelation.deleteMany({
    where: { parentId: { in: [ids.parent, ids.parent2] } },
  });
  await prisma.parentLinkRequest.deleteMany({
    where: { studentId: { in: [ids.student, ids.student2] } },
  });
}

afterAll(async () => {
  await prisma.studentParentRelation.deleteMany({ where: { parentId: { in: [ids.parent, ids.parent2] } } });
  await prisma.parentLinkRequest.deleteMany({ where: { studentId: { in: [ids.student, ids.student2] } } });
  await prisma.user.deleteMany({ where: { phone: { in: Object.values(P) } } });
  await prisma.$disconnect();
}, 60_000);

const genCode = (key: Key = 'student') =>
  request(app).post('/api/parents/link-code').set(bearer(tokens[key]));

const link = (parentKey: Key, studentPhone: string, code: string) =>
  request(app)
    .post('/api/parents/link-child')
    .set(bearer(tokens[parentKey]))
    .send({ studentPhone, code });

describe('a parent link is granted once, from the student side', () => {
  beforeEach(resetLinks);

  it('lets a student issue a code and a parent redeem it', async () => {
    const codeRes = await genCode();
    expect(codeRes.status).toBe(201);
    expect(typeof codeRes.body.code).toBe('string');
    expect(codeRes.body.studentPhone).toBe(P.student);

    const linkRes = await link('parent', P.student, codeRes.body.code);
    expect(linkRes.status).toBe(200);
    expect(linkRes.body.linked).toBe(true);

    const relation = await prisma.studentParentRelation.findFirst({
      where: { parentId: ids.parent, studentId: ids.student },
    });
    expect(relation).toBeTruthy();
  });

  it('makes the linked child appear in my-children', async () => {
    const code = (await genCode()).body.code;
    await link('parent', P.student, code);

    const res = await request(app)
      .get('/api/parents/my-children')
      .set(bearer(tokens.parent));
    expect(res.status).toBe(200);
    expect(res.body.children.map((c: { id: string }) => c.id)).toContain(ids.student);
  });

  it('burns the code so it cannot be redeemed twice', async () => {
    const code = (await genCode()).body.code;
    expect((await link('parent', P.student, code)).status).toBe(200);

    const second = await link('parent2', P.student, code);
    expect(second.status).toBe(400);

    // And the second parent must not have gained access.
    const children = await request(app)
      .get('/api/parents/my-children')
      .set(bearer(tokens.parent2));
    expect(children.body.children).toHaveLength(0);
  });

  it('replaces an unused code when a second one is issued', async () => {
    const first = (await genCode()).body.code;
    const second = (await genCode()).body.code;

    expect((await link('parent', P.student, first)).status).toBe(400);
    expect((await link('parent', P.student, second)).status).toBe(200);
  });

  it('rejects an expired code', async () => {
    const codeRes = await genCode();
    const code = codeRes.body.code;

    await prisma.parentLinkRequest.updateMany({
      where: { studentId: ids.student, status: 'PENDING' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await link('parent', P.student, code);
    expect(res.status).toBe(400);
  });

it('counts a wrong code against the attempt budget', async () => {
    // Reset immediately before, so the shared per-IP budget cannot make this
    // assert something the limiter decided rather than the handler.
    __resetRateLimitsForTests();
    await genCode();

    const before = await prisma.parentLinkRequest.findFirst({
      where: { studentId: ids.student },
      orderBy: { createdAt: 'desc' },
      select: { attempts: true },
    });

    const bad = await link('parent', P.student, 'ZZZZ2345');
    expect([400, 429]).toContain(bad.status);

    const after = await prisma.parentLinkRequest.findFirst({
      where: { studentId: ids.student },
      orderBy: { createdAt: 'desc' },
      select: { attempts: true },
    });

    // The counter must have moved, or the budget is decorative.
    expect(after!.attempts).toBeGreaterThan(before!.attempts);
  });

  it('stops answering once the attempt budget is spent', async () => {
    await genCode();

    // Drive the counter to the cap directly rather than spending five requests
    // against a per-IP limiter that other tests also share. The property under
    // test is the refusal, not the arithmetic that reaches the cap.
    await prisma.parentLinkRequest.updateMany({
      where: { studentId: ids.student, status: 'PENDING' },
      data: { attempts: 5 },
    });

    const res = await link('parent', P.student, 'ZZZZ2345');
    expect(res.status).toBe(400);

    // And no link may exist as a result.
    const relation = await prisma.studentParentRelation.findFirst({
      where: { parentId: ids.parent, studentId: ids.student },
    });
    expect(relation).toBeNull();
  });

  it('refuses a locked request even with the genuine code', async () => {
    const code = (await genCode()).body.code;
    await prisma.parentLinkRequest.updateMany({
      where: { studentId: ids.student, status: 'PENDING' },
      data: { attempts: 5 },
    });

    const res = await link('parent', P.student, code);
    expect([400, 429]).toContain(res.status);

    const relation = await prisma.studentParentRelation.findFirst({
      where: { parentId: ids.parent, studentId: ids.student },
    });
    expect(relation).toBeNull();
  });
});

describe('a parent sees only the students they linked', () => {
  beforeEach(async () => {
    await resetLinks();
    const code = (await genCode()).body.code;
    await link('parent', P.student, code);
  });

  it('allows child stats for a linked child', async () => {
    const res = await request(app)
      .get(`/api/parents/child/${ids.student}/stats`)
      .set(bearer(tokens.parent));
    expect(res.status).toBe(200);
    expect(res.status).toBe(200);
    // getChildStats returns aggregates, not the child object — the caller already
    // knows which child they asked for, so echoing it back would be noise.
    expect(typeof res.body.attendanceRate).toBe('number');
    expect(res.body).toHaveProperty('physicalAttendanceCount');
    expect(res.body).not.toHaveProperty('student');
  });

  it('refuses stats for a child this parent never linked', async () => {
    const res = await request(app)
      .get(`/api/parents/child/${ids.student2}/stats`)
      .set(bearer(tokens.parent));
    expect(res.status).toBe(403);
  });

  it('refuses stats for an unrelated student entirely', async () => {
    const res = await request(app)
      .get(`/api/parents/child/${ids.outsider}/stats`)
      .set(bearer(tokens.parent));
    expect(res.status).toBe(403);
  });

  it('does not leak one parent\'s child to another parent', async () => {
    const res = await request(app)
      .get(`/api/parents/child/${ids.student}/stats`)
      .set(bearer(tokens.parent2));
    expect(res.status).toBe(403);

    const children = await request(app)
      .get('/api/parents/my-children')
      .set(bearer(tokens.parent2));
    expect(children.body.children).toHaveLength(0);
  });

  it('removes access when the link is deleted', async () => {
    const del = await request(app)
      .delete(`/api/parents/child/${ids.student}/link`)
      .set(bearer(tokens.parent));
    // 204 is the contract: the link is gone and there is nothing to return.
    expect(del.status).toBe(204);

    const res = await request(app)
      .get(`/api/parents/child/${ids.student}/stats`)
      .set(bearer(tokens.parent));
    expect(res.status).toBe(403);
  });

  it('refuses to unlink a child this parent does not own', async () => {
    const res = await request(app)
      .delete(`/api/parents/child/${ids.student2}/link`)
      .set(bearer(tokens.parent2));
    // 404 rather than 403: the link this parent is asking about does not exist,
    // and confirming that a foreign link *could* exist would itself leak.
    expect(res.status).toBe(404);

    // The real link must survive the attempt.
    const still = await prisma.studentParentRelation.findFirst({
      where: { parentId: ids.parent, studentId: ids.student },
    });
    expect(still).toBeTruthy();
  });
});

describe('the parent surface is closed to students', () => {
it('refuses a parent issuing a link code', async () => {
    // The design is that the STUDENT issues the code and hands it to the parent,
    // so a student succeeding here is correct behaviour, not a hole. It is the
    // parent that must not be able to issue one.
    const res = await genCode('parent');
    expect(res.status).toBe(403);
  });

  it('refuses a student redeeming a code', async () => {
    // Redeeming is the parent's side of the handshake. A student calling it must
    // be refused before any code is looked at.
    const res = await link('student', P.student, 'ZZZZ2345');
    expect(res.status).toBe(403);
  });

  it('refuses a student reading my-children or child stats', async () => {
    const children = await request(app)
      .get('/api/parents/my-children')
      .set(bearer(tokens.student));
    expect(children.status).toBe(403);

    const stats = await request(app)
      .get(`/api/parents/child/${ids.student}/stats`)
      .set(bearer(tokens.student));
    expect(stats.status).toBe(403);
  });

  it('refuses an anonymous caller', async () => {
    for (const [method, path] of [
      ['get', '/api/parents/my-children'],
      ['get', `/api/parents/child/${ids.student}/stats`],
      ['post', '/api/parents/link-code'],
      ['post', '/api/parents/link-child'],
    ] as const) {
      const res = await request(app)[method](path).send({});
      expect(res.status).toBe(401);
    }
  });
});