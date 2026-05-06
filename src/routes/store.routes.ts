import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authMiddleware, optionalAuthMiddleware } from '../middlewares/auth.middleware';
import { roleMiddleware } from '../middlewares/role.middleware';
import {
  getStoreCourses,
  getStoreCourseById,
  getMyPurchasedCourses,
  submitCheckout,
} from '../controllers/store.controller';

const router = Router();

// ── Multer for receipt images ──────────────────────────────────────────────
const receiptStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(process.cwd(), 'uploads', 'receipts');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const suffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `receipt-${suffix}${ext}`);
  },
});
const uploadReceipt = multer({
  storage: receiptStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max for receipt images
});

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/store/courses — public catalog (optionally auth to mark isOwned)
router.get('/courses', optionalAuthMiddleware, getStoreCourses);

// GET /api/store/courses/:id — single course details with lessons
router.get('/courses/:id', optionalAuthMiddleware, getStoreCourseById);

// GET /api/store/my-courses — student's APPROVED purchases only (fixes data-leak)
router.get('/my-courses', authMiddleware, roleMiddleware('STUDENT'), getMyPurchasedCourses);

// POST /api/store/checkout — submit manual payment receipt
router.post(
  '/checkout',
  authMiddleware,
  roleMiddleware('STUDENT'),
  uploadReceipt.single('receipt'),
  submitCheckout,
);

export default router;
