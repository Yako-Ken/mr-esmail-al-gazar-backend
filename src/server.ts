import dotenv from 'dotenv';
dotenv.config();

import { env } from './utils/env'; // validates process.env and exits early if misconfigured
import { logger } from './utils/logger';
import { seedSuperAdmin } from './utils/seedAdmin';
import { initSocket } from './socket';
import cron from 'node-cron';
import { cleanupOrphanedFiles } from './utils/cleanup';

import express, { Router } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import cors from 'cors';
import authRoutes from './routes/auth.routes';
import adminRoutes from './routes/admin.routes';
import studentRoutes from './routes/student.routes';
import storeRoutes from './routes/store.routes';
import lessonRoutes from './routes/lesson.routes';
import uploadRoutes from './routes/upload.routes';
import trackingRoutes from './routes/tracking.routes';
import courseRoutes from './routes/course.routes';
import teacherRoutes from './routes/teacher.routes';
import attendanceRoutes from './routes/attendance.routes';
import parentRoutes from './routes/parent.routes';
import progressRoutes from './routes/progress.routes';
import whatsappRoutes from './routes/whatsapp.routes';
import { getSubjects } from './controllers/admin.controller';

const app = express();

const PORT: number = parseInt(env.PORT, 10);
const NODE_ENV: string = env.NODE_ENV;

// ============================================================
// MIDDLEWARE ORDER: CORS FIRST, THEN BODY PARSERS, THEN STATIC
// ============================================================

// 1. CORS MUST BE THE VERY FIRST MIDDLEWARE
// ALLOWED_ORIGINS is a comma-separated allowlist (e.g. "https://app.example.com,https://admin.example.com").
// Requests with no Origin header (native mobile apps, curl, server-to-server) are always allowed.
const allowedOrigins = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
if (allowedOrigins.includes('*')) {
  logger.warn('ALLOWED_ORIGINS is set to "*" - any origin can send credentialed requests. Set explicit domains in production.');
}
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
}));

// 2. BODY PARSERS (before routes). File uploads go through multer (memory storage,
// see upload.routes.ts) with their own 500MB limit - this only covers plain JSON/form bodies.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 3. STATIC FILES - Serve uploads directory with proper CORS headers
const uploadsDir = path.join(process.cwd(), 'uploads');
app.use('/uploads', express.static(uploadsDir, {
  maxAge: '1d',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') res.setHeader('Content-Type', 'image/jpeg');
    else if (ext === '.png') res.setHeader('Content-Type', 'image/png');
    else if (ext === '.pdf') res.setHeader('Content-Type', 'application/pdf');
    // Add CORS headers for static files
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  },
}));

// Check if uploads directory exists
if (fs.existsSync(uploadsDir)) {
  logger.info('✅ Uploads directory found at:', uploadsDir);
  const files = fs.readdirSync(uploadsDir);
  if (files.length > 0) {
    logger.info('✅ Files in uploads:', files.slice(0, 5).join(', ') + (files.length > 5 ? '...' : ''));
  } else {
    logger.info('📁 Uploads directory is empty');
  }
} else {
  logger.info('⚠️ WARNING: Uploads directory not found at:', uploadsDir);
  // Create it
  try {
    fs.mkdirSync(uploadsDir, { recursive: true });
    logger.info('✅ Created uploads directory at:', uploadsDir);
  } catch (e) {
    logger.error('❌ Failed to create uploads directory:', e);
  }
}

// Preflight OPTIONS requests are already handled by the cors() middleware above with the
// same allowlist - a duplicate wildcard handler here previously conflicted with credentials:true.

// ============================================================
// API ROUTES
// ============================================================
app.use('/api/auth', authRoutes);
app.use('/api/auth', whatsappRoutes); // WhatsApp OTP routes
app.use('/api/admin/users', adminRoutes);

// Subjects route (no auth required for Flutter app)
const subjectRoutes = Router();
subjectRoutes.get('/', getSubjects);
app.use('/api/subjects', subjectRoutes);

app.use('/api/parents', parentRoutes);

app.use('/api/student', studentRoutes);
app.use('/api/store', storeRoutes);
app.use('/api/lessons', lessonRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/lessons/upload', uploadRoutes);
app.use('/api/trackings', trackingRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/teachers', teacherRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/progress', progressRoutes);

// Quiz routes (for pending essays)
app.use('/api/quiz', trackingRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', environment: NODE_ENV });
});

// Schedule daily cleanup at 3:00 AM
cron.schedule('0 3 * * *', async () => {
  logger.info('⏰ Running scheduled daily orphaned files cleanup...');
  try {
    await cleanupOrphanedFiles();
  } catch (error) {
    logger.error('Daily cleanup failed:', error);
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler. Every failure gets a request id so a user-reported error can be
// correlated to the matching server log line without leaking internals in the response.
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  const requestId = crypto.randomUUID();
  logger.error(`[${requestId}] ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Internal server error', requestId });
});

const server = app.listen(PORT, '0.0.0.0', async () => {
  logger.info(`🚀 Server running on http://0.0.0.0:${PORT}`);
  logger.info(`📚 API: http://localhost:${PORT}/api`);
  logger.info(`📁 Static files: http://localhost:${PORT}/uploads`);
  
  await seedSuperAdmin();
});

initSocket(server);

server.timeout = 300000;
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;

export default app;