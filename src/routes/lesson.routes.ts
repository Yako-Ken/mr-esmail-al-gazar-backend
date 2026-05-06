import { Router } from 'express';
import {
  markAttendance,
  submitQuiz,
  fetchStudents,
  getLessons,
  getLessonById,
  createLesson,
  updateLesson,
  deleteLesson,
} from '../controllers/lesson.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { roleMiddleware, canManageContent } from '../middlewares/role.middleware';

const router = Router();

router.post('/mark-attendance', authMiddleware, markAttendance);
router.post('/submit-quiz', authMiddleware, submitQuiz);
router.get(
  '/fetch-students',
  authMiddleware,
  roleMiddleware('TEACHER', 'SUPER_ADMIN'),
  fetchStudents
);
router.get('/', getLessons);
router.get('/public', getLessons);
router.get('/:id', authMiddleware, getLessonById);
router.post(
  '/',
  authMiddleware,
  canManageContent,
  createLesson
);
router.put(
  '/:id',
  authMiddleware,
  canManageContent,
  updateLesson
);
router.delete(
  '/:id',
  authMiddleware,
  canManageContent,
  deleteLesson
);

export default router;
