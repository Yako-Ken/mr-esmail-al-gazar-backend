import { Request, Response, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthUser } from '../middlewares/auth.middleware';
import path from 'path';
import fs from 'fs';

const prisma = new PrismaClient();

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
      orderBy: { createdAt: 'desc' },
      include: {
        teacher: { select: { id: true, name: true } },
        _count: { select: { lessons: true } },
      },
    });
    
    // DEBUG: Log what's being fetched from DB
    console.log('🔥 DEBUG: Fetched courses from DB:', courses.map(c => ({ id: c.id, title: c.title, description: c.description, grade: c.grade })));

    const result = courses.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description ?? null,
      subject: c.subject ?? null,
      grade: c.grade ?? null,
      price: c.price,
      thumbnailUrl: formatUrl(baseUrl, c.thumbnailUrl),
      teacherName: c.teacher.name,
      teacherId: c.teacher.id,
      lessonCount: c._count.lessons,
    }));

    res.json(result);
  } catch (error) {
    console.error('getStoreCourses error:', error);
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

    const course = await prisma.course.findUnique({
      where: { id },
      include: {
        teacher: { 
          select: { 
            id: true, 
            name: true, 
            vodafoneCashNumber: true, 
            instapayHandle: true 
          } 
        },
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
      thumbnailUrl: formatUrl(baseUrl, course.thumbnailUrl),
      teacher: course.teacher,
      isOwned,
      lessons: course.lessons.map((l) => {
        const firstQuiz = l.quizzes && l.quizzes.length > 0 ? l.quizzes[0] : null;
        
        let parsedQuizData: any = null;
        if (firstQuiz?.questions != null) {
          try {
            parsedQuizData = JSON.parse(firstQuiz.questions);
          } catch (e) {
            console.error('Failed to parse quiz questions:', e);
          }
        }
        
        return {
          id: l.id,
          title: l.title,
          thumbnailUrl: formatUrl(baseUrl, l.thumbnailUrl),
          description: l.description,
          isLocked: !isOwned,
          homeworkPdfUrl: l.homeworkPdfUrl,
          homeworkText: l.homeworkText,
          hasQuiz: firstQuiz !== null,
          quizId: firstQuiz?.id ?? null,
          quiz: firstQuiz ? {
            id: firstQuiz.id,
            title: parsedQuizData != null ? (parsedQuizData['title'] || 'Untitled Quiz') : 'Untitled Quiz',
            questions: parsedQuizData != null && parsedQuizData['questions'] != null 
                ? parsedQuizData['questions'] 
                : [],
            timeLimitMinutes: parsedQuizData != null && parsedQuizData['timeLimit'] != null 
                ? parsedQuizData['timeLimit'] 
                : 30,
          } : null,
        };
      }),
    });
  } catch (error) {
    console.error('getStoreCourseById error:', error);
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
      price: e.course.price,
      thumbnailUrl: formatUrl(baseUrl, e.course.thumbnailUrl),
      teacherName: e.course.teacher.name,
      lessonCount: e.course._count.lessons,
      enrollmentStatus: e.status,
    }));

    res.json(result);
  } catch (error) {
    console.error('getMyPurchasedCourses error:', error);
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

    const { courseId, paymentMethod } = req.body as { courseId?: string; paymentMethod?: string };

    if (!courseId) {
      res.status(400).json({ error: 'courseId is required' });
      return;
    }

    // ── Fetch course first so we know if it's free ────────────────────────
    const course = await prisma.course.findUnique({ where: { id: courseId } });
    if (!course) {
      res.status(404).json({ error: 'Course not found' });
      return;
    }

    const isFree = course.price === 0;

    // ── Validate payment info ONLY for paid courses ───────────────────────
    if (!isFree) {
      if (!paymentMethod) {
        res.status(400).json({ error: 'paymentMethod is required for paid courses' });
        return;
      }
      const allowedMethods = ['VODAFONE_CASH', 'INSTAPAY', 'FREE'];
      if (!allowedMethods.includes(paymentMethod.toUpperCase())) {
        res.status(400).json({ error: 'paymentMethod must be VODAFONE_CASH or INSTAPAY' });
        return;
      }
    }

    // ── Guard against duplicate enrollment ────────────────────────────────
    const existing = await prisma.courseEnrollment.findUnique({
      where: { studentId_courseId: { studentId: authUser.id, courseId } },
    });

    if (existing && (existing.status === 'PENDING' || existing.status === 'APPROVED')) {
      res.status(409).json({
        error: 'You already have a pending or approved enrollment for this course',
        status: existing.status,
        autoApproved: existing.status === 'APPROVED',
      });
      return;
    }

    // ── Build enrollment data ─────────────────────────────────────────────
    const file = req.file;
    const receiptImageUrl = file ? `/receipts/${file.filename}` : null;

    // Free courses → immediately APPROVED; paid → PENDING for manual review
    const enrollmentStatus = isFree ? 'APPROVED' : 'PENDING';
    const resolvedPaymentMethod = isFree ? 'FREE' : (paymentMethod ?? '').toUpperCase();

    let enrollment;

    if (existing && existing.status === 'REJECTED') {
      // Re-submission on a previously rejected paid enrollment
      enrollment = await prisma.courseEnrollment.update({
        where: { id: existing.id },
        data: {
          paymentMethod: resolvedPaymentMethod,
          receiptImageUrl: receiptImageUrl ?? existing.receiptImageUrl,
          status: enrollmentStatus,
        },
      });
    } else {
      enrollment = await prisma.courseEnrollment.create({
        data: {
          studentId: authUser.id,
          courseId,
          paymentMethod: resolvedPaymentMethod,
          receiptImageUrl,
          status: enrollmentStatus,
        },
      });
    }

    console.log(`✅ Checkout: student=${authUser.id} course=${courseId} free=${isFree} status=${enrollmentStatus}`);

    res.status(201).json({
      message: isFree
        ? 'تم الاشتراك المجاني بنجاح! يمكنك الآن الوصول إلى جميع الدروس'
        : 'تم إرسال طلبك بنجاح، جاري المراجعة',
      enrollmentId: enrollment.id,
      status: enrollment.status,
      autoApproved: isFree,
    });
  } catch (error) {
    console.error('submitCheckout error:', error);
    res.status(500).json({ error: 'Failed to submit checkout' });
  }
};
