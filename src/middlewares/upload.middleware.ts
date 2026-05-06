import multer, { FileFilterCallback } from 'multer';
import { Request } from 'express';
import path from 'path';
import fs from 'fs';

// 1. Storage Directories Strategy
const UPLOAD_DIR = path.join(__dirname, '../../uploads');
const VIDEOS_DIR = path.join(UPLOAD_DIR, 'videos');
const THUMBNAILS_DIR = path.join(UPLOAD_DIR, 'thumbnails');
const PDFS_DIR = path.join(UPLOAD_DIR, 'pdfs');

// Auto-create directories if they don't exist
[UPLOAD_DIR, VIDEOS_DIR, THUMBNAILS_DIR, PDFS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// 2. Storage Engine (Categorized)
const storage = multer.diskStorage({
  destination: (_req: Request, file: Express.Multer.File, cb: (error: Error | null, destination: string) => void) => {
    switch (file.fieldname) {
      case 'videoFile':
        cb(null, VIDEOS_DIR);
        break;
      case 'thumbnailFile':
        cb(null, THUMBNAILS_DIR);
        break;
      case 'pdfFile':
        cb(null, PDFS_DIR);
        break;
      default:
        cb(null, UPLOAD_DIR);
    }
  },
  filename: (_req: Request, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
    // Unique naming convention to prevent overrides
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    let ext = path.extname(file.originalname);
    if (!ext) {
      if (file.fieldname === 'videoFile' || file.mimetype.startsWith('video/')) ext = '.mp4';
      else if (file.fieldname === 'thumbnailFile' || file.mimetype.startsWith('image/')) ext = '.jpg';
      else if (file.fieldname === 'pdfFile') ext = '.pdf';
    }
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  },
});

// 3. Strict File Filtering
const fileFilter = (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
  const allowedVideoTypes = ['video/mp4', 'video/webm', 'video/quicktime'];
  const allowedImageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const allowedPdfTypes = ['application/pdf'];

  if (file.fieldname === 'videoFile') {
    if (allowedVideoTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid video format. Allowed: mp4, webm, quicktime'));
    }
  } else if (file.fieldname === 'thumbnailFile') {
    if (allowedImageTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid image format. Allowed: jpeg, png, webp, gif'));
    }
  } else if (file.fieldname === 'pdfFile') {
    if (allowedPdfTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid document format. Allowed: pdf'));
    }
  } else {
    cb(null, true);
  }
};

// 4. Exported Middleware
export const uploadMiddleware = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max per file
    files: 10,
  },
});

// Helper fields exporter for specific routes
export const lessonUploadFields = uploadMiddleware.fields([
  { name: 'videoFile', maxCount: 1 },
  { name: 'thumbnailFile', maxCount: 1 },
  { name: 'pdfFile', maxCount: 1 },
]);
