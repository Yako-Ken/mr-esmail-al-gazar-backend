import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

export interface AdminCourseRow {
  id: string;
  title: string;
  isPublished: boolean;
  publishedAt: Date | null;
  priceMinor: number;
  currency: string;
  lessonCount: number;
  enrollmentCount: number;
  teacherName: string;
  createdAt: Date;
}

export interface ListAdminCoursesParams {
  status?: 'ALL' | 'PUBLISHED' | 'DRAFT';
  page?: number;
  limit?: number;
}

export const listAdminCourses = async ({
  status = 'ALL',
  page = 1,
  limit = 20,
}: ListAdminCoursesParams) => {
  const where =
    status === 'PUBLISHED'
      ? { isPublished: true }
      : status === 'DRAFT'
        ? { isPublished: false }
        : {};

  const [courses, total, statusCounts] = await Promise.all([
    prisma.course.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        title: true,
        isPublished: true,
        publishedAt: true,
        priceMinor: true,
        currency: true,
        createdAt: true,
        _count: { select: { lessons: true, courseEnrollments: true } },
        teacher: { select: { name: true } },
      },
    }),
    prisma.course.count({ where }),
    prisma.course.groupBy({ by: ['isPublished'], _count: { _all: true } }),
  ]);

  const summary: Record<string, number> = { PUBLISHED: 0, DRAFT: 0 };
  for (const group of statusCounts) {
    summary[group.isPublished ? 'PUBLISHED' : 'DRAFT'] = group._count._all;
  }

  const rows: AdminCourseRow[] = courses.map((course) => ({
    id: course.id,
    title: course.title,
    isPublished: course.isPublished,
    publishedAt: course.publishedAt,
    priceMinor: course.priceMinor,
    currency: course.currency,
    lessonCount: course._count.lessons,
    enrollmentCount: course._count.courseEnrollments,
    teacherName: course.teacher?.name ?? 'معلم محذوف',
    createdAt: course.createdAt,
  }));

  return { courses: rows, total, page, limit, summary };
};

const writeContentAuditEvent = (
  tx: Prisma.TransactionClient,
  actorId: string,
  action: 'course_published' | 'course_unpublished',
  courseId: string,
) =>
  tx.adminAuditEvent.create({
    data: {
      actorId,
      action,
      category: 'content',
      targetType: 'course',
      targetId: courseId,
    },
  });

type PublishOutcome =
  | { code: 'NOT_FOUND' }
  | { code: 'NO_LESSONS' }
  | { code: 'ALREADY_PUBLISHED' }
  | { code: 'ALREADY_DRAFT' }
  | { code: 'OK'; title: string };

// Publication keeps the store rule: a course needs at least one lesson.
export const setCoursePublication = async (
  actorId: string,
  courseId: string,
  publish: boolean,
): Promise<PublishOutcome> => {
  const result = await prisma.$transaction(async (tx): Promise<PublishOutcome> => {
    const course = await tx.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        title: true,
        isPublished: true,
        _count: { select: { lessons: true } },
      },
    });
    if (!course) return { code: 'NOT_FOUND' };

    if (publish) {
      if (course.isPublished) return { code: 'ALREADY_PUBLISHED' };
      if (course._count.lessons < 1) return { code: 'NO_LESSONS' };
      await tx.course.update({
        where: { id: courseId },
        data: { isPublished: true, publishedAt: new Date() },
      });
      await writeContentAuditEvent(tx, actorId, 'course_published', courseId);
      return { code: 'OK', title: course.title };
    }

    if (!course.isPublished) return { code: 'ALREADY_DRAFT' };
    await tx.course.update({
      where: { id: courseId },
      data: { isPublished: false, publishedAt: null },
    });
    await writeContentAuditEvent(tx, actorId, 'course_unpublished', courseId);
    return { code: 'OK', title: course.title };
  });

  if (result.code === 'NOT_FOUND') logger.warn(`moderation for missing course ${courseId}`);
  return result;
};
