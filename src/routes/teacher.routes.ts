import { Router, Request, Response, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { authMiddleware, AuthUser } from '../middlewares/auth.middleware';
import { getTeacherEnrollments, updateEnrollmentStatus, enrollStudentByTeacher } from '../controllers/enrollment.controller';
import { getTeacherStudents, removeStudentEnrollment, getTeacherCoursesForGrading, getCourseAssignments, getCourseQuizzes, getAssignmentSubmissions, updateSubmissionStatus } from '../controllers/student.controller';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

export const createTeacher: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (authUser.role !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Only Super Admin can create teacher accounts' });
      return;
    }

    const { name, phone, password, subjectId } = req.body as { name?: string; phone?: string; password?: string; subjectId?: string };

    if (!name || !phone || !password) {
      res.status(400).json({ error: 'Name, phone and password are required' });
      return;
    }

    const sanitizedPhone = phone.trim();

    const existingUser = await prisma.user.findUnique({
      where: { phone: sanitizedPhone },
    });

    if (existingUser) {
      res.status(409).json({ error: 'User with this phone number already exists' });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const teacher = await prisma.user.create({
      data: {
        name: name.trim(),
        phone: sanitizedPhone,
        email: sanitizedPhone + '@teacher.local',
        password: hashedPassword,
        role: 'TEACHER',
        status: 'approved',
        isApproved: true,
        isVerified: true,
        ...(subjectId ? { subjectId } : {}),
      },
    });

    res.status(201).json({
      message: 'Teacher account created successfully',
      teacher: {
        id: teacher.id,
        name: teacher.name,
        phone: teacher.phone,
        role: teacher.role,
      },
    });
  } catch (error) {
    logger.error('Create teacher error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getTeacherStats: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId 
      ? authUser.parentTeacherId 
      : authUser.id;

    const courses = await prisma.course.findMany({
      where: { teacherId: ownerId },
      select: { id: true, subject: true, grade: true },
    });

    const courseIds = courses.map(c => c.id);

    const courseEnrollments = await prisma.courseEnrollment.findMany({
      where: { courseId: { in: courseIds }, status: 'APPROVED' },
      select: { studentId: true, courseId: true },
    });

    const uniqueStudentIds = new Set<string>();
    courseEnrollments.forEach(e => uniqueStudentIds.add(e.studentId));

    const lessons = await prisma.lesson.findMany({
      where: { teacherId: ownerId },
      include: { trackings: true },
    });

    const sessions = await prisma.attendanceSession.findMany({
      where: { ownerId },
      include: { records: { select: { studentId: true } } },
    });
    const courseById = new Map(courses.map(course => [course.id, course]));
    let totalExpected = 0;
    let totalPresent = 0;
    for (const session of sessions) {
      const eligible = new Set(
        courseEnrollments
          .filter(enrollment => {
            const course = courseById.get(enrollment.courseId);
            return course?.subject === session.subject && course?.grade === session.grade;
          })
          .map(enrollment => enrollment.studentId),
      );
      totalExpected += eligible.size;
      totalPresent += session.records.filter(record => eligible.has(record.studentId)).length;
    }
    const attendancePercent = totalExpected > 0
      ? Math.round((totalPresent / totalExpected) * 100)
      : 0;

    const allTrackings = lessons.flatMap(l => l.trackings);
    const trackingsWithScore = allTrackings.filter(t => t.quizScore !== null && t.quizScore > 0);
    const avgScore = trackingsWithScore.length > 0 
      ? Math.round(trackingsWithScore.reduce((sum, t) => sum + (t.quizScore || 0), 0) / trackingsWithScore.length)
      : 0;

    const approvedEnrollments = await prisma.courseEnrollment.count({
      where: { courseId: { in: courseIds }, status: 'APPROVED' },
    });

    res.json({
      attendancePercent,
      avgScore,
      homeworkCompletion: allTrackings.filter(t => t.hwStatus !== 'NOT_SUBMITTED').length,
      totalStudents: uniqueStudentIds.size,
      totalLessons: lessons.length,
      approvedEnrollments,
    });
    logger.info('Teacher Stats:', {
      totalStudents: uniqueStudentIds.size,
      totalLessons: lessons.length,
      approvedEnrollments,
      ownerId,
    });
  } catch (error) {
    logger.error('Get teacher stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
};

export const getTeacherSalesSummary: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser || !['TEACHER', 'ASSISTANT'].includes(authUser.role)) {
      res.status(403).json({ error: 'Teachers only' });
      return;
    }
    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId
      ? authUser.parentTeacherId
      : authUser.id;
    const courses = await prisma.course.findMany({
      where: { teacherId: ownerId },
      select: { id: true, title: true },
    });
    const titleById = new Map(courses.map(course => [course.id, course.title]));
    const orders = await prisma.paymentOrder.findMany({
      where: { courseId: { in: courses.map(course => course.id) } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const sum = (statuses: string[]) => orders
      .filter(order => statuses.includes(order.status))
      .reduce((total, order) => total + order.amountMinor, 0);

    res.json({
      currency: 'EGP',
      summary: {
        grossPaidMinor: sum(['PAID']),
        pendingMinor: sum(['CREATING', 'PENDING']),
        refundedMinor: sum(['REFUNDED', 'PARTIALLY_REFUNDED']),
      },
      orders: orders.map(order => ({
        id: order.id,
        courseId: order.courseId,
        courseTitle: titleById.get(order.courseId) ?? 'Course',
        amountMinor: order.amountMinor,
        currency: order.currency,
        status: order.status,
        createdAt: order.createdAt,
      })),
      disclaimer: 'Gross sales only. Platform fees, taxes, refunds and teacher settlement are not calculated here.',
    });
  } catch (error) {
    logger.error('getTeacherSalesSummary error:', error);
    res.status(500).json({ error: 'Could not load sales summary.' });
  }
};

export const createAssistant: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (authUser.role !== 'TEACHER' && authUser.role !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Only teachers can create assistants' });
      return;
    }

    const { phone } = req.body as { phone?: string };

    if (!phone || phone.trim() === '') {
      res.status(400).json({ error: 'Phone number is required' });
      return;
    }

    const existingUser = await prisma.user.findUnique({
      where: { phone: phone.trim() },
    });

    if (existingUser) {
      res.status(409).json({ error: 'User with this phone number already exists' });
      return;
    }

    const hashedPassword = await bcrypt.hash(phone.trim(), 10);

    const assistant = await prisma.user.create({
      data: {
        name: 'مساعد',
        phone: phone.trim(),
        email: phone.trim() + '@assistant.local',
        password: hashedPassword,
        role: 'ASSISTANT',
        status: 'approved',
        isApproved: true,
        isVerified: true,
        parentTeacherId: authUser.id,
      },
    });

    res.status(201).json({
      message: 'Assistant created successfully',
      assistant: {
        id: assistant.id,
        name: assistant.name,
        phone: assistant.phone,
        role: assistant.role,
      },
    });
  } catch (error) {
    logger.error('Create assistant error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getAssistants: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (authUser.role !== 'TEACHER' && authUser.role !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Only teachers can view assistants' });
      return;
    }

    const assistants = await prisma.user.findMany({
      where: { parentTeacherId: authUser.id, role: 'ASSISTANT' },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        status: true,
        isApproved: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(assistants);
  } catch (error) {
    logger.error('Get assistants error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const deleteAssistant: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;

    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (authUser.role !== 'TEACHER' && authUser.role !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Only teachers can delete assistants' });
      return;
    }

    const { id } = req.params;

    const assistant = await prisma.user.findFirst({
      where: { id, parentTeacherId: authUser.id, role: 'ASSISTANT' },
    });

    if (!assistant) {
      res.status(404).json({ error: 'Assistant not found' });
      return;
    }

    await prisma.user.delete({ where: { id } });

    logger.info('Assistant deleted:', { id, name: assistant.name, by: authUser.id });
    res.json({ message: 'Assistant deleted successfully' });
  } catch (error) {
    logger.error('Delete assistant error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const router = Router();

// Teacher account creation (Super Admin only)
router.post('/teachers', authMiddleware, createTeacher);

// Stats
router.get('/stats', authMiddleware, getTeacherStats);

// Assistant management
router.post('/assistants', authMiddleware, createAssistant);
router.get('/assistants', authMiddleware, getAssistants);
router.delete('/assistants/:id', authMiddleware, deleteAssistant);

// Enrollments (Payment Approvals)
router.get('/enrollments', authMiddleware, getTeacherEnrollments);
router.put('/enrollments/:id', authMiddleware, updateEnrollmentStatus);

// Webhook-driven sales. Manual receipt approval endpoints are intentionally removed.
router.get('/payments/summary', authMiddleware, getTeacherSalesSummary);
router.all('/payments/pending', authMiddleware, (_req, res) => res.status(410).json({
  error: 'Manual payment approvals are no longer supported.',
  code: 'MANUAL_PAYMENTS_REMOVED',
}));
router.all('/payments/history', authMiddleware, (_req, res) => res.status(410).json({
  error: 'Use /payments/summary for webhook-driven sales.',
  code: 'MANUAL_PAYMENTS_REMOVED',
}));
router.all('/payments/:id/approve', authMiddleware, (_req, res) => res.status(410).json({
  error: 'Payment state is controlled by verified provider webhooks.',
  code: 'MANUAL_PAYMENTS_REMOVED',
}));
router.all('/payments/:id/reject', authMiddleware, (_req, res) => res.status(410).json({
  error: 'Payment state is controlled by verified provider webhooks.',
  code: 'MANUAL_PAYMENTS_REMOVED',
}));

// Student management
router.get('/students', authMiddleware, getTeacherStudents);
router.post('/students/:studentId/enroll', authMiddleware, enrollStudentByTeacher);
router.post('/students/:studentId/courses/:courseId/remove', authMiddleware, removeStudentEnrollment);

// Homework Correction - 3-Level Hierarchy
router.get('/courses', authMiddleware, getTeacherCoursesForGrading);
router.get('/courses/:courseId/assignments', authMiddleware, getCourseAssignments);
router.get('/courses/:courseId/quizzes', authMiddleware, getCourseQuizzes);
router.get('/assignments/:assignmentId/submissions', authMiddleware, getAssignmentSubmissions);
router.post('/assignments/:assignmentId/status', authMiddleware, updateSubmissionStatus);

export default router;