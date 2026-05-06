import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';

let io: Server | null = null;

export const initSocket = (server: HttpServer) => {
  io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', (socket) => {
    console.log(`🔌 [Socket.IO] New client connected: ${socket.id}`);
    
    // Admins can join an 'admins' room to receive privileged notifications
    socket.on('joinAdminRoom', () => {
      socket.join('admins');
      console.log(`🔌 [Socket.IO] Client ${socket.id} joined 'admins' room`);
    });

    socket.on('disconnect', () => {
      console.log(`🔌 [Socket.IO] Client disconnected: ${socket.id}`);
    });
  });

  return io;
};

export const getIO = () => {
  if (!io) {
    console.warn('Socket.io not initialized yet!');
  }
  return io;
};
