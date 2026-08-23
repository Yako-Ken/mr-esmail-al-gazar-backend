import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { roleMiddleware } from '../middlewares/role.middleware';
import {
  getPaymentDetail,
  listAuditEventsHandler,
  listPayments,
  listRefundsHandler,
  refundPayment,
} from '../controllers/adminPayment.controller';
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

export default router;
