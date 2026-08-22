import { Router } from 'express';
import {
  createCheckoutIntention,
  getPaymentOrder,
  listMyPayments,
  paymobWebhook,
} from '../controllers/payment.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { authRateLimit } from '../middlewares/rateLimit.middleware';
import { validateBody } from '../middlewares/validate.middleware';
import { checkoutIntentionSchema } from '../schemas/payment.schema';

const router = Router();

router.post('/payments/intention', authMiddleware, authRateLimit, validateBody(checkoutIntentionSchema), createCheckoutIntention);
router.get('/payments', authMiddleware, listMyPayments);
router.get('/payments/:orderId', authMiddleware, getPaymentOrder);
router.post('/paymob/webhook', paymobWebhook);

export default router;
