import { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { isBlacklisted } from '../controllers/logout.controller';
import { logger } from '../utils/logger';
import { env } from '../utils/env';

const prisma = new PrismaClient();

export interface AuthUser {
  id: string;
  phone: string;
  role: string;
  isApproved: boolean;
  status: string;
  parentTeacherId: string | null;
  sessionId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export type AuthRequest = Request;

export const authMiddleware: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.status(401).json({ error: 'No authorization header' });
      return;
    }

    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Invalid authorization format' });
      return;
    }

    // Bulletproof token extraction:
    //  1. Take everything after the first space (handles "Bearer <token>")
    //  2. Strip any accidental single/double quotes (JSON-encoded tokens)
    //  3. Guard against a doubly-prefixed "Bearer Bearer <token>" header
    let rawToken = authHeader.split(' ')[1] ?? '';
    // If "Bearer " was accidentally embedded inside the token value itself
    if (rawToken.toLowerCase().startsWith('bearer ')) {
      rawToken = rawToken.substring(7);
    }
    const token = rawToken.replace(/['"]+/g, '').trim();

    if (!token) {
      res.status(401).json({ error: 'Token is empty' });
      return;
    }

    // Check if token is blacklisted
    if (isBlacklisted(token)) {
      res.status(401).json({ error: 'Token has been revoked. Please login again.' });
      return;
    }

    // Dev-only trace: never reaches production logs (logger.debug is a no-op when NODE_ENV=production)
    logger.debug('Verifying authentication token');

    let decoded: jwt.JwtPayload;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
      logger.debug('Authentication token verified for role:', decoded.role);
    } catch (jwtError) {
      const errorMessage = jwtError instanceof Error ? jwtError.message : String(jwtError);
      logger.debug('Token verification failed:', errorMessage);
      if (jwtError instanceof jwt.TokenExpiredError) {
        res.status(401).json({ error: 'Token expired' });
        return;
      }
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    if (!decoded.id || !decoded.phone || !decoded.role) {
      res.status(401).json({ error: 'Invalid token payload' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        name: true,
        phone: true,
        role: true,
        status: true,
        isApproved: true,
        parentTeacherId: true,
        sessionVersion: true,
      },
    });

    if (!user) {
      res.status(401).json({ error: 'User no longer exists' });
      return;
    }

    if (user.status === 'deleted' || user.status === 'deletion_processing') {
      res.status(401).json({ error: 'Account is no longer active.' });
      return;
    }

    if (!Number.isInteger(decoded.sv) || decoded.sv !== user.sessionVersion) {
      res.status(401).json({ error: 'Session has been revoked. Please login again.' });
      return;
    }

    let sessionId: string | null = null;
    if (decoded.sid !== undefined) {
      if (typeof decoded.sid !== 'string' || !decoded.sid) {
        res.status(401).json({ error: 'Invalid session identifier' });
        return;
      }
      const session = await prisma.userSession.findFirst({
        where: {
          id: decoded.sid,
          userId: user.id,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (!session) {
        res.status(401).json({ error: 'Session has expired or been revoked.' });
        return;
      }
      sessionId = session.id;
      if (session.lastSeenAt.getTime() < Date.now() - 5 * 60 * 1000) {
        await prisma.userSession.update({
          where: { id: session.id },
          data: { lastSeenAt: new Date() },
        });
      }
    }

    req.user = {
      id: user.id,
      phone: user.phone,
      role: user.role,
      status: user.status,
      isApproved: user.isApproved,
      parentTeacherId: user.parentTeacherId,
      sessionId,
    };

    next();
  } catch (error) {
    logger.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
};

export const optionalAuthMiddleware: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      next();
      return;
    }

    let rawOptToken = authHeader.split(' ')[1] ?? '';
    if (rawOptToken.toLowerCase().startsWith('bearer ')) {
      rawOptToken = rawOptToken.substring(7);
    }
    const token = rawOptToken.replace(/['"]+/g, '').trim();

    if (!token || token.trim() === '') {
      next();
      return;
    }

    // Check if token is blacklisted
    if (isBlacklisted(token)) {
      next();
      return;
    }

    let decoded: jwt.JwtPayload;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
    } catch {
      next();
      return;
    }

    if (!decoded.id) {
      next();
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        phone: true,
        role: true,
        status: true,
        isApproved: true,
        parentTeacherId: true,
        sessionVersion: true,
      },
    });

    if (user && user.isApproved && user.status !== 'deleted' &&
        user.status !== 'deletion_processing' && Number.isInteger(decoded.sv) &&
        decoded.sv === user.sessionVersion) {
      let sessionId: string | null = null;
      if (decoded.sid !== undefined) {
        if (typeof decoded.sid !== 'string' || !decoded.sid) {
          next();
          return;
        }
        const session = await prisma.userSession.findFirst({
          where: {
            id: decoded.sid,
            userId: user.id,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        });
        if (!session) {
          next();
          return;
        }
        sessionId = session.id;
      }
      req.user = {
        id: user.id,
        phone: user.phone,
        role: user.role,
        status: user.status,
        isApproved: user.isApproved,
        parentTeacherId: user.parentTeacherId,
        sessionId,
      };
    }

    next();
  } catch (error) {
    next();
  }
};

// Middleware specifically built for Teacher Approval Workflow
export const isApprovedUser: RequestHandler = (req, res, next) => {
  if (req.user && (!req.user.isApproved || req.user.status?.toLowerCase() !== 'approved')) {
    res.status(403).json({ error: 'Account pending approval' });
    return;
  }
  next();
};
