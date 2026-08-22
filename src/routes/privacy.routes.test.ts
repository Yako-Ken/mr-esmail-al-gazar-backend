import request from 'supertest';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import app from '../app';
import {
  cancelAccountDeletion,
  executeDueAccountDeletions,
} from '../services/privacy.service';

const prisma = new PrismaClient();
const phone = '01080808080';
const password = 'Privacy@2026';
let testUserId: string;

const login = async () => {
  const response = await request(app)
    .post('/api/auth/login')
    .set('X-Device-Name', 'Privacy test device')
    .send({ identifier: phone, password });
  expect(response.status).toBe(200);
  return response.body.token as string;
};

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('account data export and deletion requests', () => {
  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { phone } });
    const user = await prisma.user.create({
      data: {
        name: 'Privacy Test',
        phone,
        email: 'privacy-test@example.com',
        password: await bcrypt.hash(password, 12),
        role: 'STUDENT',
        status: 'approved',
        isApproved: true,
      },
    });
    testUserId = user.id;
  });

  afterAll(async () => {
    await prisma.paymentOrder.deleteMany({ where: { studentId: testUserId } });
    await prisma.user.deleteMany({ where: { id: testUserId } });
    await prisma.$disconnect();
  });

  it('requires reauthentication and exports only the authenticated account data', async () => {
    const token = await login();
    const rejected = await request(app)
      .post('/api/auth/privacy/export')
      .set(bearer(token))
      .send({ password: 'WrongPassword' });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('INVALID_REAUTH');

    const response = await request(app)
      .post('/api/auth/privacy/export')
      .set(bearer(token))
      .send({ password });
    expect(response.status).toBe(200);
    expect(response.body.request.status).toBe('GENERATED');
    expect(response.body.export.profile).toMatchObject({ phone, name: 'Privacy Test' });
    expect(response.body.export.learning.enrollments).toEqual([]);

    const serialized = JSON.stringify(response.body);
    const storedUser = await prisma.user.findUnique({ where: { phone } });
    expect(storedUser).not.toBeNull();
    expect(serialized).not.toContain(storedUser!.password);
    expect(serialized).not.toContain('checkoutUrl');
    expect(serialized).not.toContain('bunnyVideoId');
    expect(serialized).not.toContain('userAgent');

    const status = await request(app)
      .get('/api/auth/privacy/requests')
      .set(bearer(token));
    expect(status.status).toBe(200);
    expect(status.body.latestExport.status).toBe('GENERATED');
    expect(status.body.deletion).toBeNull();
  });

  it('schedules one deletion request, revokes sessions, and supports verified cancellation', async () => {
    const token = await login();
    const response = await request(app)
      .post('/api/auth/privacy/deletion')
      .set(bearer(token))
      .send({ password, reason: 'No longer needed' });
    expect(response.status).toBe(202);
    expect(response.body.deletion.status).toBe('PENDING');
    expect(new Date(response.body.deletion.scheduledFor).getTime()).toBeGreaterThan(Date.now());

    expect((await request(app).get('/api/auth/me').set(bearer(token))).status).toBe(401);

    const newToken = await login();
    const duplicate = await request(app)
      .post('/api/auth/privacy/deletion')
      .set(bearer(newToken))
      .send({ password });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('DELETION_ALREADY_PENDING');

    const wrongPassword = await request(app)
      .post('/api/auth/privacy/deletion/cancel')
      .set(bearer(newToken))
      .send({ password: 'WrongPassword' });
    expect(wrongPassword.status).toBe(400);
    expect(wrongPassword.body.code).toBe('INVALID_REAUTH');

    const canceled = await request(app)
      .post('/api/auth/privacy/deletion/cancel')
      .set(bearer(newToken))
      .send({ password });
    expect(canceled.status).toBe(200);
    expect(canceled.body.deletion.status).toBe('CANCELED');

    const status = await request(app)
      .get('/api/auth/privacy/requests')
      .set(bearer(newToken));
    expect(status.status).toBe(200);
    expect(status.body.deletion).toBeNull();
  });

  it('executes due deletion requests by erasing PII while retaining legal commerce records', async () => {
    const token = await login();
    await prisma.paymentOrder.create({
      data: {
        studentId: testUserId,
        courseId: 'retained-course',
        amountMinor: 12500,
        currency: 'EGP',
        provider: 'PAYMOB',
        status: 'PAID',
        idempotencyKey: `privacy-retention-${testUserId}`,
      },
    });

    const scheduled = await request(app)
      .post('/api/auth/privacy/deletion')
      .set(bearer(token))
      .send({ password, reason: 'Erase my account' });
    expect(scheduled.status).toBe(202);

    const past = new Date(Date.now() - 60_000);
    const staleLease = new Date(Date.now() - 20 * 60_000);
    await prisma.dataPrivacyRequest.update({
      where: { id: scheduled.body.deletion.id },
      data: {
        scheduledFor: past,
        status: 'PROCESSING',
        processingStartedAt: staleLease,
      },
    });
    await expect(cancelAccountDeletion(prisma, testUserId)).rejects.toMatchObject({
      code: 'NO_CANCELABLE_DELETION',
    });

    const result = await executeDueAccountDeletions(prisma, new Date());
    expect(result).toEqual({ processed: 1, failed: 0 });

    const erased = await prisma.user.findUniqueOrThrow({ where: { id: testUserId } });
    expect(erased.name).toBe('Deleted account');
    expect(erased.phone).toMatch(/^DELETED_/);
    expect(erased.email).toBeNull();
    expect(erased.role).toBe('DELETED');
    expect(erased.status).toBe('deleted');
    expect(erased.isApproved).toBe(false);
    expect(await prisma.userSession.count({ where: { userId: testUserId } })).toBe(0);
    expect(await prisma.paymentOrder.count({ where: { studentId: testUserId } })).toBe(1);

    const deletion = await prisma.dataPrivacyRequest.findUniqueOrThrow({
      where: { id: scheduled.body.deletion.id },
    });
    expect(deletion.status).toBe('COMPLETED');
    expect(deletion.completedAt).not.toBeNull();
    expect(deletion.requestKey).toBeNull();
  });
});
