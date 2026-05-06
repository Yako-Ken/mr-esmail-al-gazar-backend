import { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { isBlacklisted } from '../controllers/logout.controller';

const prisma = new PrismaClient();

export interface AuthUser {
  id: string;
  phone: string;
  role: string;
  isApproved: boolean;
  status: string;
  parentTeacherId: string | null;
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

    // DEBUG: Log first 20 chars so malformed / quoted tokens are immediately visible
    console.log('DEBUG: Verifying token ->', token.substring(0, 20) + '...');

    let decoded: jwt.JwtPayload;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET!) as jwt.JwtPayload;
      console.log('🔑 Token verified successfully for user:', decoded.phone, 'role:', decoded.role);
    } catch (jwtError) {
      const errorMessage = jwtError instanceof Error ? jwtError.message : String(jwtError);
      console.log('❌ Token verification failed:', errorMessage);
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
      },
    });

    if (!user) {
      res.status(401).json({ error: 'User no longer exists' });
      return;
    }

    req.user = {
      id: user.id,
      phone: user.phone,
      role: user.role,
      status: user.status,
      isApproved: user.isApproved,
      parentTeacherId: user.parentTeacherId,
    };

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
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
      decoded = jwt.verify(token, process.env.JWT_SECRET!) as jwt.JwtPayload;
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
      },
    });

    if (user && user.isApproved) {
      req.user = {
        id: user.id,
        phone: user.phone,
        role: user.role,
        status: user.status,
        isApproved: user.isApproved,
        parentTeacherId: user.parentTeacherId,
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
