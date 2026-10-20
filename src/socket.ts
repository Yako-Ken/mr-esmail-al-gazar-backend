import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { logger } from './utils/logger';
import { env } from './utils/env';

let io: Server | null = null;
import prisma from './config/prisma';

/**
 * Extract a clean JWT from a raw string that may carry accidental
 * "Bearer " prefixes or surrounding quotes (mirrors auth.middleware).
 */
const cleanToken = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let token = raw.trim();
  if (token.toLowerCase().startsWith('bearer ')) {
    token = token.substring(7);
  }
  token = token.replace(/['"]+/g, '').trim();
  return token || null;
};

export const initSocket = (server: HttpServer) => {
  const allowedOrigins = env.ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  io = new Server(server, {
    cors: {
      origin: allowedOrigins.includes('*') ? true : allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // ── JWT auth middleware: identify the user BEFORE any event is handled ──
  io.use(async (socket, next) => {
    const token = cleanToken(socket.handshake.auth?.token);
    if (!token) {
      // Anonymous sockets are allowed but never join personal or role rooms.
      logger.warn(`🔌 [Socket.IO] Connection without token: ${socket.id}`);
      return next();
    }
    try {
      const decoded = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
      if (!decoded.id || !Number.isInteger(decoded.sv)) {
        return next(new Error('Unauthorized socket'));
      }
      const user = await prisma.user.findUnique({
        where: { id: String(decoded.id) },
        select: { id: true, role: true, status: true, sessionVersion: true },
      });
      if (!user || user.status === 'deleted' || user.status === 'deletion_processing' ||
          decoded.sv !== user.sessionVersion) {
        return next(new Error('Unauthorized socket'));
      }
      if (decoded.sid !== undefined) {
        if (typeof decoded.sid !== 'string' || !decoded.sid) {
          return next(new Error('Unauthorized socket'));
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
        if (!session) return next(new Error('Unauthorized socket'));
      }
      (socket as Socket & { userId?: string }).userId = user.id;
      (socket as Socket & { userRole?: string }).userRole = user.role;
      next();
    } catch {
      logger.warn(`🔌 [Socket.IO] Invalid or revoked token from ${socket.id}`);
      next(new Error('Unauthorized socket'));
    }
  });

  io.on('connection', (socket) => {
    const userId = (socket as Socket & { userId?: string }).userId;
    const userRole = (socket as Socket & { userRole?: string }).userRole;

    if (userId) {
      // Join the personal room so NotificationService.sendToUser can reach us
      socket.join(`user_${userId}`);
      logger.info(`🔌 [Socket.IO] ${socket.id} joined user_${userId} (role=${userRole})`);

      // Role-based rooms (admins/teachers get broadcast channels)
      if (userRole) {
        socket.join(`role_${userRole.toLowerCase()}`);
      }
    } else {
      logger.info(`🔌 [Socket.IO] Anonymous client connected: ${socket.id}`);
    }

    // Admins can join an 'admins' room to receive privileged notifications
    socket.on('joinAdminRoom', () => {
      if (userRole === 'ADMIN' || userRole === 'SUPER_ADMIN') {
        socket.join('admins');
        logger.info(`🔌 [Socket.IO] Client ${socket.id} joined 'admins' room`);
      } else {
        logger.warn(`🔌 [Socket.IO] Non-admin ${socket.id} tried to join admins room`);
      }
    });

    socket.on('disconnect', () => {
      logger.info(`🔌 [Socket.IO] Client disconnected: ${socket.id}`);
    });
  });

  return io;
};

export const disconnectUserSockets = (userId: string): void => {
  io?.in(`user_${userId}`).disconnectSockets(true);
};

export const getIO = () => {
  if (!io) {
    logger.warn('Socket.io not initialized yet!');
  }
  return io;
};
