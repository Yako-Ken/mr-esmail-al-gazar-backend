import { Request, Response, RequestHandler } from 'express';
import { AuthUser } from '../middlewares/auth.middleware';
import { logger } from '../utils/logger';
import prisma from '../config/prisma';

const getOwnerId = (authUser: AuthUser): string => {
  return authUser.role === 'ASSISTANT' && authUser.parentTeacherId
    ? authUser.parentTeacherId
    : authUser.id;
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/teachers/lessons/:id/access
// ─────────────────────────────────────────────────────────────────────────────
export const getLessonAccess: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const ownerId = getOwnerId(authUser);
    const { id: lessonId } = req.params;

    const lesson = await prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { id: true, title: true, teacherId: true, accessMode: true },
    });

    if (!lesson) {
      res.status(404).json({ error: 'Lesson not found' });
      return;
    }

    if (lesson.teacherId !== ownerId && authUser.role !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Forbidden: You do not own this lesson' });
      return;
    }

    const accessList = await prisma.lessonAccess.findMany({
      where: { lessonId },
      include: {
        student: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      lessonId: lesson.id,
      title: lesson.title,
      accessMode: lesson.accessMode,
      allowedStudents: accessList.map((a) => a.student),
    });
  } catch (error) {
    logger.error('getLessonAccess error:', error);
    res.status(500).json({ error: 'Failed to fetch lesson access list' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/teachers/lessons/:id/access
// ─────────────────────────────────────────────────────────────────────────────
export const addStudentToLesson: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const ownerId = getOwnerId(authUser);
    const { id: lessonId } = req.params;
    const { studentPhone, studentId } = req.body as { studentPhone?: string; studentId?: string };

    const lesson = await prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { id: true, teacherId: true },
    });

    if (!lesson) {
      res.status(404).json({ error: 'Lesson not found' });
      return;
    }

    if (lesson.teacherId !== ownerId && authUser.role !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    let student = null;
    if (studentId) {
      student = await prisma.user.findFirst({
        where: { id: studentId, role: 'STUDENT' },
      });
    } else if (studentPhone) {
      student = await prisma.user.findFirst({
        where: { phone: studentPhone.trim(), role: 'STUDENT' },
      });
    }

    if (!student) {
      res.status(404).json({ error: 'لم يتم العثور على طالب بهذا الرقم أو المعرف' });
      return;
    }

    await prisma.lessonAccess.upsert({
      where: { studentId_lessonId: { studentId: student.id, lessonId } },
      create: { studentId: student.id, lessonId },
      update: {},
    });

    logger.info('Student added to lesson access:', { studentId: student.id, lessonId, by: authUser.id });

    res.status(201).json({
      message: 'تم منح صلاحية المشاهدة للطالب بنجاح',
      student: { id: student.id, name: student.name, phone: student.phone },
    });
  } catch (error) {
    logger.error('addStudentToLesson error:', error);
    res.status(500).json({ error: 'Failed to add student to lesson access' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/teachers/lessons/:id/access/:studentId
// ─────────────────────────────────────────────────────────────────────────────
export const removeStudentFromLesson: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const ownerId = getOwnerId(authUser);
    const { id: lessonId, studentId } = req.params;

    const lesson = await prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { id: true, teacherId: true },
    });

    if (!lesson) {
      res.status(404).json({ error: 'Lesson not found' });
      return;
    }

    if (lesson.teacherId !== ownerId && authUser.role !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    await prisma.lessonAccess.deleteMany({
      where: { studentId, lessonId },
    });

    logger.info('Student removed from lesson access:', { studentId, lessonId, by: authUser.id });

    res.json({ message: 'تم إلغاء صلاحية مشاهدة الطالب لهذا الدرس' });
  } catch (error) {
    logger.error('removeStudentFromLesson error:', error);
    res.status(500).json({ error: 'Failed to remove student from lesson' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/teachers/lessons/:id/access-mode
// ─────────────────────────────────────────────────────────────────────────────
export const setLessonAccessMode: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const ownerId = getOwnerId(authUser);
    const { id: lessonId } = req.params;
    const { accessMode } = req.body as { accessMode?: string };

    const validModes = ['COURSE_STUDENTS', 'CUSTOM_WHITELIST', 'FREE'];
    if (!accessMode || !validModes.includes(accessMode)) {
      res.status(400).json({ error: 'Invalid accessMode. Must be COURSE_STUDENTS, CUSTOM_WHITELIST, or FREE.' });
      return;
    }

    const lesson = await prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { id: true, teacherId: true },
    });

    if (!lesson) {
      res.status(404).json({ error: 'Lesson not found' });
      return;
    }

    if (lesson.teacherId !== ownerId && authUser.role !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const updated = await prisma.lesson.update({
      where: { id: lessonId },
      data: { accessMode },
      select: { id: true, title: true, accessMode: true },
    });

    logger.info('Lesson access mode updated:', { lessonId, accessMode, by: authUser.id });

    res.json({
      message: 'تم تحديث وضع صلاحيات الفيديو بنجاح',
      lesson: updated,
    });
  } catch (error) {
    logger.error('setLessonAccessMode error:', error);
    res.status(500).json({ error: 'Failed to update lesson access mode' });
  }
};
