import express, { Request, Response, RequestHandler } from 'express';
import multer from 'multer';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthUser } from '../middlewares/auth.middleware';
import { checkTeacherApproval } from '../middlewares/role.middleware';
import { BunnyService } from '../utils/bunny.service';

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

    // We now support either a direct video file or a Bunny Stream ID
    let videoUrl = '';
    
    if (bunnyVideoId) {
      // If using Bunny Stream, the URL will be the embed or stream URL
      // For now we just store the ID; the client can use it to build the URL
      console.log(`🎬 Linking Lesson to Bunny Stream Video: ${bunnyVideoId}`);
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
    console.error('Upload lesson error:', error);
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

    res.status(200).json({
      success: true,
      guid,
      libraryId,
      collectionId: collectionId || null,
      tusEndpoint: 'https://video.bunnycdn.com/tusupload', // Standard Bunny TUS endpoint
      accessKey: process.env.BUNNY_STREAM_API_KEY,
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
    console.error('Video upload error:', error);
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
    console.error('Thumbnail upload error:', error);
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
    console.error('PDF upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload PDF' });
  }
};

// ─── Chunked Upload Endpoint ───────────────────────────────────────────────
// For memory storage, we assemble chunks in a Buffer or handle differently.
// Note: This implementation stores chunks in memory, which is risky for huge files.
// For extremely large files, using a temporary local disk and then uploading to Bunny is better.
const chunkMap = new Map<string, Buffer[]>();

export const uploadChunk: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { fileName, chunkIndex, totalChunks } = req.body;
    if (!fileName || chunkIndex === undefined || !totalChunks || !req.file) {
      res.status(400).json({ error: 'Missing chunk data' });
      return;
    }

    const idx = parseInt(chunkIndex);
    const total = parseInt(totalChunks);
    const key = fileName;

    if (!chunkMap.has(key)) {
      chunkMap.set(key, new Array(total));
    }

    const chunks = chunkMap.get(key)!;
    chunks[idx] = req.file.buffer;

    // Check if all chunks are received
    const receivedCount = chunks.filter(c => c !== undefined).length;

    if (receivedCount === total) {
      console.log(`📦 All chunks received for ${fileName}. Assembling and uploading to Bunny...`);
      const finalBuffer = Buffer.concat(chunks);
      
      const remotePath = `videos/${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const videoUrl = await BunnyService.uploadFile(finalBuffer, remotePath);
      
      chunkMap.delete(key); // Cleanup

      res.status(200).json({
        success: true,
        url: videoUrl,
        message: 'Chunked upload completed to Bunny.net',
      });
    } else {
      res.status(200).json({
        success: true,
        message: `Chunk ${idx + 1}/${total} received`,
      });
    }
  } catch (error: any) {
    console.error('Chunk upload error:', error);
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

router.post('/chunk', upload.single('chunk'), uploadChunk);

export default router;

