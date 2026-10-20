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
import { roleMiddleware } from '../middlewares/role.middleware';
import { linkChildSchema } from '../schemas/parent.schema';

const router = Router();

router.post('/link-code', authMiddleware, otpRateLimit, createParentLinkCode);
// Role is checked before the body is validated. With the original order an
// unauthorized caller received 400 plus schema wording for a wrong payload and
// 403 for a well-formed one, so the difference told them the expected code
// format. An unauthorised caller should learn nothing about the shape of a
// request they are not allowed to make.
router.post('/link-child', authMiddleware, roleMiddleware('PARENT'), otpRateLimit, validateBody(linkChildSchema), linkChild);
router.delete('/child/:studentId/link', authMiddleware, unlinkChild);
router.get('/my-children', authMiddleware, getMyChildren);
router.get('/child/:studentId/stats', authMiddleware, getChildStats);

export default router;
