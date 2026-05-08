import { Router, Request, Response, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { authMiddleware, AuthUser } from '../middlewares/auth.middleware';
import { getTeacherEnrollments, updateEnrollmentStatus, getPendingPayments, approvePayment, rejectPayment, getPaymentHistory, enrollStudentByTeacher } from '../controllers/enrollment.controller';
import { getTeacherStudents, removeStudentEnrollment, getTeacherCoursesForGrading, getCourseAssignments, getCourseQuizzes, getAssignmentSubmissions, updateSubmissionStatus } from '../controllers/student.controller';

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
    console.error('Create teacher error:', error);
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
      select: { id: true },
    });

    const courseIds = courses.map(c => c.id);

    const courseEnrollments = await prisma.courseEnrollment.findMany({
      where: { courseId: { in: courseIds } },
      select: { studentId: true },
    });

    const uniqueStudentIds = new Set<string>();
    courseEnrollments.forEach(e => uniqueStudentIds.add(e.studentId));

    const lessons = await prisma.lesson.findMany({
      where: { teacherId: ownerId },
      include: { trackings: true },
    });

    const uniqueLessonStudents = new Set<string>();
    lessons.forEach(l => l.trackings.forEach(t => uniqueLessonStudents.add(t.studentId)));

    const totalPresent = lessons.reduce((sum, l) => sum + l.trackings.filter(t => t.isPresent).length, 0);
    const totalExpected = lessons.length > 0 && uniqueLessonStudents.size > 0 
      ? lessons.length * uniqueLessonStudents.size 
      : 0;
    const attendancePercent = totalExpected > 0 ? Math.round((totalPresent / totalExpected) * 100) : 0;

    const trackingsWithScore = lessons.flatMap(l => l.trackings).filter(t => t.quizScore !== null && t.quizScore > 0);
    const avgScore = trackingsWithScore.length > 0 
      ? Math.round(trackingsWithScore.reduce((sum, t) => sum + (t.quizScore || 0), 0) / trackingsWithScore.length)
      : 0;

    const approvedEnrollments = await prisma.courseEnrollment.count({
      where: { courseId: { in: courseIds }, status: 'APPROVED' },
    });

    res.json({
      attendancePercent,
      avgScore,
      homeworkCompletion: trackingsWithScore.length,
      totalStudents: uniqueLessonStudents.size,
      totalLessons: courses.length,
      approvedEnrollments,
    });
    console.log('Teacher Stats:', {
      totalStudents: uniqueLessonStudents.size,
      totalLessons: courses.length,
      approvedEnrollments,
      ownerId,
    });
  } catch (error) {
    console.error('Get teacher stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
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
    console.error('Create assistant error:', error);
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
    console.error('Get assistants error:', error);
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

    console.log('Assistant deleted:', { id, name: assistant.name, by: authUser.id });
    res.json({ message: 'Assistant deleted successfully' });
  } catch (error) {
    console.error('Delete assistant error:', error);
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

// Payment approvals
router.get('/payments/pending', authMiddleware, getPendingPayments);
router.get('/payments/history', authMiddleware, getPaymentHistory);
router.post('/payments/:id/approve', authMiddleware, approvePayment);
router.post('/payments/:id/reject', authMiddleware, rejectPayment);

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