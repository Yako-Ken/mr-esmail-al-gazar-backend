import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

import prisma from '../config/prisma';

export const updateProgress = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: any }).user;
    if (!authUser || authUser.role !== 'STUDENT') {
      res.status(403).json({ error: 'Forbidden: Only students can update progress' });
      return;
    }

    const { lessonId, courseId, watchPercentage } = req.body;
    const cleanLessonId = String(lessonId ?? '').trim();
    const requestedCourseId = courseId == null ? null : String(courseId).trim();

    if (!cleanLessonId || watchPercentage === undefined) {
      res.status(400).json({ error: 'Missing lessonId or watchPercentage' });
      return;
    }

    const percentage = parseFloat(watchPercentage);
    if (isNaN(percentage) || percentage < 0 || percentage > 100) {
      res.status(400).json({ error: 'Invalid watchPercentage' });
      return;
    }

    const lesson = await prisma.lesson.findUnique({
      where: { id: cleanLessonId },
      select: { id: true, courseId: true, course: { select: { isPublished: true } } },
    });
    if (!lesson?.courseId || !lesson.course?.isPublished) {
      res.status(404).json({ error: 'Lesson or course not found' });
      return;
    }
    if (requestedCourseId && requestedCourseId !== lesson.courseId) {
      res.status(400).json({ error: 'Lesson does not belong to the requested course' });
      return;
    }

    const enrollment = await prisma.courseEnrollment.findUnique({
      where: {
        studentId_courseId: {
          studentId: authUser.id,
          courseId: lesson.courseId,
        },
      },
      select: { status: true },
    });
    if (enrollment?.status !== 'APPROVED') {
      res.status(403).json({ error: 'You do not have access to this lesson' });
      return;
    }

    // Determine completion (threshold 90%)
    const isCompleted = percentage >= 90.0;

    const progress = await prisma.lessonProgress.upsert({
      where: {
        studentId_lessonId: {
          studentId: authUser.id,
          lessonId: cleanLessonId,
        },
      },
      update: {
        watchPercentage: percentage,
        isCompleted: isCompleted,
        courseId: lesson.courseId,
      },
      create: {
        studentId: authUser.id,
        lessonId: cleanLessonId,
        courseId: lesson.courseId,
        watchPercentage: percentage,
        isCompleted: isCompleted,
      },
    });

    res.json({ success: true, progress });
  } catch (error) {
    logger.error('updateProgress error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
