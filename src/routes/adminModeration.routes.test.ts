import request from 'supertest';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import app from '../app';

const prisma = new PrismaClient();

const adminPhone = '01040404040';
const studentPhone = '01030303031';
const teacherPhone = '01030303032';

let adminToken = '';
let studentToken = '';
let courseWithLessonId = '';
let emptyDraftId = '';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await prisma.user.deleteMany({
    where: { phone: { in: [adminPhone, studentPhone, teacherPhone] } },
  });

  await prisma.user.create({
    data: {
      name: 'Moderation Admin',
      phone: adminPhone,
      password: await bcrypt.hash('Mod@2026', 12),
      role: 'SUPER_ADMIN',
      status: 'approved',
      isApproved: true,
    },
  });
  const student = await prisma.user.create({
    data: {
      name: 'طالب عادي',
      phone: studentPhone,
      password: await bcrypt.hash('Student@2026', 12),
      role: 'STUDENT',
      status: 'approved',
      isApproved: true,
    },
  });
  const teacher = await prisma.user.create({
    data: {
      name: 'أ. معلم المحتوى',
      phone: teacherPhone,
      password: await bcrypt.hash('Teacher@2026', 12),
      role: 'TEACHER',
      status: 'approved',
      isApproved: true,
    },
  });

  const withLesson = await prisma.course.create({
    data: {
      teacherId: teacher.id,
      title: 'كورس جاهز للنشر',
      priceMinor: 25000,
      isPublished: false,
    },
  });
  await prisma.lesson.create({
    data: {
      courseId: withLesson.id,
      teacherId: teacher.id,
      title: 'الدرس الأول',
      videoUrl: 'https://cdn.example.com/demo.m3u8',
    },
  });
  courseWithLessonId = withLesson.id;

  const emptyDraft = await prisma.course.create({
    data: {
      teacherId: teacher.id,
      title: 'مسودة فاضية',
      priceMinor: 10000,
      isPublished: false,
    },
  });
  emptyDraftId = emptyDraft.id;

  const login = async (phone: string, password: string): Promise<string> => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('X-Device-Name', 'Moderation test device')
      .send({ identifier: phone, password });
    expect(response.status).toBe(200);
    return response.body.token as string;
  };

  adminToken = await login(adminPhone, 'Mod@2026');
  studentToken = await login(studentPhone, 'Student@2026');
});

afterAll(async () => {
  await prisma.adminAuditEvent.deleteMany({ where: { category: 'content' } });
  await prisma.course.deleteMany({});
  await prisma.user.deleteMany({
    where: { phone: { in: [adminPhone, studentPhone, teacherPhone] } },
  });
  await prisma.$disconnect();
});

describe('admin course moderation authorization', () => {
  it('rejects unauthenticated and non-admin access', async () => {
    expect((await request(app).get('/api/admin/courses')).status).toBe(401);
    expect(
      (
        await request(app)
          .post(`/api/admin/courses/${courseWithLessonId}/publish`)
          .set(bearer(studentToken))
      ).status,
    ).toBe(403);
    expect(
      (await request(app).get('/api/admin/courses').set(bearer(studentToken))).status,
    ).toBe(403);
  });
});

describe('admin course listing', () => {
  it('lists courses with teacher names and lesson counts plus summary', async () => {
    const response = await request(app)
      .get('/api/admin/courses')
      .set(bearer(adminToken));
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    expect(response.body.summary).toMatchObject({ PUBLISHED: 0, DRAFT: 2 });

    const ready = response.body.courses.find(
      (course: { id: string }) => course.id === courseWithLessonId,
    );
    expect(ready).toMatchObject({
      title: 'كورس جاهز للنشر',
      lessonCount: 1,
      enrollmentCount: 0,
      teacherName: 'أ. معلم المحتوى',
      currency: 'EGP',
    });
  });

  it('filters by status', async () => {
    const drafts = await request(app)
      .get('/api/admin/courses')
      .query({ status: 'DRAFT' })
      .set(bearer(adminToken));
    expect(drafts.status).toBe(200);
    expect(drafts.body.total).toBe(2);
  });

  it('rejects invalid status filters', async () => {
    const response = await request(app)
      .get('/api/admin/courses')
      .query({ status: 'REPORTED' })
      .set(bearer(adminToken));
    expect(response.status).toBe(400);
  });
});

describe('course publish/unpublish with audit trail', () => {
  it('refuses to publish an empty draft', async () => {
    const response = await request(app)
      .post(`/api/admin/courses/${emptyDraftId}/publish`)
      .set(bearer(adminToken));
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('COURSE_NOT_READY');
  });

  it('publishes a ready course and writes a content audit event', async () => {
    const response = await request(app)
      .post(`/api/admin/courses/${courseWithLessonId}/publish`)
      .set(bearer(adminToken));
    expect(response.status).toBe(200);
    expect(response.body.isPublished).toBe(true);

    const audit = await request(app)
      .get('/api/admin/audit-events')
      .query({ category: 'content' })
      .set(bearer(adminToken));
    expect(audit.status).toBe(200);
    expect(audit.body.events).toHaveLength(1);
    expect(audit.body.events[0]).toMatchObject({
      action: 'course_published',
      category: 'content',
      targetType: 'course',
      targetId: courseWithLessonId,
      actorName: 'Moderation Admin',
    });
  });

  it('rejects publishing an already-published course', async () => {
    const response = await request(app)
      .post(`/api/admin/courses/${courseWithLessonId}/publish`)
      .set(bearer(adminToken));
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('ALREADY_PUBLISHED');
  });

  it('unpublishes back to draft with its own audit event', async () => {
    const response = await request(app)
      .post(`/api/admin/courses/${courseWithLessonId}/unpublish`)
      .set(bearer(adminToken));
    expect(response.status).toBe(200);
    expect(response.body.isPublished).toBe(false);

    const audit = await request(app)
      .get('/api/admin/audit-events')
      .query({ category: 'content' })
      .set(bearer(adminToken));
    expect(audit.body.events.map((event: { action: string }) => event.action)).toEqual([
      'course_unpublished',
      'course_published',
    ]);

    // The store must no longer serve the unpublished course publicly.
    const store = await request(app).get('/api/store/courses');
    expect(store.status).toBe(200);
    expect(
      JSON.stringify(store.body)).not.toContain('كورس جاهز للنشر',
    );
  });

  it('returns 404 for unknown courses and unknown actions', async () => {
    const missing = await request(app)
      .post('/api/admin/courses/no-such-course/publish')
      .set(bearer(adminToken));
    expect(missing.status).toBe(404);

    const badAction = await request(app)
      .post(`/api/admin/courses/${courseWithLessonId}/feature`)
      .set(bearer(adminToken));
    expect(badAction.status).toBe(404);
  });
});
