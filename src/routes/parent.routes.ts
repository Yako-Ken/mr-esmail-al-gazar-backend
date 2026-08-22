import { Router } from 'express';
import {
  createParentLinkCode,
  getChildStats,
  getMyChildren,
  linkChild,
  unlinkChild,
} from '../controllers/parent.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { otpRateLimit } from '../middlewares/rateLimit.middleware';
import { validateBody } from '../middlewares/validate.middleware';
import { linkChildSchema } from '../schemas/parent.schema';

const router = Router();

router.post('/link-code', authMiddleware, otpRateLimit, createParentLinkCode);
router.post('/link-child', authMiddleware, otpRateLimit, validateBody(linkChildSchema), linkChild);
router.delete('/child/:studentId/link', authMiddleware, unlinkChild);
router.get('/my-children', authMiddleware, getMyChildren);
router.get('/child/:studentId/stats', authMiddleware, getChildStats);

export default router;
