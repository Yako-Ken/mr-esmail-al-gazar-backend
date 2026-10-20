import { Router } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { AnalyticsService } from '../services/analytics.service';
import { authMiddleware, optionalAuthMiddleware } from '../middlewares/auth.middleware';
import { roleMiddleware } from '../middlewares/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

import prisma from '../config/prisma';

const trackEventSchema = z.object({
  eventType: z.enum([
    'login',
    'register',
    'course_view',
    'course_enroll',
    'lesson_view',
    'video_play',
    'video_complete',
    'quiz_start',
    'quiz_submit',
    'payment_intent',
    'payment_complete',
    'share_course',
    'onboarding_complete',
  ]),
  metadata: z.record(z.unknown()).optional(),
});

// Optional auth — anonymous events are allowed, while signed-in events retain
// their user id for meaningful funnel analysis.
router.post(
  '/track',
  optionalAuthMiddleware,
  asyncHandler(async (req, res) => {
    const parsed = trackEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid event', details: parsed.error.flatten() });
    }
    const userId = (req as any).user?.id ?? null;
    await AnalyticsService.track(parsed.data.eventType, userId, parsed.data.metadata);
    return res.status(204).send();
  }),
);

// Admin-only funnel stats
router.get(
  '/funnel',
  authMiddleware,
  roleMiddleware('SUPER_ADMIN'),
  asyncHandler(async (_req, res) => {
    const stats = await AnalyticsService.getFunnelStats(7);
    return res.json({ stats });
  }),
);

// Per-student physical attendance.
//
// This reads AttendanceRecord, the single record written by the QR flow. The
// previous read path used Tracking.isPresent, a parallel flag that unrelated
// writes could set, which meant a student scanned in by the teacher could still
// be reported absent. Attendance that cannot be observed is never inferred.
router.get(
  '/attendance/students/:studentId',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const authUser = (req as any).user;
    const { studentId } = req.params;

    if (!authUser) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (authUser.role === 'STUDENT' && authUser.id !== studentId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: { id: true, name: true, phone: true, role: true },
    });

    if (!student || student.role !== 'STUDENT') {
      return res.status(404).json({ error: 'Student not found' });
    }

    if (authUser.role === 'PARENT') {
      const owns = await prisma.studentParentRelation.findFirst({
        where: { parentId: authUser.id, studentId },
        select: { id: true },
      });
      if (!owns) {
        return res.status(403).json({ error: 'Not authorized to view this student' });
      }
    } else if (!['ADMIN', 'SUPER_ADMIN', 'TEACHER', 'STAFF'].includes(authUser.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const records = await prisma.attendanceRecord.findMany({
      where: { studentId },
      select: {
        id: true,
        sessionId: true,
        timestamp: true,
        session: {
          select: { id: true, subject: true, grade: true, date: true },
        },
      },
      orderBy: { timestamp: 'desc' },
    });

    const sessionCount = new Set(records.map((r) => r.sessionId)).size;
    const presentCount = records.length;

    return res.json({
      student,
      presentCount,
      sessionCount,
      attendanceRate: sessionCount > 0 ? Math.round((presentCount / sessionCount) * 100) : 0,
      sessions: records.map((r) => ({
        recordId: r.id,
        sessionId: r.sessionId,
        subject: r.session.subject,
        grade: r.session.grade,
        date: r.session.date,
        markedAt: r.timestamp,
      })),
    });
  }),
);

export default router;
