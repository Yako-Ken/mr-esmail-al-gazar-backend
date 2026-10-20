import { PrismaClient } from '@prisma/client';
import { AuthUser } from '../middlewares/auth.middleware';
import { resolveOwnerId } from '../utils/ownerId';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/appError';
import { logger } from '../utils/logger';

import prisma from '../config/prisma';

export interface CourseInput {
  title?: string;
  description?: string;
  price?: string;
  subject?: string;
  grade?: string;
  thumbnailUrl?: string;
  isPublished?: boolean | string;
}

const assertOwnerOrAdmin = (courseTeacherId: string, authUser: AuthUser): void => {
  const ownerId = resolveOwnerId(authUser);
  if (courseTeacherId !== ownerId && authUser.role !== 'SUPER_ADMIN') {
    throw new ForbiddenError();
  }
};

export const listTeacherCourses = (authUser: AuthUser) => {
  const ownerId = resolveOwnerId(authUser);
  return prisma.course.findMany({
    where: { teacherId: ownerId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { lessons: true } } },
  });
};

export const listAllCourses = (authUser: AuthUser) => {
  const ownerId = resolveOwnerId(authUser);
  const whereClause = authUser.role === 'SUPER_ADMIN' ? {} : { teacherId: ownerId };
  return prisma.course.findMany({
    where: whereClause,
    orderBy: { createdAt: 'desc' },
    include: {
      teacher: { select: { id: true, name: true } },
      _count: { select: { lessons: true } },
    },
  });
};

export const createCourse = async (
  authUser: AuthUser,
  input: CourseInput,
  thumbnailRelativePath: string | undefined
) => {
  if (!input.title || input.title.trim() === '') {
    throw new BadRequestError('Course title is required');
  }

  const parsedPrice = input.price ? parseFloat(input.price) : 0;
  if (isNaN(parsedPrice) || parsedPrice < 0) {
    throw new BadRequestError('Price must be a non-negative number');
  }

  const ownerId = resolveOwnerId(authUser);
  return prisma.course.create({
    data: {
      teacherId: ownerId,
      title: input.title.trim(),
      description: input.description?.trim() ?? null,
      subject: input.subject?.trim() ?? null,
      grade: input.grade?.trim() ?? null,
      price: parsedPrice,
      priceMinor: Math.round(parsedPrice * 100),
      currency: 'EGP',
      thumbnailUrl: thumbnailRelativePath ?? null,
    },
  });
};

export const getCourseWithLessons = async (id: string) => {
  const course = await prisma.course.findFirst({
    where: { id, isPublished: true },
    include: {
      lessons: {
        include: { quizzes: true },
        orderBy: { createdAt: 'asc' },
      },
      teacher: { select: { id: true, name: true, vodafoneCashNumber: true, instapayHandle: true } },
    },
  });

  if (!course) throw new NotFoundError('Course not found');
  return course;
};

export const updateCourse = async (id: string, authUser: AuthUser, input: CourseInput) => {
  const course = await prisma.course.findFirst({ where: { id } });
  if (!course) throw new NotFoundError('Course not found');
  assertOwnerOrAdmin(course.teacherId, authUser);

  const updateData: Record<string, unknown> = {};
  if (input.title !== undefined) updateData.title = input.title.trim();
  if (input.description !== undefined) updateData.description = input.description.trim();
  if (input.price !== undefined) {
    const parsed = parseFloat(input.price);
    if (isNaN(parsed) || parsed < 0) throw new BadRequestError('Invalid course price');
    updateData.price = parsed;
    updateData.priceMinor = Math.round(parsed * 100);
    updateData.currency = 'EGP';
  }
  if (input.subject !== undefined) updateData.subject = input.subject.trim();
  if (input.grade !== undefined) updateData.grade = input.grade.trim();
  if (input.thumbnailUrl !== undefined) updateData.thumbnailUrl = input.thumbnailUrl.trim();
  if (input.isPublished !== undefined) {
    const shouldPublish = input.isPublished === true || input.isPublished === 'true';
    if (shouldPublish) {
      const lessonCount = await prisma.lesson.count({ where: { courseId: id } });
      if (lessonCount === 0) {
        throw new BadRequestError('Add at least one lesson before publishing the course');
      }
    }
    updateData.isPublished = shouldPublish;
    updateData.publishedAt = shouldPublish ? new Date() : null;
  }

  const updated = await prisma.course.update({ where: { id }, data: updateData });
  logger.info('Course updated:', { id: updated.id, title: updated.title, by: authUser.id });
  return updated;
};

export const deleteCourse = async (id: string, authUser: AuthUser) => {
  const course = await prisma.course.findFirst({ where: { id } });
  if (!course) throw new NotFoundError('Course not found');
  assertOwnerOrAdmin(course.teacherId, authUser);

  await prisma.$transaction(async (tx) => {
    await tx.tracking.deleteMany({ where: { lesson: { courseId: id } } });
    await tx.quiz.deleteMany({ where: { lesson: { courseId: id } } });
    await tx.lesson.deleteMany({ where: { courseId: id } });
    await tx.courseEnrollment.deleteMany({ where: { courseId: id } });
    await tx.course.delete({ where: { id } });
  });

  logger.info('Course DELETED (cascade):', { id, title: course.title, by: authUser.id });
};

export const updateCourseThumbnail = async (id: string, authUser: AuthUser, relativePath: string) => {
  const course = await prisma.course.findFirst({ where: { id } });
  if (!course) throw new NotFoundError('Course not found');
  assertOwnerOrAdmin(course.teacherId, authUser);

  const updated = await prisma.course.update({
    where: { id },
    data: { thumbnailUrl: relativePath },
  });
  logger.info('Thumbnail uploaded:', { courseId: id, relativePath, by: authUser.id });
  return updated;
};
