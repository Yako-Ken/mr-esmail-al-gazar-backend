import { Request, Response, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthUser } from '../middlewares/auth.middleware';
import { logger } from '../utils/logger';

import prisma from '../config/prisma';

const formatUrl = (baseUrl: string, url: string | null | undefined) => {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  return `${baseUrl}/uploads/${url}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/store/courses
// Returns ALL published courses — no auth required.
// ─────────────────────────────────────────────────────────────────────────────
export const getStoreCourses: RequestHandler = async (req, res): Promise<void> => {
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const courses = await prisma.course.findMany({
      where: {
        isPublished: true,
        lessons: { some: {} },
        teacher: { isApproved: true },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        teacher: { select: { id: true, name: true } },
        _count: { select: { lessons: true } },
      },
    });

    const result = courses.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description ?? null,
      subject: c.subject ?? null,
      grade: c.grade ?? null,
      price: c.price,
      priceMinor: c.priceMinor > 0 ? c.priceMinor : Math.round(c.price * 100),
      currency: c.currency,
      thumbnailUrl: formatUrl(baseUrl, c.thumbnailUrl),
      teacherName: c.teacher.name,
      teacherId: c.teacher.id,
      lessonCount: c._count.lessons,
    }));

    res.json(result);
  } catch (error) {
    logger.error('getStoreCourses error:', error);
    res.status(500).json({ error: 'Failed to fetch store courses' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/store/courses/:id
// Returns a single course with its lessons list (for the details screen).
// Lessons are locked if the student does not have an APPROVED enrollment.
// ─────────────────────────────────────────────────────────────────────────────
export const getStoreCourseById: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const authUser = (req as Request & { user?: AuthUser }).user;
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const course = await prisma.course.findFirst({
      where: {
        id,
        isPublished: true,
        lessons: { some: {} },
        teacher: { isApproved: true },
      },
      include: {
        teacher: { select: { id: true, name: true } },
        lessons: {
          include: { quizzes: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!course) {
      res.status(404).json({ error: 'Course not found' });
      return;
    }

    // Check if the authenticated student has purchased this course
    let isOwned = false;
    if (authUser && authUser.role === 'STUDENT') {
      const enrollment = await prisma.courseEnrollment.findUnique({
        where: { studentId_courseId: { studentId: authUser.id, courseId: id } },
      });
      isOwned = enrollment?.status === 'APPROVED';
    }

    res.json({
      id: course.id,
      title: course.title,
      description: course.description ?? null,
      subject: course.subject ?? null,
      grade: course.grade ?? null,
      price: course.price,
      priceMinor: course.priceMinor > 0 ? course.priceMinor : Math.round(course.price * 100),
      currency: course.currency,
      thumbnailUrl: formatUrl(baseUrl, course.thumbnailUrl),
      teacher: course.teacher,
      isOwned,
      lessons: course.lessons.map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        thumbnailUrl: formatUrl(baseUrl, lesson.thumbnailUrl),
        description: lesson.description,
        isLocked: !isOwned,
        hasVideo: Boolean(lesson.videoUrl || lesson.bunnyVideoId),
        hasHomework: Boolean(lesson.homeworkText || lesson.homeworkPdfUrl),
        hasQuiz: lesson.quizzes.length > 0,
      })),
    });
  } catch (error) {
    logger.error('getStoreCourseById error:', error);
    res.status(500).json({ error: 'Failed to fetch course details' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/store/my-courses
// Returns only courses where the student has an APPROVED CourseEnrollment.
// This fixes the data-leak bug on the student home dashboard.
// ─────────────────────────────────────────────────────────────────────────────
export const getMyPurchasedCourses: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser || authUser.role !== 'STUDENT') {
      res.status(403).json({ error: 'Students only' });
      return;
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const enrollments = await prisma.courseEnrollment.findMany({
      where: { studentId: authUser.id, status: 'APPROVED' },
      include: {
        course: {
          include: {
            teacher: { select: { id: true, name: true } },
            _count: { select: { lessons: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const result = enrollments.map((e) => ({
      id: e.course.id,
      title: e.course.title,
      description: e.course.description ?? null,
      subject: e.course.subject ?? null,
      grade: e.course.grade ?? null,
      price: e.course.price,
      priceMinor: e.course.priceMinor > 0 ? e.course.priceMinor : Math.round(e.course.price * 100),
      currency: e.course.currency,
      thumbnailUrl: formatUrl(baseUrl, e.course.thumbnailUrl),
      teacherName: e.course.teacher.name,
      lessonCount: e.course._count.lessons,
      enrollmentStatus: e.status,
    }));

    res.json(result);
  } catch (error) {
    logger.error('getMyPurchasedCourses error:', error);
    res.status(500).json({ error: 'Failed to fetch purchased courses' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/store/checkout
// Free courses  (price === 0): auto-enroll with APPROVED status immediately.
// Paid courses: validate paymentMethod + receipt then create PENDING enrollment.
// ─────────────────────────────────────────────────────────────────────────────
export const submitCheckout: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser || authUser.role !== 'STUDENT') {
      res.status(403).json({ error: 'Students only' });
      return;
    }

    const { courseId } = req.body as { courseId?: string };
    if (!courseId) {
      res.status(400).json({ error: 'courseId is required' });
      return;
    }

    const course = await prisma.course.findFirst({
      where: {
        id: courseId,
        isPublished: true,
        lessons: { some: {} },
        teacher: { isApproved: true },
      },
    });
    if (!course) {
      res.status(404).json({ error: 'Course not found' });
      return;
    }

    const amountMinor = course.priceMinor > 0 ? course.priceMinor : Math.round(course.price * 100);
    const isFree = amountMinor === 0;

    const { paymentMethod, receiptImageUrl } = req.body as {
      paymentMethod?: string;
      receiptImageUrl?: string;
    };

    const existing = await prisma.courseEnrollment.findUnique({
      where: { studentId_courseId: { studentId: authUser.id, courseId } },
    });
    if (existing?.status === 'APPROVED') {
      res.status(409).json({ error: 'Course is already owned.', status: existing.status, autoApproved: true });
      return;
    }

    if (isFree) {
      const enrollment = await prisma.courseEnrollment.upsert({
        where: { studentId_courseId: { studentId: authUser.id, courseId } },
        create: {
          studentId: authUser.id,
          courseId,
          paymentMethod: 'FREE',
          status: 'APPROVED',
        },
        update: { paymentMethod: 'FREE', receiptImageUrl: null, status: 'APPROVED' },
      });
      await prisma.courseEntitlement.upsert({
        where: { studentId_courseId: { studentId: authUser.id, courseId } },
        create: { studentId: authUser.id, courseId, status: 'ACTIVE' },
        update: { status: 'ACTIVE', revokedAt: null },
      });

      logger.info('Free enrollment granted', { studentId: authUser.id, courseId });
      res.status(201).json({
        message: 'تم الاشتراك المجاني بنجاح! يمكنك الآن الوصول إلى جميع الدروس',
        enrollmentId: enrollment.id,
        status: enrollment.status,
        autoApproved: true,
      });
      return;
    }

    // Manual Wallet / InstaPay receipt checkout
    const resolvedMethod = (paymentMethod || 'VODAFONE_CASH').toUpperCase();
    const enrollment = await prisma.courseEnrollment.upsert({
      where: { studentId_courseId: { studentId: authUser.id, courseId } },
      create: {
        studentId: authUser.id,
        courseId,
        paymentMethod: resolvedMethod,
        receiptImageUrl: receiptImageUrl || null,
        status: 'PENDING',
      },
      update: {
        paymentMethod: resolvedMethod,
        receiptImageUrl: receiptImageUrl || null,
        status: 'PENDING',
      },
    });

    logger.info('Pending enrollment submitted with receipt', {
      studentId: authUser.id,
      courseId,
      method: resolvedMethod,
      receiptImageUrl,
    });

    res.status(201).json({
      message: 'تم إرسال إيصال التحويل بنجاح! جاري المراجعة وتفعيل الكورس.',
      enrollmentId: enrollment.id,
      status: 'PENDING',
      autoApproved: false,
    });
    return;
  } catch (error) {
    logger.error('submitCheckout error:', error);
    res.status(500).json({ error: 'Failed to submit checkout' });
  }
};
