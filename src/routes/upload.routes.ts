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
import { uploadRateLimit, chunkUploadRateLimit } from '../middlewares/rateLimit.middleware';
import {
  validateUploadedFiles,
  ValidatedField,
  ValidationResult,
} from '../services/upload-validation.service';

const router = express.Router();
import prisma from '../config/prisma';

interface AuthRequestWithFiles extends Request {
  user?: AuthUser;
  files?: Record<string, Express.Multer.File[]>;
}

// ─── Disk-backed multipart storage ───────────────────────────────────────────
// Keep large request bodies off the Node.js heap. Files are uploaded to Bunny
// from disk and removed in each handler's finally block.
const MULTIPART_TEMP_DIR = path.join(process.cwd(), 'uploads', 'temp', 'multipart');
fs.mkdirSync(MULTIPART_TEMP_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MULTIPART_TEMP_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}-${path.basename(file.originalname)}`),
});

const upload = multer({
  storage,
  limits: {
    // Direct uploads are intentionally smaller because multer keeps the
    // request in memory. Larger videos must use /chunk or Bunny TUS.
    fileSize: 100 * 1024 * 1024,
    fieldSize: 10 * 1024 * 1024,
  },
});

// Helper: Generate a unique filename and remote path for Bunny.net
const cleanupMultipartFiles = (req: Request): void => {
  try {
    const files: Express.Multer.File[] = [];
    if (req.file) files.push(req.file);
    if (Array.isArray(req.files)) files.push(...req.files);
    else if (req.files) Object.values(req.files).forEach((items) => files.push(...items));
    for (const file of files) {
      if (file.path) fs.rmSync(file.path, { force: true });
    }
  } catch {
    // Cleanup must never mask the original request result.
  }
};

const uploadToBunny = (file: Express.Multer.File, remotePath: string): Promise<string> =>
  file.path
    ? BunnyService.uploadFileFromPath(file.path, remotePath)
    : BunnyService.uploadFile(file.buffer, remotePath);

// Helper: Generate a unique filename and remote path for Bunny.net
const getBunnyPath = (
  file: Express.Multer.File,
  context: string = '',
  verified?: ValidatedField,
): string => {
  const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
  const fieldname = file.fieldname.toLowerCase();

  // When the bytes have already been signature-verified, BOTH the extension and
  // the routing category come from the detected content. The client's filename
  // and Content-Type are not consulted for either: they are attacker-supplied,
  // and repeating them here is what let a PHP payload land in the CDN under an
  // image name.
  let ext = verified ? verified.extension : path.extname(file.originalname);

  if (!ext) {
    if (fieldname === 'video')     ext = '.mp4';
    else if (fieldname.includes('thumbnail')) ext = '.jpg';
    else if (fieldname === 'pdf')  ext = '.pdf';
    else ext = '.bin';
  }

  const fileName = `${fieldname}-${uniqueSuffix}${ext}`;

  // Categorize in Bunny storage. A verified file is routed by its field and its
  // detected type; only unverified (video/chunk) uploads fall back to the
  // client-declared Content-Type.
  if (!verified && file.mimetype.startsWith('video/')) {
    return `videos/${fileName}`;
  } else if (fieldname.includes('thumbnail') || fieldname.includes('image')) {
    if (context.includes('course')) {
      return `thumbnails/course-thumbnails/${fileName}`;
    }
    return `thumbnails/lesson-thumbnails/${fileName}`;
  } else if (fieldname.includes('pdf') || verified?.mime === 'application/pdf') {
    return `pdfs/${fileName}`;
  }

  return `others/${fileName}`;
};

/**
 * Content gate for the image/PDF fields of a request.
 *
 * Runs before any handler reaches remote storage, so a rejected payload is never
 * uploaded on its way to being rejected. The `finally` block of every handler
 * still removes the multer temp file, so a 415 leaves nothing behind.
 */
const rejectUnverifiedContent = (
  verdict: ValidationResult,
  res: Parameters<RequestHandler>[1],
): boolean => {
  if (verdict.ok) return false;
  logger.warn(
    `Upload rejected: ${verdict.failure.field} did not match required content type`,
  );
  res.status(415).json({ error: verdict.failure.message });
  return true;
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

    if (!subject || !grade || !title || !courseId) {
      res.status(400).json({ error: 'Subject, grade, title, and courseId are required' });
      return;
    }

    const course = await prisma.course.findFirst({
      where: authUser.role === 'SUPER_ADMIN'
        ? { id: String(courseId).trim() }
        : { id: String(courseId).trim(), teacherId: ownerId },
      select: { id: true, subject: true, grade: true },
    });
    if (!course) {
      res.status(403).json({ error: 'Course not found or not owned by this account' });
      return;
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

    // Content gate FIRST. The thumbnail and homework PDF are verified from their
    // leading bytes before anything is sent to Bunny, so a payload that lies
    // about being an image is refused without ever leaving this process and
    // without a lesson row being written.
    const verdict = validateUploadedFiles({
      thumbnail: files?.thumbnail?.[0],
      pdf: files?.pdf?.[0],
    });
    if (rejectUnverifiedContent(verdict, res)) return;
    const verified = verdict.ok ? verdict.fields : {};

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
      videoUrl = await uploadToBunny(files.video[0], videoPath);
    } else {
      res.status(400).json({ error: 'Video file or Bunny Video ID is required.' });
      return;
    }

    let thumbnailUrl: string | undefined;
    if (files?.thumbnail?.[0]) {
      const thumbPath = getBunnyPath(files.thumbnail[0], courseId ? 'course' : 'lesson', verified.thumbnail);
      thumbnailUrl = await uploadToBunny(files.thumbnail[0], thumbPath);
    }

    let homeworkPdfUrl: string | undefined;
    if (files?.pdf?.[0]) {
      const pdfPath = getBunnyPath(files.pdf[0], '', verified.pdf);
      homeworkPdfUrl = await uploadToBunny(files.pdf[0], pdfPath);
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
  } finally {
    cleanupMultipartFiles(req);
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
    const videoUrl = await uploadToBunny(videoFile, videoPath);

    res.status(200).json({
      success: true,
      url: videoUrl,
      filename: path.basename(videoPath),
    });
  } catch (error: any) {
    logger.error('Video upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload video' });
  } finally {
    cleanupMultipartFiles(req);
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

    // The extension and the Content-Type on this file are chosen by the caller.
    // Accept or reject on the signature, and store the extension the bytes imply.
    const verdict = validateUploadedFiles({ thumbnail: thumbnailFile });
    if (rejectUnverifiedContent(verdict, res)) return;

    const context = req.originalUrl.includes('/courses') ? 'course' : 'lesson';
    const thumbPath = getBunnyPath(
      thumbnailFile,
      context,
      verdict.ok ? verdict.fields.thumbnail : undefined,
    );
    const thumbnailUrl = await uploadToBunny(thumbnailFile, thumbPath);

    res.status(200).json({
      success: true,
      url: thumbnailUrl,
      filename: path.basename(thumbPath),
    });
  } catch (error: any) {
    logger.error('Thumbnail upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload thumbnail' });
  } finally {
    cleanupMultipartFiles(req);
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

    const verdict = validateUploadedFiles({ pdf: pdfFile });
    if (rejectUnverifiedContent(verdict, res)) return;

    const pdfPath = getBunnyPath(pdfFile, '', verdict.ok ? verdict.fields.pdf : undefined);
    const pdfUrl = await uploadToBunny(pdfFile, pdfPath);

    res.status(200).json({
      success: true,
      url: pdfUrl,
      filename: path.basename(pdfPath),
    });
  } catch (error: any) {
    logger.error('PDF upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload PDF' });
  } finally {
    cleanupMultipartFiles(req);
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
    if (req.file.size > MAX_CHUNK_BYTES) {
      res.status(413).json({ error: `Chunk exceeds max size of ${MAX_CHUNK_BYTES} bytes` });
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
    if (!key || key === '.' || key === '..') {
      res.status(400).json({ error: 'Invalid file name' });
      return;
    }
    const uploadDir = path.join(CHUNK_ROOT, key);
    fs.mkdirSync(uploadDir, { recursive: true });

    const chunkPath = path.join(uploadDir, `${String(idx).padStart(6, '0')}.part`);
    if (req.file.path) {
      fs.renameSync(req.file.path, chunkPath);
    } else {
      fs.writeFileSync(chunkPath, req.file.buffer);
    }

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

    const remotePath = `videos/${Date.now()}-${key}`;
    const videoUrl = await BunnyService.uploadFileFromPath(finalPath, remotePath);

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
  } finally {
    cleanupMultipartFiles(req);
  }
};

// ─── Routes ───────────────────────────────────────────────────────────────────

router.post('/video-ticket', authMiddleware, checkTeacherApproval, uploadRateLimit, getUploadTicket);
router.post('/thumbnail', authMiddleware, checkTeacherApproval, uploadRateLimit, upload.single('thumbnail'), uploadThumbnailOnly);
router.post('/pdf', authMiddleware, checkTeacherApproval, uploadRateLimit, upload.single('pdf'), uploadPdfOnly);
router.post('/video', authMiddleware, checkTeacherApproval, uploadRateLimit, upload.single('video'), uploadVideoOnly);
router.post('/', authMiddleware, checkTeacherApproval, uploadRateLimit, upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
  { name: 'pdf', maxCount: 1 },
]), uploadLesson);

router.post('/chunk', authMiddleware, checkTeacherApproval, chunkUploadRateLimit, upload.single('chunk'), uploadChunk);

export default router;

