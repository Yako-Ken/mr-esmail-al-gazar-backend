import { Request, Response, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthUser } from '../middlewares/auth.middleware';

const prisma = new PrismaClient();

const formatUrl = (baseUrl: string, url: string | null | undefined) => {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  return `${baseUrl}/uploads/${url}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/teachers/enrollments
// Returns enrollments for the teacher's courses, filtered by status.
// ─────────────────────────────────────────────────────────────────────────────
export const getTeacherEnrollments: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { status } = req.query as { status?: string };
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    // Get ownerId: ASSISTANT acts on behalf of parentTeacherId
    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId
      ? authUser.parentTeacherId
      : authUser.id;

    const enrollments = await prisma.courseEnrollment.findMany({
      where: {
        ...(status ? { status: status.toUpperCase() } : {}),
        course: {
          teacherId: ownerId,
        },
      },
      include: {
        student: {
          select: { name: true, phone: true },
        },
        course: {
          select: { title: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const result = enrollments.map((e) => ({
      id: e.id,
      studentName: e.student.name,
      studentPhone: e.student.phone,
      courseTitle: e.course.title,
      paymentMethod: e.paymentMethod,
      receiptImageUrl: formatUrl(baseUrl, e.receiptImageUrl),
      status: e.status,
      createdAt: e.createdAt,
    }));

    res.json(result);
  } catch (error) {
    console.error('getTeacherEnrollments error:', error);
    res.status(500).json({ error: 'Failed to fetch enrollments' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/teachers/enrollments/:id
// Updates the status of an enrollment (e.g., from PENDING to APPROVED or REJECTED)
// ─────────────────────────────────────────────────────────────────────────────
export const updateEnrollmentStatus: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const { status } = req.body as { status?: string };

    if (!status || !['PENDING', 'APPROVED', 'REJECTED'].includes(status.toUpperCase())) {
      res.status(400).json({ error: 'Invalid status' });
      return;
    }

    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId
      ? authUser.parentTeacherId
      : authUser.id;

    // Verify ownership
    const enrollment = await prisma.courseEnrollment.findUnique({
      where: { id },
      include: { course: true },
    });

    if (!enrollment) {
      res.status(404).json({ error: 'Enrollment not found' });
      return;
    }

    if (enrollment.course.teacherId !== ownerId) {
      res.status(403).json({ error: 'Forbidden: You do not own this course' });
      return;
    }

    const updated = await prisma.courseEnrollment.update({
      where: { id },
      data: { status: status.toUpperCase() },
    });

    res.json({
      message: `Enrollment status updated to ${updated.status}`,
      enrollment: updated,
    });
  } catch (error) {
    console.error('updateEnrollmentStatus error:', error);
    res.status(500).json({ error: 'Failed to update enrollment status' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/teachers/payments/pending
// ─────────────────────────────────────────────────────────────────────────────
export const getPendingPayments: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId
      ? authUser.parentTeacherId
      : authUser.id;

    const enrollments = await prisma.courseEnrollment.findMany({
      where: {
        status: 'PENDING',
        course: { teacherId: ownerId },
      },
      include: {
        student: { select: { name: true, phone: true } },
        course: { select: { title: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const result = enrollments.map((e) => ({
      id: e.id,
      studentName: e.student.name,
      studentPhone: e.student.phone,
      courseTitle: e.course.title,
      paymentMethod: e.paymentMethod,
      receiptImageUrl: formatUrl(baseUrl, e.receiptImageUrl),
      createdAt: e.createdAt,
    }));

    console.log('Pending payments:', { count: result.length, ownerId });
    res.json(result);
  } catch (error) {
    console.error('getPendingPayments error:', error);
    res.status(500).json({ error: 'Failed to fetch pending payments' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/teachers/payments/:id/approve
// ─────────────────────────────────────────────────────────────────────────────
export const approvePayment: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId
      ? authUser.parentTeacherId
      : authUser.id;

    const enrollment = await prisma.courseEnrollment.findUnique({
      where: { id },
      include: { course: true },
    });

    if (!enrollment) {
      res.status(404).json({ error: 'Enrollment not found' });
      return;
    }

    if (enrollment.course.teacherId !== ownerId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    if (enrollment.status !== 'PENDING') {
      res.status(400).json({ error: 'Enrollment is not pending' });
      return;
    }

    const updated = await prisma.courseEnrollment.update({
      where: { id },
      data: { status: 'APPROVED' },
    });

    console.log('Payment APPROVED:', { id, student: enrollment.studentId, course: enrollment.courseId, by: authUser.id });
    res.json({ message: 'Payment approved successfully', enrollment: updated });
  } catch (error) {
    console.error('approvePayment error:', error);
    res.status(500).json({ error: 'Failed to approve payment' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/teachers/payments/history
// ─────────────────────────────────────────────────────────────────────────────
export const getPaymentHistory: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId
      ? authUser.parentTeacherId
      : authUser.id;

    const enrollments = await prisma.courseEnrollment.findMany({
      where: {
        status: { in: ['APPROVED', 'REJECTED'] },
        course: { teacherId: ownerId },
      },
      include: {
        student: { select: { name: true, phone: true } },
        course: { select: { title: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const result = enrollments.map((e) => ({
      id: e.id,
      studentName: e.student.name,
      studentPhone: e.student.phone,
      courseTitle: e.course.title,
      paymentMethod: e.paymentMethod,
      receiptImageUrl: formatUrl(baseUrl, e.receiptImageUrl),
      status: e.status,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    }));

    console.log('Payment history:', { count: result.length, ownerId });
    res.json(result);
  } catch (error) {
    console.error('getPaymentHistory error:', error);
    res.status(500).json({ error: 'Failed to fetch payment history' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/teachers/payments/:id/reject
// ─────────────────────────────────────────────────────────────────────────────
export const rejectPayment: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId
      ? authUser.parentTeacherId
      : authUser.id;

    const enrollment = await prisma.courseEnrollment.findUnique({
      where: { id },
      include: { course: true },
    });

    if (!enrollment) {
      res.status(404).json({ error: 'Enrollment not found' });
      return;
    }

    if (enrollment.course.teacherId !== ownerId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const updated = await prisma.courseEnrollment.update({
      where: { id },
      data: { status: 'REJECTED' },
    });

    console.log('Payment REJECTED:', { id, by: authUser.id });
    res.json({ message: 'Payment rejected', enrollment: updated });
  } catch (error) {
    console.error('rejectPayment error:', error);
    res.status(500).json({ error: 'Failed to reject payment' });
  }
};
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/teachers/students/:studentId/enroll
// Manually enrolls a student into a course (status: APPROVED)
// ─────────────────────────────────────────────────────────────────────────────
export const enrollStudentByTeacher: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { studentId } = req.params;
    const { courseId } = req.body as { courseId?: string };

    if (!courseId) {
      res.status(400).json({ error: 'Course ID is required' });
      return;
    }

    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId
      ? authUser.parentTeacherId
      : authUser.id;

    // Verify course ownership
    const course = await prisma.course.findFirst({
      where: { id: courseId, teacherId: ownerId },
    });

    if (!course) {
      res.status(403).json({ error: 'Course not found or forbidden' });
      return;
    }

    // Check if student exists
    const student = await prisma.user.findUnique({
      where: { id: studentId, role: 'STUDENT' },
    });

    if (!student) {
      res.status(404).json({ error: 'Student not found' });
      return;
    }

    // Check if already enrolled
    const existing = await prisma.courseEnrollment.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
    });

    if (existing) {
      if (existing.status === 'APPROVED') {
        res.status(400).json({ error: 'Student is already enrolled in this course' });
        return;
      }
      // If PENDING or REJECTED, update to APPROVED
      await prisma.courseEnrollment.update({
        where: { id: existing.id },
        data: { status: 'APPROVED' },
      });
    } else {
      // Create new enrollment
      await prisma.courseEnrollment.create({
        data: {
          studentId,
          courseId,
          status: 'APPROVED',
          paymentMethod: 'TEACHER_MANUAL',
        },
      });
    }

    console.log('Student enrolled by teacher:', { studentId, courseId, by: authUser.id });
    res.json({ message: 'Student enrolled successfully' });
  } catch (error) {
    console.error('enrollStudentByTeacher error:', error);
    res.status(500).json({ error: 'Failed to enroll student' });
  }
};
