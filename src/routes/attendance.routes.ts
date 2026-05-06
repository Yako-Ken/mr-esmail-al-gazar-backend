import { Router, Request, Response, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthUser } from '../middlewares/auth.middleware';

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
    console.error('Create session error:', error);
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
    console.error('Get sessions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const markAttendance: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const ownerId = getOwnerId(authUser);
    const { sessionId, studentId } = req.body as { sessionId?: string; studentId?: string };

    if (!sessionId || !studentId) {
      res.status(400).json({ error: 'Session ID and student ID are required' });
      return;
    }

    const session = await prisma.attendanceSession.findUnique({
      where: { id: sessionId },
    });

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
      where: {
        sessionId_studentId: {
          sessionId,
          studentId,
        },
      },
    });

    if (existingRecord) {
      res.json({ 
        message: 'Attendance already marked',
        student: { id: student.id, name: student.name },
      });
      return;
    }

    const record = await prisma.attendanceRecord.create({
      data: {
        sessionId,
        studentId,
      },
    });

    res.status(201).json({ 
      message: 'Attendance marked successfully',
      student: { id: student.id, name: student.name },
    });
  } catch (error) {
    console.error('Mark attendance error:', error);
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
    console.error('Get session details error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const router = Router();

router.post('/sessions', authMiddleware, createSession);
router.get('/sessions', authMiddleware, getSessions);
router.get('/sessions/:sessionId', authMiddleware, getSessionDetails);
router.post('/mark', authMiddleware, markAttendance);

export default router;