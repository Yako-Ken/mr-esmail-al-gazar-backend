import request from 'supertest';
import app from '../../../src/app';
import prisma from '../../../src/config/prisma';
import {
  authHeader,
  cleanE2EData,
  E2E_PASSWORD,
  ensureE2EUser,
  loginUser,
} from '../helpers/test-helper';

const PHONES = {
  gdprUser: '01000008861',
  teacher: '01000008862',
};

describe('Tier 4 Scenario 4: GDPR Data Privacy & Erasure Lifecycle', () => {
  let userId: string;
  let userToken: string;
  let courseId: string;

  beforeAll(async () => {
    await cleanE2EData(Object.values(PHONES));

    const teacher = await ensureE2EUser({
      phone: PHONES.teacher,
      role: 'TEACHER',
      name: 'GDPR Teacher',
    });

    const user = await ensureE2EUser({
      phone: PHONES.gdprUser,
      role: 'STUDENT',
      name: 'GDPR Student Subject',
      email: 'gdpr-subject@example.test',
    });
    userId = user.id;

    userToken = (await loginUser(PHONES.gdprUser)).token;

    // Create course and enrollment for user to have data
    const course = await prisma.course.create({
      data: {
        teacherId: teacher.id,
        title: 'GDPR Data Subject Course',
        isPublished: true,
      },
    });
    courseId = course.id;

    await prisma.courseEnrollment.create({
      data: {
        studentId: userId,
        courseId,
        paymentMethod: 'CASH',
        status: 'APPROVED',
      },
    });
  }, 60000);

  afterAll(async () => {
    await prisma.dataPrivacyRequest.deleteMany({ where: { userId } });
    await cleanE2EData(Object.values(PHONES), [courseId]);
    await prisma.$disconnect();
  });

  // =========================================================================
  // Scenario 4: GDPR Privacy Lifecycle
  // =========================================================================
  it('Step 1: User verifies identity with current password and requests full GDPR data export', async () => {
    const res = await request(app)
      .post('/api/auth/privacy/export')
      .set(authHeader(userToken))
      .send({ password: E2E_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('export');
    expect(res.body.export.profile.phone).toBe(PHONES.gdprUser);
    expect(res.body.export.profile.name).toBe('GDPR Student Subject');
  });

  it('Step 2: Verification of export payload redactions (zero password hashes, zero session secrets)', async () => {
    const res = await request(app)
      .post('/api/auth/privacy/export')
      .set(authHeader(userToken))
      .send({ password: E2E_PASSWORD });

    expect(res.status).toBe(200);
    const profile = res.body.export.profile;
    expect(profile.password).toBeUndefined();
    expect(profile.resetToken).toBeUndefined();
    expect(profile.salt).toBeUndefined();

    // Headers verification
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('Step 3: User requests account erasure; system schedules 7-day grace window', async () => {
    const res = await request(app)
      .post('/api/auth/privacy/deletion')
      .set(authHeader(userToken))
      .send({
        password: E2E_PASSWORD,
        reason: 'Exercise of GDPR Right to Erasure (Article 17).',
      });

    expect(res.status).toBe(202); // 202 Accepted
    expect(res.body.deletion).toHaveProperty('scheduledFor');

    // Verify scheduledFor in database
    const reqRecord = await prisma.dataPrivacyRequest.findFirst({
      where: { userId, type: 'DELETE' },
    });
    expect(reqRecord).toBeDefined();
    expect(reqRecord?.status).toBe('PENDING');
  });

  it('Step 4: Immediate revocation of all active sessions and invalidation of outstanding bearer tokens', async () => {
    // Active sessions revoked
    const activeSessions = await prisma.userSession.findMany({
      where: { userId, revokedAt: null },
    });
    expect(activeSessions.length).toBe(0);

    // Old token fails auth
    const meRes = await request(app)
      .get('/api/auth/me')
      .set(authHeader(userToken));

    expect(meRes.status).toBe(401);
  });

  it('Step 5: Cancellation within grace window restores account standing and stops scheduled erasure', async () => {
    // Re-login to get fresh token for cancellation
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ phone: PHONES.gdprUser, password: E2E_PASSWORD });

    expect(loginRes.status).toBe(200);
    const freshToken = loginRes.body.token;

    // Cancel deletion
    const cancelRes = await request(app)
      .post('/api/auth/privacy/deletion/cancel')
      .set(authHeader(freshToken))
      .send({ password: E2E_PASSWORD });

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.deletion.status).toBe('CANCELED');

    // Verify status is CANCELED
    const reqRecord = await prisma.dataPrivacyRequest.findFirst({
      where: { userId, type: 'DELETE' },
      orderBy: { requestedAt: 'desc' },
    });
    expect(reqRecord?.status).toBe('CANCELED');
  });
});
