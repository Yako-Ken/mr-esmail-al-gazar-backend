import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';
import { env } from '../utils/env';
import { generateParentLinkCode, hashParentLinkCode } from '../utils/linkCode';
import { secureDigestEqual } from '../utils/otp';

import prisma from '../config/prisma';

export const createParentLinkCode = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: any }).user;
    if (!authUser || authUser.role !== 'STUDENT') {
      res.status(403).json({ error: 'Only students can create a parent link code.' });
      return;
    }

    const code = generateParentLinkCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.$transaction([
      prisma.parentLinkRequest.updateMany({
        where: { studentId: authUser.id, status: 'PENDING' },
        data: { status: 'REPLACED' },
      }),
      prisma.parentLinkRequest.create({
        data: {
          studentId: authUser.id,
          studentPhone: authUser.phone,
          codeHash: hashParentLinkCode(authUser.id, code, env.JWT_SECRET),
          expiresAt,
        },
      }),
    ]);

    res.status(201).json({ code, expiresAt, studentPhone: authUser.phone });
  } catch (error) {
    logger.error('createParentLinkCode error:', error);
    res.status(500).json({ error: 'Could not create a link code.' });
  }
};

export const linkChild = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: any }).user;
    if (!authUser || authUser.role !== 'PARENT') {
      res.status(403).json({ error: 'Only parents can link a student.' });
      return;
    }

    const { studentPhone, code } = req.body as { studentPhone: string; code: string };
    const student = await prisma.user.findFirst({
      where: { phone: studentPhone, role: 'STUDENT' },
      select: { id: true, name: true, phone: true },
    });
    const genericError = { error: 'Invalid or expired link code.' };

    if (!student) {
      res.status(400).json(genericError);
      return;
    }

    const request = await prisma.parentLinkRequest.findFirst({
      where: { studentId: student.id, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });

    if (!request || request.expiresAt <= new Date() || request.attempts >= 5) {
      if (request?.status === 'PENDING') {
        await prisma.parentLinkRequest.update({
          where: { id: request.id },
          data: { status: 'EXPIRED' },
        });
      }
      res.status(400).json(genericError);
      return;
    }

    const actualHash = hashParentLinkCode(student.id, code, env.JWT_SECRET);
    if (!secureDigestEqual(actualHash, request.codeHash)) {
      await prisma.parentLinkRequest.update({
        where: { id: request.id },
        data: {
          attempts: { increment: 1 },
          status: request.attempts + 1 >= 5 ? 'LOCKED' : 'PENDING',
        },
      });
      res.status(400).json(genericError);
      return;
    }

    const existing = await prisma.studentParentRelation.findUnique({
      where: { studentId_parentId: { studentId: student.id, parentId: authUser.id } },
    });
    const guardianCount = await prisma.studentParentRelation.count({
      where: { studentId: student.id },
    });
    if (!existing && guardianCount >= 2) {
      res.status(409).json({ error: 'This student already has the maximum number of verified guardians.' });
      return;
    }

    await prisma.$transaction([
      prisma.studentParentRelation.upsert({
        where: { studentId_parentId: { studentId: student.id, parentId: authUser.id } },
        create: { studentId: student.id, parentId: authUser.id },
        update: {},
      }),
      prisma.parentLinkRequest.update({
        where: { id: request.id },
        data: {
          status: 'APPROVED',
          parentId: authUser.id,
          consumedAt: new Date(),
        },
      }),
    ]);

    res.json({
      linked: true,
      child: { id: student.id, name: student.name, phone: student.phone },
    });
  } catch (error) {
    logger.error('linkChild error:', error);
    res.status(500).json({ error: 'Could not link this student.' });
  }
};

export const unlinkChild = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: any }).user;
    if (!authUser || authUser.role !== 'PARENT') {
      res.status(403).json({ error: 'Only parents can unlink a student.' });
      return;
    }

    const result = await prisma.studentParentRelation.deleteMany({
      where: { studentId: req.params.studentId, parentId: authUser.id },
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Verified link not found.' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    logger.error('unlinkChild error:', error);
    res.status(500).json({ error: 'Could not remove the link.' });
  }
};

export const getMyChildren = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: any }).user;

    if (!authUser || authUser.role !== 'PARENT') {
      res.status(403).json({ error: 'Forbidden: Only parents can access this' });
      return;
    }

    // Access is granted only by an explicit verified relation. A phone number
    // typed during student registration is an unverified contact hint and must
    // never authorize a parent to see a child's data.
    const children = await prisma.user.findMany({
      where: {
        role: 'STUDENT',
        studentRelations: { some: { parentId: authUser.id } },
      },
    });

    const sanitizedChildren = children.map(c => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      role: c.role
    }));

    res.json({ children: sanitizedChildren });
  } catch (error) {
    logger.error('getMyChildren error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getChildStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: any }).user;
    const { studentId } = req.params;

    if (!authUser || authUser.role !== 'PARENT') {
      res.status(403).json({ error: 'Forbidden: Only parents can access this' });
      return;
    }

    // Verify ownership
    const student = await prisma.user.findFirst({
      where: {
        id: studentId,
        role: 'STUDENT',
        studentRelations: { some: { parentId: authUser.id } },
      }
    });

    if (!student) {
      res.status(403).json({ error: 'Not authorized to view this student' });
      return;
    }

    // Fetch tracking data for this student (for HW and Quizzes)
    const trackings = await prisma.tracking.findMany({
      where: { studentId }
    });

    let hwSubmittedCount = 0;
    let totalQuizScore = 0;
    let quizCount = 0;

    trackings.forEach(t => {
      if (t.hwStatus !== 'NOT_SUBMITTED') hwSubmittedCount++;
      if (t.quizScore !== null) {
        totalQuizScore += t.quizScore;
        quizCount++;
      }
    });

    const physicalAttendanceCount = await prisma.attendanceRecord.count({
      where: { studentId }
    });

    const averageQuizScore = quizCount > 0 ? Math.round(totalQuizScore / quizCount) : 0;

    let overallEvaluation = 'يحتاج متابعة';
    if (averageQuizScore >= 90) {
      overallEvaluation = 'ممتاز';
    } else if (averageQuizScore >= 75) {
      overallEvaluation = 'جيد جداً';
    } else if (averageQuizScore >= 60) {
      overallEvaluation = 'جيد';
    }

    const lastTracking = await prisma.tracking.findFirst({
      where: { studentId },
      orderBy: { updatedAt: 'desc' },
      include: { lesson: { select: { title: true } } }
    });
    const lastActivity = lastTracking?.lesson ? `شاهد درس: ${lastTracking.lesson.title}` : 'لا يوجد نشاط مسجل';

    const activeEnrollments = await prisma.courseEnrollment.findMany({
      where: { studentId, status: 'APPROVED' },
      include: {
        course: {
          include: {
            lessons: true
          }
        }
      }
    });

    const eligiblePairs = activeEnrollments
      .map(({ course }) => ({ subject: course.subject, grade: course.grade }))
      .filter((pair): pair is { subject: string; grade: string } =>
        Boolean(pair.subject && pair.grade));

    const eligibleSessions = eligiblePairs.length === 0
      ? 0
      : await prisma.attendanceSession.count({
          where: { OR: eligiblePairs },
        });
    const attendedEligibleSessions = eligiblePairs.length === 0
      ? 0
      : await prisma.attendanceRecord.count({
          where: {
            studentId,
            session: { OR: eligiblePairs },
          },
        });

    // Physical attendance is deliberately independent from video completion.
    const attendanceRate = eligibleSessions > 0
      ? Math.round((attendedEligibleSessions / eligibleSessions) * 100)
      : 0;
    const activeCourses = activeEnrollments.length;

    res.json({
      attendanceRate,
      physicalAttendanceCount,
      homeworkSubmitted: hwSubmittedCount,
      averageQuizScore,
      overallEvaluation,
      lastActivity,
      activeCourses
    });
  } catch (error) {
    logger.error('getChildStats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
