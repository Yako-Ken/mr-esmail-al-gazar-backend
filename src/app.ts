import { env } from './utils/env'; // validates process.env and exits early if misconfigured
import { logger } from './utils/logger';

import express, { Router } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import cors from 'cors';
import helmet from 'helmet';
import authRoutes from './routes/auth.routes';
import adminRoutes from './routes/admin.routes';
import adminOperationsRoutes from './routes/adminOperations.routes';
import studentRoutes from './routes/student.routes';
import storeRoutes from './routes/store.routes';
import paymentRoutes from './routes/payment.routes';
import lessonRoutes from './routes/lesson.routes';
import uploadRoutes from './routes/upload.routes';
import trackingRoutes from './routes/tracking.routes';
import courseRoutes from './routes/course.routes';
import teacherRoutes from './routes/teacher.routes';
import attendanceRoutes from './routes/attendance.routes';
import parentRoutes from './routes/parent.routes';
import progressRoutes from './routes/progress.routes';
import analyticsRoutes from './routes/analytics.routes';
import notificationRoutes from './routes/notification.routes';
import webRoutes from './routes/web.routes';
import whatsappRoutes from './routes/whatsapp.routes';
import { getSubjects } from './controllers/admin.controller';

const app = express();

const NODE_ENV: string = env.NODE_ENV;

// ============================================================
// MIDDLEWARE ORDER: HELMET, CORS, BODY PARSERS, STATIC
// ============================================================

// 0. SECURITY HEADERS — crossOriginResourcePolicy "cross-origin" so the
// mobile app and webviews can still load /uploads assets off this origin.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false, // landing page uses inline styles/scripts
}));
// 1. CORS MUST BE THE VERY FIRST MIDDLEWARE
// ALLOWED_ORIGINS is a comma-separated allowlist (e.g. "https://app.example.com,https://admin.example.com").
// Requests with no Origin header (native mobile apps, curl, server-to-server) are always allowed.
const allowedOrigins = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
if (allowedOrigins.includes('*')) {
  if (NODE_ENV === 'production') {
    throw new Error('ALLOWED_ORIGINS cannot contain "*" in production. Configure explicit app origins.');
  }
  logger.warn('ALLOWED_ORIGINS is set to "*" - allowed only for local development.');
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
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-Device-Name',
    'Accept',
    'Origin',
  ],
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

if (!fs.existsSync(uploadsDir)) {
  logger.info('⚠️ Uploads directory not found, creating:', uploadsDir);
  try {
    fs.mkdirSync(uploadsDir, { recursive: true });
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
app.use('/api/admin', adminOperationsRoutes);

// Subjects route (no auth required for Flutter app)
const subjectRoutes = Router();
subjectRoutes.get('/', getSubjects);
app.use('/api/subjects', subjectRoutes);

app.use('/api/parents', parentRoutes);

app.use('/api/student', studentRoutes);
app.use('/api/store', storeRoutes);
app.use('/api/store', paymentRoutes);
app.use('/api/lessons', lessonRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/lessons/upload', uploadRoutes);
app.use('/api/trackings', trackingRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/teachers', teacherRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/notifications', notificationRoutes);

// Static public files (privacy policy, terms, landing page assets)
app.use('/public', express.static(path.join(process.cwd(), 'public')));

// Web routes: landing, privacy, terms — must be before /api catch-all
app.use('/', webRoutes);

// Quiz routes (for pending essays)
app.use('/api/quiz', trackingRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', environment: NODE_ENV });
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

export default app;
