import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { logger } from './utils/logger';

let io: Server | null = null;

export const initSocket = (server: HttpServer) => {
  io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', (socket) => {
    logger.info(`🔌 [Socket.IO] New client connected: ${socket.id}`);
    
    // Admins can join an 'admins' room to receive privileged notifications
    socket.on('joinAdminRoom', () => {
      socket.join('admins');
      logger.info(`🔌 [Socket.IO] Client ${socket.id} joined 'admins' room`);
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
