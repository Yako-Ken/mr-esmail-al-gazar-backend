import { Response } from 'express';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';

// Shared catch-block handler for controllers: AppError (thrown by services) maps
// to its intended status code, anything else is an unexpected 500.
export const handleControllerError = (context: string, error: unknown, res: Response): void => {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  logger.error(`${context} error:`, error);
  res.status(500).json({ error: 'Internal server error' });
};
