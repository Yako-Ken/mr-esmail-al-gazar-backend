import { Request, Response } from 'express';
import { AuthUser } from '../middlewares/auth.middleware';
import { logger } from '../utils/logger';
import {
  getPaymentOrderDetail,
  initiateRefund,
  listAuditEvents,
  listPaymentOrders,
  listRefunds,
} from '../services/adminPayment.service';

type AuthenticatedRequest = Request & { user?: AuthUser };

const requireUser = (req: AuthenticatedRequest, res: Response): AuthUser | null => {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return req.user;
};

export const listPayments = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    if (!requireUser(req, res)) return;
    const result = await listPaymentOrders({
      status: req.query.status as 'PENDING' | 'PAID' | 'FAILED' | 'ALL' | undefined,
      page: req.query.page as number | undefined,
      limit: req.query.limit as number | undefined,
    });
    res.json(result);
  } catch (error) {
    logger.error('listPayments error:', error);
    res.status(500).json({ error: 'Unable to load payments' });
  }
};

export const getPaymentDetail = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    if (!requireUser(req, res)) return;
    const detail = await getPaymentOrderDetail(String(req.params.orderId));
    if (!detail) {
      res.status(404).json({ error: 'Payment order not found' });
      return;
    }
    res.json(detail);
  } catch (error) {
    logger.error('getPaymentDetail error:', error);
    res.status(500).json({ error: 'Unable to load payment detail' });
  }
};

export const refundPayment = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    const orderId = String(req.params.orderId);
    const result = await initiateRefund(user.id, orderId, req.body.reason);

    if (result.code === 'NOT_FOUND') {
      res.status(404).json({ error: 'Payment order not found' });
      return;
    }
    if (result.code === 'REFUND_NOT_ALLOWED') {
      res.status(409).json({
        error: 'Refunds are only possible for paid orders',
        code: 'REFUND_NOT_ALLOWED',
      });
      return;
    }

    res.status(result.code === 'CREATED' ? 201 : 200).json({
      refund: result.refund,
      idempotentReplay: result.code === 'EXISTING',
      // Money movement is executed by the provider; the request stays
      // REQUESTED until a provider confirmation sync flips it to REFUNDED.
      note: 'REQUESTED until provider confirmation',
    });
  } catch (error) {
    logger.error('refundPayment error:', error);
    res.status(500).json({ error: 'Unable to initiate refund' });
  }
};

export const listRefundsHandler = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    if (!requireUser(req, res)) return;
    const result = await listRefunds({
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 20,
    });
    res.json(result);
  } catch (error) {
    logger.error('listRefunds error:', error);
    res.status(500).json({ error: 'Unable to load refunds' });
  }
};

export const listAuditEventsHandler = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    if (!requireUser(req, res)) return;
    const result = await listAuditEvents({
      category: String(req.query.category ?? 'ALL'),
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 30,
    });
    res.json(result);
  } catch (error) {
    logger.error('listAuditEvents error:', error);
    res.status(500).json({ error: 'Unable to load audit events' });
  }
};
