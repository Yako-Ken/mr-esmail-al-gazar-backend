import express, { Request, Response, RequestHandler } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthUser } from '../middlewares/auth.middleware';
import { checkTeacherApproval } from '../middlewares/role.middleware';
import { BunnyService } from '../utils/bunny.service';
import { env } from '../utils/env';
import { logger } from '../utils/logger';
import { createBunnyTusTicket } from '../utils/bunnyTus';

const router = express.Router();
const prisma = new PrismaClient();

interface AuthRequestWithFiles extends Request {
  user?: AuthUser;
  files?: Record<string, Express.Multer.File[]>;
}

// ─── Multer memory storage ───────────────────────────────────────────────────
// Files will be stored in memory as buffers, then uploaded to Bunny.net
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500 MB max for Bunny.net uploads
    fieldSize: 10 * 1024 * 1024, // 10 MB for text fields
  },
});

// Helper: Generate a unique filename and remote path for Bunny.net
const getBunnyPath = (file: Express.Multer.File, context: string = ''): string => {
  const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
  let ext = path.extname(file.originalname);
  const fieldname = file.fieldname.toLowerCase();

  if (!ext) {
    if (fieldname === 'video')     ext = '.mp4';
    else if (fieldname.includes('thumbnail')) ext = '.jpg';
    else if (fieldname === 'pdf')  ext = '.pdf';
    else ext = '.bin';
  }

  const fileName = `${fieldname}-${uniqueSuffix}${ext}`;
  
  // Categorize in Bunny storage
  if (file.mimetype.startsWith('video/')) {
    return `videos/${fileName}`;
  } else if (fieldname.includes('thumbnail') || fieldname.includes('image')) {
    if (context.includes('course')) {
      return `thumbnails/course-thumbnails/${fileName}`;
    }
    return `thumbnails/lesson-thumbnails/${fileName}`;
  } else if (fieldname.includes('pdf') || file.mimetype === 'application/pdf') {
    return `pdfs/${fileName}`;
  }
  
  return `others/${fileName}`;
};

// ─── Upload handler ───────────────────────────────────────────────────────────
export const uploadLesson: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authReq = req as AuthRequestWithFiles;
    const authUser = authReq.user;

    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId 
      ? authUser.parentTeacherId 
      : authUser.id;

    const { subject, grade, title, homeworkText, description, quizData, courseId, bunnyVideoId, videoLibraryId } = req.body;

    if (!subject || !grade || !title) {
      res.status(400).json({ error: 'Subject, grade, and title are required' });
      return;
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

    // We support either a direct video file (Storage) or a Bunny Stream upload ticket.
    // In BOTH cases a playable URL must reach the DB — previously a stream-only upload
    // saved videoUrl=null, which made the lesson appear to have "no video" to students.
    let videoUrl = '';

    if (bunnyVideoId) {
      const libraryId = videoLibraryId || env.BUNNY_STREAM_LIBRARY_ID;
      if (!libraryId) {
        logger.error('Upload rejected: bunnyVideoId supplied but no stream library id is configured');
        res.status(400).json({ error: 'Bunny Stream library id is not configured (BUNNY_STREAM_LIBRARY_ID).' });
        return;
      }
      // Store only the Stream identifiers. Playback URLs are derived and signed
      // by the protected playback endpoint, never persisted as iframe URLs.
      videoUrl = '';
      logger.info(`🎬 Linking Lesson to Bunny Stream Video: ${bunnyVideoId}`);
    } else if (files?.video?.[0]) {
      // Legacy/Direct upload to Bunny Storage
      const videoPath = getBunnyPath(files.video[0]);
      videoUrl = await BunnyService.uploadFile(files.video[0].buffer, videoPath);
    } else {
      res.status(400).json({ error: 'Video file or Bunny Video ID is required.' });
      return;
    }

    let thumbnailUrl: string | undefined;
    if (files?.thumbnail?.[0]) {
      const thumbPath = getBunnyPath(files.thumbnail[0], courseId ? 'course' : 'lesson');
      thumbnailUrl = await BunnyService.uploadFile(files.thumbnail[0].buffer, thumbPath);
    }

    let homeworkPdfUrl: string | undefined;
    if (files?.pdf?.[0]) {
      const pdfPath = getBunnyPath(files.pdf[0]);
      homeworkPdfUrl = await BunnyService.uploadFile(files.pdf[0].buffer, pdfPath);
    }

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
        res.status(400).json({ error: 'Invalid Quiz Format. Please check your questions structure.' });
        return;
      }
    }

    // Persist lesson to DB
    const lesson = await prisma.lesson.create({
      data: {
        subject,
        grade,
        teacherId: ownerId,
        title,
        description: description || null,
        videoUrl: videoUrl || null,
        bunnyVideoId: bunnyVideoId || null,
        videoLibraryId: videoLibraryId || null,
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
    });

    res.status(201).json({
      message: 'Lesson created successfully',
      lesson: {
        id: lesson.id,
        title: lesson.title,
        videoUrl: lesson.videoUrl,
        bunnyVideoId: lesson.bunnyVideoId,
        thumbnailUrl: lesson.thumbnailUrl,
        homeworkPdfUrl: lesson.homeworkPdfUrl,
        hasQuiz: !!(parsedQuestions && parsedQuestions.length > 0),
      },
    });
  } catch (error: any) {
    logger.error('Upload lesson error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload lesson' });
  }
};

// ─── Bunny Stream Ticket Endpoint (TUS Ready) ─────────────────────────────────
export const getUploadTicket: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { title, collectionId } = req.body;
    if (!title) {
      res.status(400).json({ error: 'Video title is required' });
      return;
    }

    const { guid, libraryId } = await BunnyService.createStreamVideo(title);
    const apiKey = env.BUNNY_STREAM_API_KEY;
    if (!apiKey) {
      res.status(503).json({
        error: 'Bunny Stream upload signing is not configured',
        code: 'BUNNY_UPLOAD_NOT_CONFIGURED',
      });
      return;
    }
    const ticket = createBunnyTusTicket({
      libraryId,
      videoId: guid,
      apiKey,
    });

    res.status(200).json({
      success: true,
      guid,
      libraryId,
      collectionId: collectionId || null,
      tusEndpoint: 'https://video.bunnycdn.com/tusupload',
      ...ticket,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

// ─── Standalone Video Upload Endpoint ───────────────────────────────────────────
export const uploadVideoOnly: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authReq = req as AuthRequestWithFiles;
    if (!authReq.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const videoFile = req.file || authReq.files?.video?.[0];
    if (!videoFile) {
      res.status(400).json({ error: 'No video file uploaded.' });
      return;
    }

    const videoPath = getBunnyPath(videoFile);
    const videoUrl = await BunnyService.uploadFile(videoFile.buffer, videoPath);

    res.status(200).json({
      success: true,
      url: videoUrl,
      filename: path.basename(videoPath),
    });
  } catch (error: any) {
    logger.error('Video upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload video' });
  }
};

// ─── Standalone Thumbnail Upload Endpoint ─────────────────────────────────
export const uploadThumbnailOnly: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authReq = req as AuthRequestWithFiles;
    if (!authReq.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const thumbnailFile = req.file || authReq.files?.thumbnail?.[0];
    if (!thumbnailFile) {
      res.status(400).json({ error: 'No thumbnail file uploaded.' });
      return;
    }

    const context = req.originalUrl.includes('/courses') ? 'course' : 'lesson';
    const thumbPath = getBunnyPath(thumbnailFile, context);
    const thumbnailUrl = await BunnyService.uploadFile(thumbnailFile.buffer, thumbPath);

    res.status(200).json({
      success: true,
      url: thumbnailUrl,
      filename: path.basename(thumbPath),
    });
  } catch (error: any) {
    logger.error('Thumbnail upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload thumbnail' });
  }
};

// ─── Standalone PDF Upload Endpoint ─────────────────────────────────
export const uploadPdfOnly: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authReq = req as AuthRequestWithFiles;
    if (!authReq.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const pdfFile = req.file || authReq.files?.pdf?.[0];
    if (!pdfFile) {
      res.status(400).json({ error: 'No PDF file uploaded.' });
      return;
    }

    const pdfPath = getBunnyPath(pdfFile);
    const pdfUrl = await BunnyService.uploadFile(pdfFile.buffer, pdfPath);

    res.status(200).json({
      success: true,
      url: pdfUrl,
      filename: path.basename(pdfPath),
    });
  } catch (error: any) {
    logger.error('PDF upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload PDF' });
  }
};

// ─── Chunked Upload Endpoint (disk-based) ───────────────────────────────────
// Chunks are written to per-upload temp dirs on disk — NOT kept in process memory.
// Previous implementation held every chunk in a Map<string, Buffer[]>, which let a few
// concurrent uploads OOM the whole server. Chunk files are also cleaned up by the
// daily cleanupOrphanedFiles cron via the 24h-age rule below.
const CHUNK_ROOT = path.join(process.cwd(), 'uploads', 'temp', 'chunks');
const MAX_CHUNK_BYTES = 50 * 1024 * 1024; // hard ceiling per chunk, enforced before multer
const MAX_TOTAL_CHUNKS = 2000;            // 2000 x 5MB = ~10GB max upload
const CHUNK_TTL_MS = 24 * 60 * 60 * 1000; // orphan chunks older than this are deletable

const sanitizeUploadKey = (raw: string): string =>
  raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);

// Best-effort orphan reaper — runs on each completed upload so dirs can't pile up forever
// even between cron runs. Never throws.
const reapStaleChunkDirs = (): void => {
  try {
    if (!fs.existsSync(CHUNK_ROOT)) return;
    const now = Date.now();
    for (const entry of fs.readdirSync(CHUNK_ROOT)) {
      const dir = path.join(CHUNK_ROOT, entry);
      try {
        const stat = fs.statSync(dir);
        if (stat.isDirectory() && now - stat.mtimeMs > CHUNK_TTL_MS) {
          fs.rmSync(dir, { recursive: true, force: true });
          logger.info(`🧹 Reaped stale chunk dir: ${entry}`);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
};

export const uploadChunk: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { fileName, chunkIndex, totalChunks } = req.body;
    if (!fileName || chunkIndex === undefined || !totalChunks || !req.file) {
      res.status(400).json({ error: 'Missing chunk data' });
      return;
    }

    const idx = parseInt(chunkIndex);
    const total = parseInt(totalChunks);

    if (!Number.isInteger(idx) || !Number.isInteger(total) || idx < 0 || idx >= total) {
      res.status(400).json({ error: 'Invalid chunkIndex/totalChunks' });
      return;
    }
    if (total > MAX_TOTAL_CHUNKS) {
      res.status(400).json({ error: `totalChunks exceeds max of ${MAX_TOTAL_CHUNKS}` });
      return;
    }

    const key = sanitizeUploadKey(String(fileName));
    const uploadDir = path.join(CHUNK_ROOT, key);
    fs.mkdirSync(uploadDir, { recursive: true });

    const chunkPath = path.join(uploadDir, `${String(idx).padStart(6, '0')}.part`);
    fs.writeFileSync(chunkPath, req.file.buffer);

    // Have we received every chunk?
    const received = fs.readdirSync(uploadDir).filter((f) => f.endsWith('.part')).length;

    if (received < total) {
      res.status(200).json({ success: true, message: `Chunk ${idx + 1}/${total} received` });
      return;
    }

    // All chunks present — assemble from disk to the final temp file
    logger.info(`📦 All ${total} chunks received for ${key}. Assembling and uploading to Bunny...`);
    const finalPath = path.join(uploadDir, 'assembled.bin');
    const out = fs.createWriteStream(finalPath);
    for (let i = 0; i < total; i++) {
      const p = path.join(uploadDir, `${String(i).padStart(6, '0')}.part`);
      if (!fs.existsSync(p)) {
        out.destroy();
        fs.rmSync(finalPath, { force: true });
        res.status(400).json({ error: `Chunk ${i} missing during assembly` });
        return;
      }
      out.write(fs.readFileSync(p));
    }
    out.end();
    await new Promise<void>((resolve, reject) => {
      out.on('finish', () => resolve());
      out.on('error', reject);
    });

    const finalBuffer = fs.readFileSync(finalPath);
    const remotePath = `videos/${Date.now()}-${key}`;
    const videoUrl = await BunnyService.uploadFile(finalBuffer, remotePath);

    fs.rmSync(uploadDir, { recursive: true, force: true });
    reapStaleChunkDirs();

    res.status(200).json({
      success: true,
      url: videoUrl,
      message: 'Chunked upload completed to Bunny.net',
    });
  } catch (error: any) {
    logger.error('Chunk upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload chunk' });
  }
};

// ─── Routes ───────────────────────────────────────────────────────────────────

router.post('/video-ticket', authMiddleware, checkTeacherApproval, getUploadTicket);
router.post('/thumbnail', authMiddleware, checkTeacherApproval, upload.single('thumbnail'), uploadThumbnailOnly);
router.post('/pdf', authMiddleware, checkTeacherApproval, upload.single('pdf'), uploadPdfOnly);
router.post('/video', authMiddleware, checkTeacherApproval, upload.single('video'), uploadVideoOnly);
router.post('/', authMiddleware, checkTeacherApproval, upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
  { name: 'pdf', maxCount: 1 },
]), uploadLesson);

router.post('/chunk', authMiddleware, checkTeacherApproval, upload.single('chunk'), uploadChunk);

export default router;

