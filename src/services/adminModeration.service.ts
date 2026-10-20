import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

import prisma from '../config/prisma';

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
  // Typed explicitly so the same object can be passed to both `count` and
  // `groupBy`, whose `where` overloads are narrower than findMany's.
  const where: Prisma.CourseWhereInput =
    status === 'PUBLISHED'
      ? { isPublished: true }
      : status === 'DRAFT'
        ? { isPublished: false }
        : {};

  // Read all three values inside ONE interactive transaction at REPEATABLE READ
  // so they observe the same snapshot.
  //
  // Under PostgreSQL's READ COMMITTED every statement takes its own connection
  // and therefore its own snapshot, so a concurrent insert landing between them
  // makes `summary` disagree with `total`. SQLite serialised the reads and hid
  // the defect; it surfaced immediately after the move to PostgreSQL.
  //
  // REPEATABLE READ is used rather than the default because it is the level that
  // actually pins a snapshot for the whole transaction. (An array-form
  // `$transaction` would also be consistent, but it loses contextual typing on
  // `groupBy`, so the `by: ['isPublished']` tuple no longer type-checks.)
  const { courses, total, statusCounts } = await prisma.$transaction(
    async (tx) => {
      const [rows, count, groups] = await Promise.all([
        tx.course.findMany({
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
        tx.course.count({ where }),
        tx.course.groupBy({
          by: ['isPublished'],
          _count: { _all: true },
        }),
      ]);
      return { courses: rows, total: count, statusCounts: groups };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );

  // The summary must describe the SAME result set as `total`.
  //
  // Previously groupBy ran with no filter, so `?status=DRAFT` returned a
  // platform-wide summary next to a filtered total. When a single status filter
  // is active we now derive the buckets straight from `total` â€” which is also
  // immune to the concurrent-write race, because it is a value we already hold.
  let summary: Record<string, number> = { PUBLISHED: 0, DRAFT: 0 };
  if (status === 'PUBLISHED') {
    summary = { PUBLISHED: total, DRAFT: 0 };
  } else if (status === 'DRAFT') {
    summary = { PUBLISHED: 0, DRAFT: total };
  } else {
    for (const group of statusCounts) {
      const counts = group._count;
      const value =
        counts && typeof counts === 'object' && '_all' in counts ? counts._all ?? 0 : 0;
      summary[group.isPublished ? 'PUBLISHED' : 'DRAFT'] = value;
    }
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
    teacherName: course.teacher?.name ?? 'Ù…Ø¹Ù„Ù… Ù…Ø­Ø°ÙˆÙ',
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
