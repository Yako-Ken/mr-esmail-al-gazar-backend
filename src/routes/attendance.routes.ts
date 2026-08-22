import { Router, Request, Response, RequestHandler } from 'express';
import { Prisma, PrismaClient } from '@prisma/client';
import { authMiddleware, AuthUser } from '../middlewares/auth.middleware';
import { logger } from '../utils/logger';
import { env } from '../utils/env';
import { createAttendanceQrToken, verifyAttendanceQrToken } from '../utils/attendanceQr';

const prisma = new PrismaClient();

const getOwnerId = (authUser: AuthUser): string => {
  return authUser.role === 'ASSISTANT' && authUser.parentTeacherId 
    ? authUser.parentTeacherId 
    : authUser.id;
};

export const createSession: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const ownerId = getOwnerId(authUser);
    const { subject, grade, date } = req.body as { subject?: string; grade?: string; date?: string };

    if (!subject || !grade) {
      res.status(400).json({ error: 'Subject and grade are required' });
      return;
    }

    let sessionDate = new Date();
    if (date) {
      sessionDate = new Date(date);
    }

    const existingSession = await prisma.attendanceSession.findFirst({
      where: {
        ownerId,
        subject,
        grade,
        date: {
          gte: new Date(sessionDate.setHours(0, 0, 0, 0)),
          lt: new Date(sessionDate.setHours(23, 59, 59, 999)),
        },
      },
    });

    if (existingSession) {
      res.json({ session: existingSession });
      return;
    }

    const session = await prisma.attendanceSession.create({
      data: {
        subject,
        grade,
        date: sessionDate,
        ownerId,
      },
    });

    res.status(201).json({ session });
  } catch (error) {
    logger.error('Create session error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getSessions: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const ownerId = getOwnerId(authUser);

    const sessions = await prisma.attendanceSession.findMany({
      where: { ownerId },
      orderBy: { date: 'desc' },
      include: {
        _count: { select: { records: true } },
      },
      take: 50,
    });

    const result = sessions.map((s) => ({
      id: s.id,
      subject: s.subject,
      grade: s.grade,
      date: s.date,
      studentCount: s._count.records,
    }));

    res.json(result);
  } catch (error) {
    logger.error('Get sessions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const createStudentQrToken: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser || authUser.role !== 'STUDENT') {
      res.status(403).json({ error: 'Only students can create an attendance QR token.' });
      return;
    }

    // Opportunistic cleanup keeps the one-time-use ledger bounded.
    await prisma.attendanceQrUse.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const result = createAttendanceQrToken(authUser.id, env.JWT_SECRET);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ token: result.token, expiresAt: result.expiresAt, expiresIn: result.expiresIn });
  } catch (error) {
    logger.error('Create attendance QR error:', error);
    res.status(500).json({ error: 'Could not create attendance QR.' });
  }
};

export const markAttendance: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser || !['TEACHER', 'ASSISTANT', 'SUPER_ADMIN'].includes(authUser.role)) {
      res.status(403).json({ error: 'Only authorized staff can mark attendance.' });
      return;
    }

    const ownerId = getOwnerId(authUser);
    const { sessionId, qrToken } = req.body as { sessionId?: string; qrToken?: string };
    if (!sessionId || !qrToken) {
      res.status(400).json({ error: 'Session ID and signed QR token are required.' });
      return;
    }

    let payload;
    try {
      payload = verifyAttendanceQrToken(qrToken, env.JWT_SECRET);
    } catch {
      res.status(400).json({ error: 'The QR code is invalid or expired.' });
      return;
    }
    const studentId = payload.sub;

    const session = await prisma.attendanceSession.findUnique({ where: { id: sessionId } });
    if (!session || session.ownerId !== ownerId) {
      res.status(404).json({ error: 'Session not found or unauthorized' });
      return;
    }

    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: { id: true, name: true, role: true },
    });
    if (!student || student.role !== 'STUDENT') {
      res.status(404).json({ error: 'Student not found' });
      return;
    }

    const existingRecord = await prisma.attendanceRecord.findUnique({
      where: { sessionId_studentId: { sessionId, studentId } },
    });
    if (existingRecord) {
      res.json({
        message: 'Attendance already marked',
        student: { id: student.id, name: student.name },
      });
      return;
    }

    try {
      await prisma.$transaction([
        prisma.attendanceQrUse.create({
          data: {
            jti: payload.jti,
            studentId,
            sessionId,
            expiresAt: new Date(payload.exp * 1000),
          },
        }),
        prisma.attendanceRecord.create({ data: { sessionId, studentId } }),
      ]);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        res.status(409).json({ error: 'This QR code has already been used.' });
        return;
      }
      throw error;
    }

    res.status(201).json({
      message: 'Attendance marked successfully',
      student: { id: student.id, name: student.name },
    });
  } catch (error) {
    logger.error('Mark attendance error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getSessionDetails: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const ownerId = getOwnerId(authUser);
    const { sessionId } = req.params;

    const session = await prisma.attendanceSession.findUnique({
      where: { id: sessionId },
    });

    if (!session || session.ownerId !== ownerId) {
      res.status(404).json({ error: 'Session not found or unauthorized' });
      return;
    }

    const records = await prisma.attendanceRecord.findMany({
      where: { sessionId },
      include: {
        student: { select: { id: true, name: true, phone: true } },
      },
    });

    res.json({
      session: {
        id: session.id,
        subject: session.subject,
        grade: session.grade,
        date: session.date,
      },
      students: records.map((r) => ({
        id: r.student.id,
        name: r.student.name,
        phone: r.student.phone,
        timestamp: r.timestamp,
      })),
    });
  } catch (error) {
    logger.error('Get session details error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const router = Router();

router.post('/sessions', authMiddleware, createSession);
router.get('/sessions', authMiddleware, getSessions);
router.get('/sessions/:sessionId', authMiddleware, getSessionDetails);
router.get('/qr-token', authMiddleware, createStudentQrToken);
router.post('/mark', authMiddleware, markAttendance);

export default router;