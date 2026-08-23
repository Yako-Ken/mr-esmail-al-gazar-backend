import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middlewares/auth.middleware';
import { roleMiddleware } from '../middlewares/role.middleware';
import {
  getPaymentDetail,
  listAuditEventsHandler,
  listPayments,
  listRefundsHandler,
  refundPayment,
} from '../controllers/adminPayment.controller';
import {
  listCourses,
  moderateCourse,
} from '../controllers/adminModeration.controller';
import { validateBody, validateQuery } from '../middlewares/validate.middleware';
import {
  initiateRefundSchema,
  listAuditEventsQuerySchema,
  listPaymentsQuerySchema,
} from '../schemas/adminPayment.schema';

const router = Router();

// Mounted at /api/admin. Every operation here is SUPER_ADMIN-only.
router.use(authMiddleware);
router.use(roleMiddleware('SUPER_ADMIN'));

router.get('/payments', validateQuery(listPaymentsQuerySchema), listPayments);
router.get('/payments/:orderId', getPaymentDetail);
router.post(
  '/payments/:orderId/refund',
  validateBody(initiateRefundSchema),
  refundPayment,
);
router.get('/refunds', listRefundsHandler);
router.get(
  '/audit-events',
  validateQuery(listAuditEventsQuerySchema),
  listAuditEventsHandler,
);

// Course moderation queue
const courseStatusSchema = z
  .object({
    status: z.enum(['ALL', 'PUBLISHED', 'DRAFT']).default('ALL'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

router.get('/courses', validateQuery(courseStatusSchema), listCourses);
router.post('/courses/:courseId/:action(publish|unpublish)', moderateCourse);

export default router;
