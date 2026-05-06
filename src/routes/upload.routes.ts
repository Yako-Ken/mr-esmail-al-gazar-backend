import express, { Request, Response, RequestHandler } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthUser } from '../middlewares/auth.middleware';
import { checkTeacherApproval } from '../middlewares/role.middleware';

const router = express.Router();
const prisma = new PrismaClient();

interface AuthRequestWithFiles extends Request {
  user?: AuthUser;
  files?: Record<string, Express.Multer.File[]>;
}

// ─── Helper: delete all files multer saved to disk ───────────────────────────
// Called in the catch block to prevent orphaned files on any failure path.
function cleanupUploadedFiles(req: Request): void {
  const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
  if (!files) return;

  const allFiles = Object.values(files).flat();
  for (const file of allFiles) {
    if (file.path && fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path);
        console.log(`🗑️  Orphan file cleaned up: ${file.path}`);
      } catch (unlinkErr) {
        console.error(`⚠️  Failed to delete orphan file ${file.path}:`, unlinkErr);
      }
    }
  }
}

// ─── Upload handler ───────────────────────────────────────────────────────────
// By the time this runs, authMiddleware + checkTeacherApproval have already:
//   1. Verified the JWT
//   2. Done a real-time DB query confirming approval
//   3. Enriched req.user with fresh data
// So we trust req.user and do NOT re-query the DB for approval here.
export const uploadLesson: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authReq = req as AuthRequestWithFiles;
    const authUser = authReq.user;

    // This should never be null (authMiddleware already guards it) but keeps TS happy
    if (!authUser) {
      cleanupUploadedFiles(req);
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId 
      ? authUser.parentTeacherId 
      : authUser.id;

    const { subject, grade, title, homeworkText, description, quizData, courseId } = req.body;

    if (!subject || !grade || !title) {
      cleanupUploadedFiles(req);
      res.status(400).json({ error: 'Subject, grade, and title are required' });
      return;
    }

    // Subjects are now global K-12 constants — no ownership check needed.
    // The teacher is always linked via teacherId: authUser.id below.

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

    console.log('📁 Files received in backend:');
    console.log('   files:', files ? Object.keys(files) : 'none');

    if (!files || !files.video || !files.video[0]) {
      console.log('❌ No video file received!');
      res.status(400).json({ error: 'Video file is required.' });
      return;
    }

    // Use shared getRelativePath helper to include subdirectories in URL
    const videoUrl: string = getRelativePath(files.video[0]);
    const thumbnailUrl: string | undefined = files.thumbnail?.[0] ? getRelativePath(files.thumbnail[0]) : undefined;
    const homeworkPdfUrl: string | undefined = files.pdf?.[0] ? getRelativePath(files.pdf[0]) : undefined;

    console.log('Saved Video to DB:', videoUrl);
    if (thumbnailUrl) console.log('Saved Thumbnail to DB:', thumbnailUrl);
    if (homeworkPdfUrl) console.log('Saved Homework PDF to DB:', homeworkPdfUrl);

    let parsedQuestions: any = null;
    let timeLimit = 0;
    let quizTitle = '';
    
    if (quizData) {
      try {
        const parsedQuiz = typeof quizData === 'string' ? JSON.parse(quizData) : quizData;
        parsedQuestions = parsedQuiz.questions || parsedQuiz;
        quizTitle = parsedQuiz.title || '';
        if (!Array.isArray(parsedQuestions)) {
          throw new Error('Questions must be an array');
        }
        timeLimit = parsedQuiz.timeLimit ? parseInt(parsedQuiz.timeLimit, 10) : 0;
      } catch (parseError) {
        cleanupUploadedFiles(req);
        res.status(400).json({ error: 'Invalid Quiz Format. Please check your questions structure.' });
        return;
      }
    }

    // Persist lesson to DB with nested quiz creation
    const lesson = await prisma.lesson.create({
      data: {
        subject,
        grade,
        teacherId: ownerId,
        title,
        description: description || null,
        videoUrl,
        thumbnailUrl: thumbnailUrl ?? null,
        homeworkText: homeworkText || null,
        homeworkPdfUrl: homeworkPdfUrl ?? null,
        ...(courseId ? { courseId } : {}),
        ...(parsedQuestions && parsedQuestions.length > 0
          ? {
              quizzes: {
                create: {
                  questions: JSON.stringify({
                    title: quizTitle,
                    questions: parsedQuestions,
                    timeLimit: timeLimit,
                  }),
                },
              },
            }
          : {}),
      },
      include: {
        quizzes: true,
      }
    });

    // Return absolute URLs for client consumption
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const formatUrl = (url: string | null | undefined) => {
      if (!url) return url;
      if (url.startsWith('http')) return url;
      const normalized = url.replace(/\\/g, '/');
      return `${baseUrl}/uploads/${normalized}`;
    };

    res.status(201).json({
      message: 'Lesson uploaded successfully',
      lesson: {
        id: lesson.id,
        title: lesson.title,
        description: lesson.description,
        videoUrl: formatUrl(lesson.videoUrl),
        thumbnailUrl: formatUrl(lesson.thumbnailUrl),
        homeworkPdfUrl: formatUrl(lesson.homeworkPdfUrl),
        hasQuiz: !!(parsedQuestions && parsedQuestions.length > 0),
      },
    });
  } catch (error) {
    console.error('Upload lesson error:', error);

    // ── STEP 3: Orphan file cleanup on any unexpected failure ──────────────────
    // If prisma.lesson.create (or any other DB op) throws, files are already on
    // disk. We delete them here to prevent a storage leak.
    cleanupUploadedFiles(req);

    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({ error: 'File too large. Maximum size is 100MB.' });
        return;
      }
      res.status(400).json({ error: error.message });
      return;
    }

    res.status(500).json({ error: 'Failed to upload lesson' });
  }
};

// ─── Multer storage ───────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
const VIDEOS_DIR = path.join(UPLOADS_DIR, 'videos');
const PDFS_DIR = path.join(UPLOADS_DIR, 'pdfs');
const TEMP_DIR = path.join(UPLOADS_DIR, 'temp');
const COURSE_THUMBNAILS_DIR = path.join(UPLOADS_DIR, 'thumbnails', 'course-thumbnails');
const LESSON_THUMBNAILS_DIR = path.join(UPLOADS_DIR, 'thumbnails', 'lesson-thumbnails');

[UPLOADS_DIR, VIDEOS_DIR, PDFS_DIR, TEMP_DIR, COURSE_THUMBNAILS_DIR, LESSON_THUMBNAILS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Helper: Extract relative path from full file path (includes subdirectories)
const getRelativePath = (file: Express.Multer.File): string => {
  const relativePath = file.path.replace(UPLOADS_DIR, '').replace(/^[/\\]/, '');
  return relativePath;
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let destDir = UPLOADS_DIR;
    const fieldname = file.fieldname.toLowerCase();
    const originalUrl = req.originalUrl.toLowerCase();
    
    if (file.mimetype.startsWith('video/')) {
      destDir = VIDEOS_DIR;
    } else if (fieldname.includes('thumbnail') || fieldname.includes('image')) {
      // Route to lesson thumbnails by default (for lesson uploads)
      // Route to course thumbnails if URL indicates course context
      if (originalUrl.includes('/courses') || fieldname.includes('course')) {
        destDir = COURSE_THUMBNAILS_DIR;
      } else {
        destDir = LESSON_THUMBNAILS_DIR;
      }
    } else if (fieldname.includes('pdf') || file.mimetype === 'application/pdf') {
      destDir = PDFS_DIR;
    }
    
    cb(null, destDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    let ext = path.extname(file.originalname);
    if (!ext) {
      if (file.fieldname === 'video')     ext = '.mp4';
      else if (file.fieldname === 'thumbnail') ext = '.jpg';
      else if (file.fieldname === 'pdf')  ext = '.pdf';
    }
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100 MB max per file
    fieldSize: 100 * 1024 * 1024, // 100 MB for text fields
  },
});

// ─── Standalone Video Upload Endpoint ───────────────────────────────────────────
export const uploadVideoOnly: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authReq = req as AuthRequestWithFiles;
    const authUser = authReq.user;

    console.log('📤 uploadVideoOnly called');
    console.log('   req.file:', req.file);
    console.log('   req.files:', req.files);
    console.log('   req.body:', req.body);

    if (!authUser) {
      cleanupUploadedFiles(req);
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const file = req.file;

    // Support both upload.single('video') and upload.fields([{name:'video'}])
    const videoFile = file 
      ? file 
      : (files?.video?.[0]);

    if (!videoFile) {
      const fileKeys = files ? Object.keys(files) : [];
      console.log('❌ No video file found. req.file:', !!req.file, 'files:', fileKeys);
      res.status(400).json({ 
        success: false, 
        message: 'No video file uploaded or wrong field name.',
        debug: { hasReqFile: !!req.file, hasFiles: !!files, fileKeys: fileKeys }
      });
      return;
    }

    // Use getRelativePath to include subdirectory in URL (e.g., videos/filename.mp4)
    const videoUrl: string = getRelativePath(videoFile);

    console.log('✅ Video uploaded:', videoUrl);

    res.status(200).json({
      success: true,
      url: `/uploads/${videoUrl}`,
      filename: videoFile.filename,
    });
  } catch (error) {
    console.error('Video upload error:', error);
    cleanupUploadedFiles(req);
    res.status(500).json({ error: 'Failed to upload video' });
  }
};

// ─── Standalone Thumbnail Upload Endpoint ─────────────────────────────────
export const uploadThumbnailOnly: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authReq = req as AuthRequestWithFiles;
    const authUser = authReq.user;

    console.log('📤 uploadThumbnailOnly called');
    console.log('   req.file:', req.file);
    console.log('   req.files:', req.files);

    if (!authUser) {
      cleanupUploadedFiles(req);
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const file = req.file;
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

    const thumbnailFile = file
      ? file
      : (files?.thumbnail?.[0]);

    if (!thumbnailFile) {
      const fileKeys = files ? Object.keys(files) : [];
      console.log('❌ No thumbnail file found. req.file:', !!req.file, 'files:', fileKeys);
      res.status(400).json({
        success: false,
        message: 'No thumbnail file uploaded or wrong field name.',
        debug: { hasReqFile: !!req.file, hasFiles: !!files, fileKeys: fileKeys }
      });
      return;
    }

    // Use getRelativePath to include subdirectory in URL (e.g., thumbnails/lesson-thumbnails/filename.jpg)
    const thumbnailUrl: string = getRelativePath(thumbnailFile);

    console.log('✅ Thumbnail uploaded:', thumbnailUrl);

    res.status(200).json({
      success: true,
      url: `/uploads/${thumbnailUrl}`,
      filename: thumbnailFile.filename,
    });
  } catch (error) {
    console.error('Thumbnail upload error:', error);
    cleanupUploadedFiles(req);
    res.status(500).json({ error: 'Failed to upload thumbnail' });
  }
};

// ─── Route for standalone thumbnail upload ─────────────────────────────────
router.post(
  '/thumbnail',
  authMiddleware,
  checkTeacherApproval,
  upload.single('thumbnail'),
  uploadThumbnailOnly
);

// ─── Route for standalone video upload ──────────────────────────────────
router.post(
  '/video',
  authMiddleware,
  checkTeacherApproval,
  upload.single('video'),
  uploadVideoOnly
);

// ─── Route ────────────────────────────────────────────────────────────────────
// CRITICAL ORDER:
//   1. authMiddleware       — verifies JWT, does real-time DB lookup, sets req.user
//   2. checkTeacherApproval — dedicated approval gate (fresh DB query), BEFORE multer
//   3. upload.fields(...)   — multer touches disk ONLY after auth is confirmed
//   4. uploadLesson         — business logic, no redundant auth checks needed
router.post(
  '/',
  authMiddleware,
  checkTeacherApproval,
  upload.fields([
    { name: 'video',     maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 },
    { name: 'pdf',       maxCount: 1 },
  ]),
  uploadLesson
);

// ─── Chunked Upload Endpoint ───────────────────────────────────────────────
export const uploadChunk: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authReq = req as AuthRequestWithFiles;
    const authUser = authReq.user;

    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { fileName, chunkIndex, totalChunks } = req.body;
    
    if (!fileName || chunkIndex === undefined || !totalChunks) {
      res.status(400).json({ error: 'fileName, chunkIndex, and totalChunks are required' });
      return;
    }

    const chunkIndexNum = parseInt(chunkIndex.toString(), 10);
    const totalChunksNum = parseInt(totalChunks.toString(), 10);

    if (isNaN(chunkIndexNum) || isNaN(totalChunksNum)) {
      res.status(400).json({ error: 'chunkIndex and totalChunks must be valid numbers' });
      return;
    }

    const tempFileName = `temp_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const tempFilePath = path.join(TEMP_DIR, tempFileName);

    if (!req.file) {
      res.status(400).json({ error: 'Chunk file is required' });
      return;
    }

    const chunkBuffer = fs.readFileSync(req.file.path);

    if (chunkIndexNum === 0) {
      fs.writeFileSync(tempFilePath, chunkBuffer);
    } else {
      fs.appendFileSync(tempFilePath, chunkBuffer);
    }

    fs.unlinkSync(req.file.path);

    if (chunkIndexNum === totalChunksNum - 1) {
      const finalFileName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const finalFilePath = path.join(VIDEOS_DIR, finalFileName);
      
      fs.renameSync(tempFilePath, finalFilePath);

      res.status(200).json({
        success: true,
        url: `/uploads/videos/${finalFileName}`,
        message: 'Upload completed',
      });
    } else {
      res.status(200).json({
        success: true,
        message: `Chunk ${chunkIndexNum + 1}/${totalChunksNum} received`,
      });
    }
  } catch (error) {
    console.error('Chunk upload error:', error);
    res.status(500).json({ error: 'Failed to upload chunk' });
  }
};

// Chunk upload route without auth for simplicity - can be added if needed
router.post(
  '/chunk',
  multer({ 
    storage: multer.diskStorage({ destination: TEMP_DIR }),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB max per chunk
  }).single('chunk'),
  uploadChunk
);

export default router;
