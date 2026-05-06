import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const updateProgress = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: any }).user;
    if (!authUser || authUser.role !== 'STUDENT') {
      res.status(403).json({ error: 'Forbidden: Only students can update progress' });
      return;
    }

    const { lessonId, courseId, watchPercentage } = req.body;

    if (!lessonId || watchPercentage === undefined) {
      res.status(400).json({ error: 'Missing lessonId or watchPercentage' });
      return;
    }

    const percentage = parseFloat(watchPercentage);
    if (isNaN(percentage) || percentage < 0 || percentage > 100) {
      res.status(400).json({ error: 'Invalid watchPercentage' });
      return;
    }

    // Determine completion (threshold 90%)
    const isCompleted = percentage >= 90.0;

    const progress = await prisma.lessonProgress.upsert({
      where: {
        studentId_lessonId: {
          studentId: authUser.id,
          lessonId: lessonId,
        },
      },
      update: {
        watchPercentage: percentage,
        isCompleted: isCompleted,
        ...(courseId ? { courseId: courseId } : {}),
      },
      create: {
        studentId: authUser.id,
        lessonId: lessonId,
        courseId: courseId,
        watchPercentage: percentage,
        isCompleted: isCompleted,
      },
    });

    res.json({ success: true, progress });
  } catch (error) {
    console.error('updateProgress error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
