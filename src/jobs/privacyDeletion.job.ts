import { PrismaClient } from '@prisma/client';
import { executeDueAccountDeletions } from '../services/privacy.service';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

export const runPrivacyDeletionJob = async (): Promise<void> => {
  try {
    const result = await executeDueAccountDeletions(prisma);
    if (result.processed > 0 || result.failed > 0) {
      logger.info('Privacy deletion job completed', result);
    }
  } catch (error) {
    logger.error('Privacy deletion job failed:', error);
  }
};
