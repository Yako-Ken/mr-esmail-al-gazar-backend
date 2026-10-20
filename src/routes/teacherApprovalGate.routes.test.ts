import request from 'supertest';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import app from '../app';

import prisma from '../config/prisma';

const pendingTeacherPhone = '01050505051';
const unapprovedTeacherPhone = '01050505055';
const PASSWORD = 'Pending@2026';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const login = async (phone: string): Promise<string> => {
  const response = await request(app)
    .post('/api/auth/login')
    .set('X-Device-Name', 'Approval gate test device')
    .send({ identifier: phone, password: PASSWORD });
  expect(response.status).toBe(200);
  return response.body.token as string;
};

beforeAll(async () => {
  await prisma.user.deleteMany({
    where: { phone: { in: [pendingTeacherPhone, unapprovedTeacherPhone] } },
  });

  // status: pending — routed away by checkTeacherApproval before the isApproved test
  await prisma.user.create({
    data: {
      name: 'Pending Teacher',
      phone: pendingTeacherPhone,
      password: await bcrypt.hash(PASSWORD, 12),
      role: 'TEACHER',
      status: 'pending',
      isApproved: false,
    },
  });

  // status: approved but isApproved false — reaches the isApproved branch
  await prisma.user.create({
    data: {
      name: 'Unapproved Teacher',
      phone: unapprovedTeacherPhone,
      password: await bcrypt.hash(PASSWORD, 12),
      role: 'TEACHER',
      status: 'approved',
      isApproved: false,
    },
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({
    where: { phone: { in: [pendingTeacherPhone, unapprovedTeacherPhone] } },
  });
  await prisma.$disconnect();
});

/**
 * Rule EH-5: no `debug:` key in any response.
 *
 * checkTeacherApproval used to answer 403 with
 * `{ error, debug: { status, isApproved } }`, publishing each teacher's
 * account state to the client. The message and the status code are the
 * client's only actionable signals.
 */
describe('teacher approval gate response shape', () => {
  it('returns 403 with no debug payload for a pending teacher', async () => {
    const token = await login(pendingTeacherPhone);
    const res = await request(app)
      .post('/api/upload/video-ticket')
      .set(bearer(token))
      .send({ fileName: 'a.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty('debug');
  });

  it('returns 403 with no debug payload for an approved-but-unapproved teacher', async () => {
    const token = await login(unapprovedTeacherPhone);
    const res = await request(app)
      .post('/api/upload/video-ticket')
      .set(bearer(token))
      .send({ fileName: 'a.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty('debug');
  });

  it('never leaks account status in the denial body', async () => {
    const token = await login(pendingTeacherPhone);
    const res = await request(app)
      .post('/api/upload/video-ticket')
      .set(bearer(token))
      .send({ fileName: 'a.mp4', contentType: 'video/mp4' });

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('isApproved');
    expect(serialised.toLowerCase()).not.toContain('pending');
    // The human-facing message is unchanged, so the client contract holds.
    expect(res.body.error).toBe('Your account is not approved. Please contact Super Admin.');
  });
});
