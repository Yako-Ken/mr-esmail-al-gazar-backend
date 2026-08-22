import { Router } from 'express';
import { authMiddleware, optionalAuthMiddleware } from '../middlewares/auth.middleware';
import { roleMiddleware } from '../middlewares/role.middleware';
import {
  getMyPurchasedCourses,
  getStoreCourseById,
  getStoreCourses,
  submitCheckout,
} from '../controllers/store.controller';

const router = Router();

router.get('/courses', optionalAuthMiddleware, getStoreCourses);
router.get('/courses/:id', optionalAuthMiddleware, getStoreCourseById);
router.get('/my-courses', authMiddleware, roleMiddleware('STUDENT'), getMyPurchasedCourses);

// Free enrollment only. Paid courses must use /payments/intention; manual
// receipts are deliberately removed so entitlements are webhook-driven.
router.post('/checkout', authMiddleware, roleMiddleware('STUDENT'), submitCheckout);

export default router;
