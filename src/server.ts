import dotenv from 'dotenv';
dotenv.config();

import { seedSuperAdmin } from './utils/seedAdmin';
import { initSocket } from './socket';
import cron from 'node-cron';
import { cleanupOrphanedFiles } from './utils/cleanup';

import express, { Router } from 'express';
import path from 'path';
import fs from 'fs';
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

const PORT: number = parseInt(process.env.PORT || '5000', 10);
const NODE_ENV: string = process.env.NODE_ENV || 'development';

// ============================================================
// MIDDLEWARE ORDER: CORS FIRST, THEN BODY PARSERS, THEN STATIC
// ============================================================

// 1. CORS MUST BE THE VERY FIRST MIDDLEWARE
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
}));

// 2. BODY PARSERS (before routes) - increased for large file uploads
app.use(express.json({ limit: '2gb' }));
app.use(express.urlencoded({ extended: true, limit: '2gb' }));

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
  console.log('✅ Uploads directory found at:', uploadsDir);
  const files = fs.readdirSync(uploadsDir);
  if (files.length > 0) {
    console.log('✅ Files in uploads:', files.slice(0, 5).join(', ') + (files.length > 5 ? '...' : ''));
  } else {
    console.log('📁 Uploads directory is empty');
  }
} else {
  console.log('⚠️ WARNING: Uploads directory not found at:', uploadsDir);
  // Create it
  try {
    fs.mkdirSync(uploadsDir, { recursive: true });
    console.log('✅ Created uploads directory at:', uploadsDir);
  } catch (e) {
    console.error('❌ Failed to create uploads directory:', e);
  }
}

// Handle preflight OPTIONS
app.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(200).end();
});

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
  console.log('⏰ Running scheduled daily orphaned files cleanup...');
  try {
    await cleanupOrphanedFiles();
  } catch (error) {
    console.error('Daily cleanup failed:', error);
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
  console.log(`📚 API: http://localhost:${PORT}/api`);
  console.log(`📁 Static files: http://localhost:${PORT}/uploads`);
  
  await seedSuperAdmin();
});

initSocket(server);

server.timeout = 300000;
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;

export default app;