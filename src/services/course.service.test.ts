import { PrismaClient } from '@prisma/client';
import * as courseService from './course.service';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/appError';
import { AuthUser } from '../middlewares/auth.middleware';

const prisma = new PrismaClient();

const makeAuthUser = (overrides: Partial<AuthUser> = {}): AuthUser => ({
  id: 'teacher-1',
  phone: '01000000001',
  role: 'TEACHER',
  isApproved: true,
  status: 'approved',
  parentTeacherId: null,
  sessionId: null,
  ...overrides,
});

describe('course.service', () => {
  let teacherId: string;
  let otherTeacherId: string;

  beforeAll(async () => {
    const teacher = await prisma.user.create({
      data: { name: 'Teacher One', phone: '01000000001', password: 'x', role: 'TEACHER' },
    });
    teacherId = teacher.id;

    const otherTeacher = await prisma.user.create({
      data: { name: 'Teacher Two', phone: '01000000002', password: 'x', role: 'TEACHER' },
    });
    otherTeacherId = otherTeacher.id;
  });

  afterAll(async () => {
    await prisma.course.deleteMany({ where: { teacherId: { in: [teacherId, otherTeacherId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [teacherId, otherTeacherId] } } });
    await prisma.$disconnect();
  });

  describe('createCourse', () => {
    it('creates a course for the authenticated teacher', async () => {
      const authUser = makeAuthUser({ id: teacherId });
      const course = await courseService.createCourse(authUser, { title: 'Algebra 101', price: '100' }, undefined);
      expect(course.title).toBe('Algebra 101');
      expect(course.teacherId).toBe(teacherId);
      expect(course.price).toBe(100);
      expect(course.priceMinor).toBe(10000);
      expect(course.currency).toBe('EGP');
      expect(course.isPublished).toBe(false);
    });

    it('rejects a missing title', async () => {
      const authUser = makeAuthUser({ id: teacherId });
      await expect(courseService.createCourse(authUser, { title: '  ' }, undefined)).rejects.toBeInstanceOf(BadRequestError);
    });

    it('rejects a negative price', async () => {
      const authUser = makeAuthUser({ id: teacherId });
      await expect(
        courseService.createCourse(authUser, { title: 'Bad Price Course', price: '-5' }, undefined)
      ).rejects.toBeInstanceOf(BadRequestError);
    });
  });

  describe('ownership checks', () => {
    it('lets the owning teacher update their course', async () => {
      const authUser = makeAuthUser({ id: teacherId });
      const course = await courseService.createCourse(authUser, { title: 'Original Title' }, undefined);
      const updated = await courseService.updateCourse(course.id, authUser, { title: 'New Title' });
      expect(updated.title).toBe('New Title');
    });

    it('blocks a different teacher from updating someone else\'s course', async () => {
      const owner = makeAuthUser({ id: teacherId });
      const intruder = makeAuthUser({ id: otherTeacherId });
      const course = await courseService.createCourse(owner, { title: 'Owned by Teacher One' }, undefined);

      await expect(courseService.updateCourse(course.id, intruder, { title: 'Hijacked' })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('lets SUPER_ADMIN update any course regardless of ownership', async () => {
      const owner = makeAuthUser({ id: teacherId });
      const admin = makeAuthUser({ id: 'admin-1', role: 'SUPER_ADMIN' });
      const course = await courseService.createCourse(owner, { title: 'Admin Editable' }, undefined);

      const updated = await courseService.updateCourse(course.id, admin, { title: 'Edited by Admin' });
      expect(updated.title).toBe('Edited by Admin');
    });

    it('throws NotFoundError for a nonexistent course id', async () => {
      const authUser = makeAuthUser({ id: teacherId });
      await expect(courseService.updateCourse('does-not-exist', authUser, { title: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    });

    it('does not publish an empty course and publishes after a lesson exists', async () => {
      const authUser = makeAuthUser({ id: teacherId });
      const course = await courseService.createCourse(authUser, { title: 'Publication Gate' }, undefined);
      await expect(
        courseService.updateCourse(course.id, authUser, { isPublished: true }),
      ).rejects.toBeInstanceOf(BadRequestError);

      await prisma.lesson.create({
        data: { courseId: course.id, teacherId, title: 'First lesson' },
      });
      const published = await courseService.updateCourse(course.id, authUser, {
        isPublished: true,
      });
      expect(published.isPublished).toBe(true);
      expect(published.publishedAt).not.toBeNull();
    });
  });

  describe('getCourseWithLessons', () => {
    it('throws NotFoundError for a nonexistent course', async () => {
      await expect(courseService.getCourseWithLessons('does-not-exist')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('returns the course with an empty lessons array when none exist', async () => {
      const authUser = makeAuthUser({ id: teacherId });
      const created = await courseService.createCourse(authUser, { title: 'Empty Lessons Course' }, undefined);
      const fetched = await courseService.getCourseWithLessons(created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.lessons).toEqual([]);
    });
  });
});
