import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authMiddleware, AuthUser } from '../middlewares/auth.middleware';
import { roleMiddleware, canManageContent } from '../middlewares/role.middleware';
import { getTeacherCourses, createCourse, getCourseById, getAllCourses, updateCourse, deleteCourse, uploadThumbnail } from '../controllers/course.controller';

const router = Router();

// ── Multer — stores course thumbnails in organized subdirectory ──────────────
const COURSE_THUMBNAILS_DIR = path.join(process.cwd(), 'uploads', 'thumbnails', 'course-thumbnails');
if (!fs.existsSync(COURSE_THUMBNAILS_DIR)) {
  fs.mkdirSync(COURSE_THUMBNAILS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, COURSE_THUMBNAILS_DIR);
  },
  filename: (_req, file, cb) => {
    const suffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `course-thumb-${suffix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max for thumbnails
});

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/courses  — returns ALL courses (Admin) or teacher's own courses (Teacher)
router.get(
  '/',
  authMiddleware,
  getAllCourses,
);

// GET /api/courses/my  — teacher's own courses (used by the lesson dropdown)
router.get(
  '/my',
  authMiddleware,
  roleMiddleware('TEACHER', 'SUPER_ADMIN'),
  getTeacherCourses,
);

// POST /api/courses  — create a new course (requires SUPER_ADMIN or APPROVED_TEACHER)
router.post(
  '/',
  authMiddleware,
  canManageContent,
  upload.fields([{ name: 'thumbnail', maxCount: 1 }]),
  createCourse,
);

// GET /api/courses/:id  — public single-course view
router.get('/:id', getCourseById);

// PUT /api/courses/:id  — update course (owner or admin)
router.put('/:id', authMiddleware, canManageContent, updateCourse);

// PATCH /api/courses/:id  — update course (owner or admin) - matches frontend
router.patch('/:id', authMiddleware, canManageContent, updateCourse);

// DELETE /api/courses/:id  — cascade delete course (owner or admin)
router.delete('/:id', authMiddleware, canManageContent, deleteCourse);

// POST /api/courses/:id/thumbnail  — upload course thumbnail
const thumbnailStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, COURSE_THUMBNAILS_DIR);
  },
  filename: (_req, file, cb) => {
    const suffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `course-thumb-${suffix}${ext}`);
  },
});
const thumbnailUpload = multer({ storage: thumbnailStorage, limits: { fileSize: 20 * 1024 * 1024 } });
router.post('/:id/thumbnail', authMiddleware, canManageContent, thumbnailUpload.single('thumbnail'), uploadThumbnail);

export default router;
