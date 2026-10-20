import { RequestHandler } from 'express';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { AuthUser } from '../middlewares/auth.middleware';
import { resolveOwnerId } from '../utils/ownerId';
import { logger } from '../utils/logger';

import prisma from '../config/prisma';
const uploadsDir = path.resolve(process.cwd(), 'uploads');

const normalizeRelativePath = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0') || normalized.split('/').includes('..')) return null;
  const absolute = path.resolve(uploadsDir, normalized);
  if (absolute !== uploadsDir && !absolute.startsWith(`${uploadsDir}${path.sep}`)) return null;
  return normalized;
};

const pathMatches = (stored: string | null | undefined, requested: string): boolean => {
  if (!stored) return false;
  return stored.replace(/\\/g, '/').replace(/^\/+/, '') === requested;
};

export const getPrivateMedia: RequestHandler = async (req, res): Promise<void> => {
  const authUser = req.user as AuthUser | undefined;
  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const relativePath = normalizeRelativePath(req.query.path);
  if (!relativePath || relativePath.startsWith('thumbnails/')) {
    res.status(400).json({ error: 'Invalid private media path' });
    return;
  }

  try {
    const [lesson, submission, enrollmentReceipt] = await Promise.all([
      prisma.lesson.findFirst({
        where: {
          OR: [
            { videoUrl: relativePath },
            { pdfUrl: relativePath },
            { homeworkPdfUrl: relativePath },
          ],
        },
        select: { teacherId: true, courseId: true },
      }),
      prisma.tracking.findFirst({
        where: { hwFileUrl: { contains: relativePath } },
        select: { studentId: true, lesson: { select: { teacherId: true, courseId: true } } },
      }),
      prisma.courseEnrollment.findFirst({
        where: { receiptImageUrl: { contains: relativePath } },
        select: { studentId: true, course: { select: { teacherId: true } } },
      }),
    ]);

    let allowed = authUser.role === 'SUPER_ADMIN';
    const ownerId = resolveOwnerId(authUser);

    if (lesson) {
      if (authUser.role === 'STUDENT' && lesson.courseId) {
        const enrollment = await prisma.courseEnrollment.findUnique({
          where: { studentId_courseId: { studentId: authUser.id, courseId: lesson.courseId } },
          select: { status: true },
        });
        allowed = enrollment?.status === 'APPROVED';
      } else if (['TEACHER', 'ASSISTANT'].includes(authUser.role)) {
        allowed = lesson.teacherId === ownerId;
      }
    } else if (submission) {
      if (authUser.role === 'STUDENT') allowed = submission.studentId === authUser.id;
      if (['TEACHER', 'ASSISTANT'].includes(authUser.role)) {
        allowed = submission.lesson.teacherId === ownerId;
      }
    } else if (enrollmentReceipt && ['TEACHER', 'ASSISTANT'].includes(authUser.role)) {
      allowed = enrollmentReceipt.course.teacherId === ownerId;
    }

    if (!allowed) {
      res.status(404).json({ error: 'Media not found' });
      return;
    }

    const absolutePath = path.resolve(uploadsDir, relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      res.status(404).json({ error: 'Media not found' });
      return;
    }

    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.sendFile(absolutePath);
  } catch (error) {
    logger.error('Private media access error:', error);
    res.status(500).json({ error: 'Could not load media' });
  }
};
