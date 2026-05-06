import { Router } from 'express';
import { getStudentDashboard, getWeeklyProgress, getRecentLessons } from '../controllers/student.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { roleMiddleware } from '../middlewares/role.middleware';

const router = Router();

router.get('/my-dashboard', authMiddleware, roleMiddleware('STUDENT'), getStudentDashboard);
router.get('/weekly-progress', authMiddleware, roleMiddleware('STUDENT'), getWeeklyProgress);
router.get('/recent-lessons', authMiddleware, roleMiddleware('STUDENT'), getRecentLessons);

export default router;
