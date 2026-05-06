import { Router } from 'express';
import { updateProgress } from '../controllers/progress.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = Router();

router.post('/update', authMiddleware, updateProgress);

export default router;
