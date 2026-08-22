import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { logger } from './utils/logger';
import { env } from './utils/env';

let io: Server | null = null;

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
  io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  // ── JWT auth middleware: identify the user BEFORE any event is handled ──
  io.use((socket, next) => {
    const token = cleanToken(socket.handshake.auth?.token);
    if (!token) {
      // Allow anonymous connections (they just won't receive user pushes),
      // but log so we can spot misconfigured clients.
      logger.warn(`🔌 [Socket.IO] Connection without token: ${socket.id}`);
      return next();
    }
    try {
      const decoded = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
      if (decoded.id) {
        (socket as Socket & { userId?: string }).userId = decoded.id;
        (socket as Socket & { userRole?: string }).userRole = decoded.role;
      }
      next();
    } catch {
      logger.warn(`🔌 [Socket.IO] Invalid token from ${socket.id}`);
      next(); // still connect, but unauthenticated → no personal room
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

export const getIO = () => {
  if (!io) {
    logger.warn('Socket.io not initialized yet!');
  }
  return io;
};
