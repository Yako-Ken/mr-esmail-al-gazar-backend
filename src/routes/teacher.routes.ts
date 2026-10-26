import {
  getLessonAccess,
  addStudentToLesson,
  removeStudentFromLesson,
  setLessonAccessMode,
} from '../controllers/lessonAccess.controller';
import { Router, Request, Response, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { authMiddleware, AuthUser, isApprovedUser } from '../middlewares/auth.middleware';
import { roleMiddleware } from '../middlewares/role.middleware';
import { getTeacherEnrollments, updateEnrollmentStatus, enrollStudentByTeacher, getPendingPayments, getPaymentHistory, approvePayment, rejectPayment } from '../controllers/enrollment.controller';
import { getTeacherStudents, removeStudentEnrollment, getTeacherCoursesForGrading, getCourseAssignments, getCourseQuizzes, getAssignmentSubmissions, updateSubmissionStatus, getHomeworkRegister, gradeHomework, returnHomework, startHomeworkReview } from '../controllers/student.controller';
import { logger } from '../utils/logger';
import { maskName } from '../utils/redact';

import prisma from '../config/prisma';

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

// Computed earnings ledger for the settlements screen. Read-only: payouts
// happen externally, and REQUESTED refunds are shown separately because the
// provider has not confirmed them yet.
export const getTeacherSettlements: RequestHandler = async (req, res): Promise<void> => {
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
    const courseIds = courses.map((course) => course.id);
    const titleById = new Map(courses.map((course) => [course.id, course.title]));

    const paidOrders = await prisma.paymentOrder.findMany({
      where: { courseId: { in: courseIds }, status: 'PAID' },
      orderBy: { paidAt: 'desc' },
      select: {
        id: true,
        courseId: true,
        amountMinor: true,
        currency: true,
        paidAt: true,
        createdAt: true,
      },
    });

    const orderIds = paidOrders.map((order) => order.id);
    const refunds = orderIds.length
      ? await prisma.refund.findMany({
          where: { paymentOrderId: { in: orderIds } },
          select: { paymentOrderId: true, amountMinor: true, status: true },
        })
      : [];
    const refundByOrder = new Map<string, number>();
    for (const refund of refunds) {
      const current = refundByOrder.get(refund.paymentOrderId) ?? 0;
      refundByOrder.set(refund.paymentOrderId, current + refund.amountMinor);
    }
    const confirmedRefundOrderIds = new Set(
      refunds
        .filter((refund) => refund.status === 'REFUNDED')
        .map((refund) => refund.paymentOrderId),
    );
    const refundPendingMinor = refunds
      .filter((refund) => refund.status === 'REQUESTED' || refund.status === 'PROCESSING')
      .reduce((total, refund) => total + refund.amountMinor, 0);

    const grossPaidMinor = paidOrders.reduce((total, order) => total + order.amountMinor, 0);
    const refundedConfirmedMinor = paidOrders
      .filter((order) => confirmedRefundOrderIds.has(order.id))
      .reduce((total, order) => total + (refundByOrder.get(order.id) ?? 0), 0);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const grossThisMonthMinor = paidOrders
      .filter((order) => (order.paidAt ?? order.createdAt) >= monthStart)
      .reduce((total, order) => total + order.amountMinor, 0);

    const perCourseMap = new Map<string, { ordersCount: number; paidMinor: number; refundedMinor: number }>();
    for (const order of paidOrders) {
      const entry = perCourseMap.get(order.courseId) ?? { ordersCount: 0, paidMinor: 0, refundedMinor: 0 };
      entry.ordersCount += 1;
      entry.paidMinor += order.amountMinor;
      if (confirmedRefundOrderIds.has(order.id)) {
        entry.refundedMinor += refundByOrder.get(order.id) ?? 0;
      }
      perCourseMap.set(order.courseId, entry);
    }

    res.json({
      currency: 'EGP',
      summary: {
        grossPaidMinor,
        refundedConfirmedMinor,
        refundPendingMinor,
        netMinor: grossPaidMinor - refundedConfirmedMinor,
        grossThisMonthMinor,
      },
      perCourse: [...perCourseMap.entries()].map(([courseId, entry]) => ({
        courseId,
        courseTitle: titleById.get(courseId) ?? 'Course',
        ...entry,
      })),
      recentOrders: paidOrders.slice(0, 10).map((order) => ({
        id: order.id,
        courseTitle: titleById.get(order.courseId) ?? 'Course',
        amountMinor: order.amountMinor,
        currency: order.currency,
        refundedMinor: refundByOrder.get(order.id) ?? 0,
        paidAt: order.paidAt,
      })),
      disclaimer:
        'صافي الأرباح محسوب من المدفوعات الموثقة ناقص الاستردادات المؤكدة فقط. الاستردادات قيد المراجعة تُعرض منفصلة حتى تأكيد المزود، والتحويل البنكي يتم خارج النظام.',
    });
  } catch (error) {
    logger.error('getTeacherSettlements error:', error);
    res.status(500).json({ error: 'Could not load settlements.' });
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

    logger.info('Assistant deleted:', { id, name: maskName(assistant.name), by: authUser.id });
    res.json({ message: 'Assistant deleted successfully' });
  } catch (error) {
    logger.error('Delete assistant error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const router = Router();

// Teacher account creation (Super Admin only)
router.post('/teachers', authMiddleware, roleMiddleware('SUPER_ADMIN'), isApprovedUser, createTeacher);

// Stats
router.get('/stats', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, getTeacherStats);

// Assistant management
router.post('/assistants', authMiddleware, roleMiddleware('TEACHER', 'SUPER_ADMIN'), isApprovedUser, createAssistant);
router.get('/assistants', authMiddleware, roleMiddleware('TEACHER', 'SUPER_ADMIN'), isApprovedUser, getAssistants);
router.delete('/assistants/:id', authMiddleware, roleMiddleware('TEACHER', 'SUPER_ADMIN'), isApprovedUser, deleteAssistant);

// Enrollments (Payment Approvals)
router.get('/enrollments', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, getTeacherEnrollments);
router.put('/enrollments/:id', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, updateEnrollmentStatus);

// Webhook-driven sales. Manual receipt approval endpoints are intentionally removed.
router.get('/payments/summary', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, getTeacherSalesSummary);
router.get('/payments/settlements', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, getTeacherSettlements);
// Manual Payment Approvals (Vodafone Cash / InstaPay receipts)
router.get('/payments/pending', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, getPendingPayments);
router.get('/payments/history', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, getPaymentHistory);
router.post('/payments/:id/approve', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, approvePayment);
router.post('/payments/:id/reject', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, rejectPayment);

// Student management
router.get('/students', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, getTeacherStudents);
router.post('/students/:studentId/enroll', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, enrollStudentByTeacher);
router.post('/students/:studentId/courses/:courseId/remove', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, removeStudentEnrollment);

// Homework Correction - 3-Level Hierarchy
router.get('/courses', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, getTeacherCoursesForGrading);
router.get('/courses/:courseId/assignments', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, getCourseAssignments);
router.get('/courses/:courseId/quizzes', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, getCourseQuizzes);
router.get('/assignments/:assignmentId/submissions', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, getAssignmentSubmissions);
router.post('/assignments/:assignmentId/status', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, updateSubmissionStatus);

// Homework lifecycle. Separate endpoints rather than one status endpoint with a
// free-text status, because each move carries different required data: grading
// needs a mark, returning needs feedback. A single status field could not
// express that, which is how a submission could be "graded" with no grade.
router.get(
  '/assignments/:assignmentId/register',
  authMiddleware,
  roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'),
  isApprovedUser,
  getHomeworkRegister,
);
router.post(
  '/assignments/:assignmentId/grade',
  authMiddleware,
  roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'),
  isApprovedUser,
  gradeHomework,
);
router.post(
  '/assignments/:assignmentId/return',
  authMiddleware,
  roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'),
  isApprovedUser,
  returnHomework,
);
router.post(
  '/assignments/:assignmentId/review',
  authMiddleware,
  roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'),
  isApprovedUser,
  startHomeworkReview,
);


// Lesson video granular access control
router.get('/lessons/:id/access', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, getLessonAccess);
router.post('/lessons/:id/access', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, addStudentToLesson);
router.delete('/lessons/:id/access/:studentId', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, removeStudentFromLesson);
router.put('/lessons/:id/access-mode', authMiddleware, roleMiddleware('TEACHER', 'ASSISTANT', 'SUPER_ADMIN'), isApprovedUser, setLessonAccessMode);

export default router;
