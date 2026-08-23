import request from 'supertest';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import app from '../app';

const prisma = new PrismaClient();
const phone = '01080808080';
const otherPhone = '01080808081';

const registerAndLogin = async (userPhone: string) => {
  await prisma.user.deleteMany({ where: { phone: userPhone } });
  const user = await prisma.user.create({
    data: {
      name: 'Account Prefs Test',
      phone: userPhone,
      email: `${userPhone}@example.com`,
      password: await bcrypt.hash('Prefs@2026', 12),
      role: 'STUDENT',
      status: 'approved',
      isApproved: true,
    },
  });
  const response = await request(app)
    .post('/api/auth/login')
    .set('X-Device-Name', 'Prefs test device')
    .send({ identifier: userPhone, password: 'Prefs@2026' });
  expect(response.status).toBe(200);
  return { token: response.body.token as string, userId: user.id };
};

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('account preferences', () => {
  let token: string;
  let otherToken: string;

  beforeAll(async () => {
    ({ token } = await registerAndLogin(phone));
    ({ token: otherToken } = await registerAndLogin(otherPhone));
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { phone: { in: [phone, otherPhone] } } });
    await prisma.$disconnect();
  });

  it('rejects unauthenticated access', async () => {
    expect((await request(app).get('/api/auth/preferences')).status).toBe(401);
    expect((await request(app).put('/api/auth/preferences')).status).toBe(401);
    expect((await request(app).get('/api/auth/consent/history')).status).toBe(401);
  });

  it('returns defaults on first read and records terms acceptance once', async () => {
    const first = await request(app).get('/api/auth/preferences').set(bearer(token));
    expect(first.status).toBe(200);
    expect(first.body.preferences).toMatchObject({
      analyticsConsent: false,
      productMessagesConsent: true,
      notifLessons: true,
      quietHoursStart: '22:00',
    });

    const history = await request(app).get('/api/auth/consent/history').set(bearer(token));
    expect(history.status).toBe(200);
    expect(history.body.events).toHaveLength(1);
    expect(history.body.events[0]).toMatchObject({
      kind: 'terms_accepted',
      value: 'accepted',
    });

    // Second read must not duplicate the consent event
    await request(app).get('/api/auth/preferences').set(bearer(token));
    const again = await request(app).get('/api/auth/consent/history').set(bearer(token));
    expect(again.body.events).toHaveLength(1);
  });

  it('updates notification preferences without touching consent log', async () => {
    const update = await request(app)
      .put('/api/auth/preferences')
      .set(bearer(token))
      .send({ notifLessons: false, quietHoursEnabled: false });
    expect(update.status).toBe(200);
    expect(update.body.preferences.notifLessons).toBe(false);

    const history = await request(app).get('/api/auth/consent/history').set(bearer(token));
    expect(history.body.events).toHaveLength(1);
  });

  it('writes append-only consent events when consent flags change', async () => {
    const grant = await request(app)
      .put('/api/auth/preferences')
      .set(bearer(token))
      .send({ analyticsConsent: true });
    expect(grant.status).toBe(200);
    expect(grant.body.preferences.analyticsConsent).toBe(true);

    const withdraw = await request(app)
      .put('/api/auth/preferences')
      .set(bearer(token))
      .send({ analyticsConsent: false, productMessagesConsent: false });
    expect(withdraw.status).toBe(200);

    const history = await request(app).get('/api/auth/consent/history').set(bearer(token));
    const kinds = history.body.events.map((event: { kind: string; value: string }) => ({
      kind: event.kind,
      value: event.value,
    }));
    expect(kinds).toEqual(
      expect.arrayContaining([
        { kind: 'terms_accepted', value: 'accepted' },
        { kind: 'analytics_consent', value: 'granted' },
        { kind: 'analytics_consent', value: 'withdrawn' },
        { kind: 'product_messages_consent', value: 'withdrawn' },
      ]),
    );
  });

  it('isolates users from each other', async () => {
    const mine = await request(app).get('/api/auth/preferences').set(bearer(otherToken));
    expect(mine.status).toBe(200);
    expect(mine.body.preferences.analyticsConsent).toBe(false);

    const history = await request(app).get('/api/auth/consent/history').set(bearer(otherToken));
    expect(history.body.events).toHaveLength(1);
  });

  it('rejects invalid preference payloads', async () => {
    const invalidTime = await request(app)
      .put('/api/auth/preferences')
      .set(bearer(token))
      .send({ quietHoursStart: '25:99' });
    expect(invalidTime.status).toBe(400);

    const emptyBody = await request(app)
      .put('/api/auth/preferences')
      .set(bearer(token))
      .send({});
    expect(emptyBody.status).toBe(400);

    const unknownField = await request(app)
      .put('/api/auth/preferences')
      .set(bearer(token))
      .send({ hackerField: true });
    expect(unknownField.status).toBe(400);
  });
});

describe('support tickets', () => {
  let studentToken: string;
  let otherToken: string;

  // Rate-limit budget note: authRateLimit allows 10 requests per IP window.
  // This suite spends 2 logins here and 5 ticket POSTs below — keep it lean.
  beforeAll(async () => {
    ({ token: studentToken } = await registerAndLogin(phone));
    ({ token: otherToken } = await registerAndLogin(otherPhone));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('rejects unauthenticated creation', async () => {
    const response = await request(app)
      .post('/api/auth/support/tickets')
      .send({ subject: 'مشكلة في التطبيق', details: 'التفاصيل الكافية هنا للوصف.' });
    expect(response.status).toBe(401);
  });

  it('creates a ticket with defaults and rejects invalid payloads', async () => {
    const ok = await request(app)
      .post('/api/auth/support/tickets')
      .set(bearer(studentToken))
      .send({
        subject: 'تعذر تشغيل الدرس',
        details: 'الفيديو بيقف عند الدقيقة الأولى وجرّبت تغيير الشبكة مرتين.',
      });
    expect(ok.status).toBe(201);
    expect(ok.body.ticket).toMatchObject({
      subject: 'تعذر تشغيل الدرس',
      status: 'OPEN',
    });
    expect(typeof ok.body.ticket.id).toBe('string');

    const shortSubject = await request(app)
      .post('/api/auth/support/tickets')
      .set(bearer(studentToken))
      .send({ subject: 'مشك', details: 'تفاصيل طويلة بما يكفي للاختبار هنا.' });
    expect(shortSubject.status).toBe(400);

    const shortDetails = await request(app)
      .post('/api/auth/support/tickets')
      .set(bearer(studentToken))
      .send({ subject: 'عنوان كافٍ', details: 'قصير' });
    expect(shortDetails.status).toBe(400);
  });

  it('lists only the caller tickets newest first', async () => {
    await prisma.supportTicket.deleteMany({});

    const first = await request(app)
      .post('/api/auth/support/tickets')
      .set(bearer(studentToken))
      .send({
        subject: 'استفسار أول عن الدفع',
        details: 'هل الرجوع من صفحة الدفع يلغي العملية أم لا بالتفصيل؟',
      });
    expect(first.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await request(app)
      .post('/api/auth/support/tickets')
      .set(bearer(studentToken))
      .send({
        subject: 'استفسار ثانٍ عن الحضور',
        details: 'لم يظهر لي رمز QR الخاص بحصة اليوم رغم تحديث الصفحة.',
      });
    expect(second.status).toBe(201);
    const foreign = await request(app)
      .post('/api/auth/support/tickets')
      .set(bearer(otherToken))
      .send({
        subject: 'تذكرة مستخدم آخر',
        details: 'هذه تذكرة لمستخدم مختلف للتأكد من العزل بين الحسابات.',
      });
    expect(foreign.status).toBe(201);

    const list = await request(app)
      .get('/api/auth/support/tickets')
      .set(bearer(studentToken));
    expect(list.status).toBe(200);
    expect(list.body.tickets).toHaveLength(2);
    expect(list.body.tickets[0].subject).toContain('ثانٍ');
    for (const ticket of list.body.tickets) {
      expect(JSON.stringify(ticket)).not.toContain('details');
      expect(JSON.stringify(ticket)).not.toContain('مستخدم آخر');
    }
  });
});
