import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthUser } from '../middlewares/auth.middleware';
import { logger } from '../utils/logger';

import prisma from '../config/prisma';

type AuthenticatedRequest = Request & { user?: AuthUser };

const requireUser = (req: AuthenticatedRequest, res: Response): AuthUser | null => {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return req.user;
};

export const listSessions = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    const now = new Date();
    const sessions = await prisma.userSession.findMany({
      where: { userId: user.id, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        deviceName: true,
        ipHint: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
      },
    });

    res.json({
      sessions: sessions.map((session) => ({
        ...session,
        current: session.id === user.sessionId,
      })),
      legacyCurrentSession: user.sessionId === null,
    });
  } catch (error) {
    logger.error('listSessions error:', error);
    res.status(500).json({ error: 'Unable to load active sessions' });
  }
};

export const revokeSession = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    const sessionId = req.params.sessionId;
    if (!sessionId) {
      res.status(400).json({ error: 'Session id is required' });
      return;
    }
    if (sessionId === user.sessionId) {
      res.status(409).json({
        error: 'Use logout to end the current session',
        code: 'CURRENT_SESSION_REQUIRES_LOGOUT',
      });
      return;
    }

    const result = await prisma.userSession.updateMany({
      where: { id: sessionId, userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Active session not found' });
      return;
    }
    res.json({ message: 'Session revoked' });
  } catch (error) {
    logger.error('revokeSession error:', error);
    res.status(500).json({ error: 'Unable to revoke session' });
  }
};

export const revokeOtherSessions = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    const result = await prisma.userSession.updateMany({
      where: {
        userId: user.id,
        revokedAt: null,
        ...(user.sessionId ? { id: { not: user.sessionId } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    res.json({ message: 'Other sessions revoked', revokedCount: result.count });
  } catch (error) {
    logger.error('revokeOtherSessions error:', error);
    res.status(500).json({ error: 'Unable to revoke other sessions' });
  }
};
