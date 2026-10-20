import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';
import { disconnectUserSockets } from '../socket';
import {
  PrivacyServiceError,
  buildAccountExport,
  cancelAccountDeletion,
  getPrivacyRequestStatus,
  recordCompletedExport,
  scheduleAccountDeletion,
  verifyCurrentPassword,
} from '../services/privacy.service';

import prisma from '../config/prisma';

const authUserId = (req: Request): string | null => req.user?.id ?? null;

const handlePrivacyError = (res: Response, error: unknown): void => {
  if (error instanceof PrivacyServiceError) {
    res.status(error.status).json({ code: error.code, error: error.message });
    return;
  }
  logger.error('Data privacy operation failed:', error);
  res.status(500).json({ code: 'PRIVACY_OPERATION_FAILED', error: 'تعذر إكمال العملية الآن.' });
};

export const exportAccountData = async (req: Request, res: Response): Promise<void> => {
  const userId = authUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    await verifyCurrentPassword(prisma, userId, String(req.body.password));
    const data = await buildAccountExport(prisma, userId);
    const request = await recordCompletedExport(prisma, userId);
    res.set('Cache-Control', 'no-store, private');
    logger.info('Account data export completed', { userId, requestId: request.id });
    res.json({
      request: { ...request, status: 'GENERATED' },
      fileName: `esmail-elgazar-account-data-${request.id}.json`,
      export: data,
    });
  } catch (error) {
    handlePrivacyError(res, error);
  }
};

export const privacyRequestStatus = async (req: Request, res: Response): Promise<void> => {
  const userId = authUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    res.set('Cache-Control', 'no-store, private');
    res.json(await getPrivacyRequestStatus(prisma, userId));
  } catch (error) {
    handlePrivacyError(res, error);
  }
};

export const requestAccountDeletion = async (req: Request, res: Response): Promise<void> => {
  const userId = authUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    await verifyCurrentPassword(prisma, userId, String(req.body.password));
    const deletion = await scheduleAccountDeletion(prisma, userId, req.body.reason);
    disconnectUserSockets(userId);
    logger.warn('Account deletion scheduled', {
      userId,
      requestId: deletion.id,
      scheduledFor: deletion.scheduledFor,
    });
    res.status(202).json({
      deletion,
      message: 'تم تسجيل طلب الحذف وإلغاء الجلسات. يمكنك إلغاء الطلب خلال مهلة الأمان.',
    });
  } catch (error) {
    handlePrivacyError(res, error);
  }
};

export const cancelDeletionRequest = async (req: Request, res: Response): Promise<void> => {
  const userId = authUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    await verifyCurrentPassword(prisma, userId, String(req.body.password));
    const deletion = await cancelAccountDeletion(prisma, userId);
    logger.info('Account deletion canceled', { userId, requestId: deletion.id });
    res.json({ deletion, message: 'تم إلغاء طلب حذف الحساب.' });
  } catch (error) {
    handlePrivacyError(res, error);
  }
};
