import { Router } from 'express';
import { getMyChildren, getChildStats } from '../controllers/parent.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = Router();

router.get('/my-children', authMiddleware, getMyChildren);
router.get('/child/:studentId/stats', authMiddleware, getChildStats);

export default router;
