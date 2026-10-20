import request from 'supertest';
import app from '../../../src/app';
import prisma from '../../../src/config/prisma';
import {
  authHeader,
  buildPaymobWebhookBody,
  cleanE2EData,
  E2E_PASSWORD,
  ensureE2EUser,
  loginUser,
} from '../helpers/test-helper';

const PHONES = {
  teacher: '01000008801',
  journeyStudent: '01000008802',
};

describe('Tier 4 Scenario 1: End-to-End Student Journey', () => {
  let teacherId: string;
  let courseId: string;
  let lessonId: string;
  let studentToken: string;
  let studentId: string;
  const coursePriceMinor = 18000; // 180 EGP

  beforeAll(async () => {
    await cleanE2EData(Object.values(PHONES));

    const teacher = await ensureE2EUser({
      phone: PHONES.teacher,
      role: 'TEACHER',
      name: 'Journey Master Teacher',
    });
    teacherId = teacher.id;

    // Create course and lesson
    const course = await prisma.course.create({
      data: {
        teacherId,
        title: 'Master Physics Course',
        description: 'Comprehensive high school physics',
        priceMinor: coursePriceMinor,
        currency: 'EGP',
        isPublished: true,
      },
    });
    courseId = course.id;

    const lesson = await prisma.lesson.create({
      data: {
        courseId,
        teacherId,
        title: 'Lesson 1: Introduction to Mechanics',
        bunnyVideoId: 'journey-mechanics-stream',
        homeworkText: 'Explain Newton’s First Law with a practical example.',
        homeworkDueAt: new Date(Date.now() + 48 * 3600 * 1000), // +2 days
      },
    });
    lessonId = lesson.id;
  }, 60000);

  afterAll(async () => {
    await cleanE2EData(Object.values(PHONES), [courseId]);
    await prisma.$disconnect();
  });

  // =========================================================================
  // Scenario 1: Step-by-Step Student Journey
  // =========================================================================
  it('Step 1: Student registers an account and logs into the platform', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Journey Student',
        email: 'journey.student@example.test',
        phone: PHONES.journeyStudent,
        password: E2E_PASSWORD,
        role: 'STUDENT',
      });

    expect(regRes.status).toBe(201);
    studentId = regRes.body.user.id;

    const loginRes = await request(app)
      .post('/api/auth/login')
      .set('X-Device-Name', 'Student-Journey-Phone')
      .send({ phone: PHONES.journeyStudent, password: E2E_PASSWORD });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body).toHaveProperty('token');
    studentToken = loginRes.body.token;
  });

  it('Step 2: Student browses course store and inspects course details', async () => {
    const res = await request(app)
      .get('/api/store/courses')
      .set(authHeader(studentToken));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const foundCourse = res.body.find((c: any) => c.id === courseId);
    expect(foundCourse).toBeDefined();
    expect(foundCourse.title).toBe('Master Physics Course');
  });

  it('Step 3: Student purchases course and Paymob webhook confirms enrollment', async () => {
    // Create pending payment order
    const order = await prisma.paymentOrder.create({
      data: {
        studentId,
        courseId,
        amountMinor: coursePriceMinor,
        currency: 'EGP',
        provider: 'PAYMOB',
        status: 'PENDING',
        idempotencyKey: `journey-order-${Date.now()}`,
        providerOrderId: '334455',
      },
    });
    await prisma.paymentAttempt.create({
      data: { paymentOrderId: order.id },
    });

    // Gateway sends valid webhook
    const webhook = buildPaymobWebhookBody({
      orderId: 334455,
      amountCents: coursePriceMinor,
    });

    const hookRes = await request(app)
      .post(`/api/store/paymob/webhook?hmac=${webhook.hmac}`)
      .send(webhook.body);

    expect([200, 202]).toContain(hookRes.status);

    // Verify enrollment is now APPROVED
    const enrollment = await prisma.courseEnrollment.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
    });
    expect(enrollment?.status).toBe('APPROVED');
  });

  it('Step 4: Student opens enrolled lesson and fetches signed video streaming URL', async () => {
    const lessonRes = await request(app)
      .get(`/api/lessons/${lessonId}`)
      .set(authHeader(studentToken));

    expect(lessonRes.status).toBe(200);
    expect(lessonRes.body.lesson.title).toBe('Lesson 1: Introduction to Mechanics');

    // Fetch video playback
    const playbackRes = await request(app)
      .get(`/api/lessons/${lessonId}/playback`)
      .set(authHeader(studentToken));

    expect(playbackRes.status).toBe(200);
    expect(playbackRes.body.protected).toBe(true);
    expect(playbackRes.body.format).toBe('hls');
    expect(playbackRes.body.url).toContain('journey-mechanics-stream');
  });

  it('Step 5: Student completes and submits homework before the deadline', async () => {
    const hwAnswer = 'Newton’s First Law states an object remains at rest unless acted upon by a net force.';
    const submitRes = await request(app)
      .post(`/api/lessons/${lessonId}/homework`)
      .set(authHeader(studentToken))
      .send({ answer: hwAnswer });

    expect(submitRes.status).toBe(201);

    const trackingRes = await request(app)
      .get(`/api/trackings/${lessonId}`)
      .set(authHeader(studentToken));

    expect(trackingRes.status).toBe(200);
    expect(trackingRes.body.tracking.hwStatus).toBe('SUBMITTED');
    const parsed = JSON.parse(trackingRes.body.tracking.essayAnswers);
    expect(parsed.answer).toBe(hwAnswer);
    expect(parsed.late).toBe(false);
  });
});
