import dotenv from 'dotenv';
dotenv.config();

import { env } from './utils/env';
import { logger } from './utils/logger';
import { seedSuperAdmin } from './utils/seedAdmin';
import { initSocket } from './socket';
import cron from 'node-cron';
import { cleanupOrphanedFiles } from './utils/cleanup';
import app from './app';

const PORT: number = parseInt(env.PORT, 10);

// Schedule daily cleanup at 3:00 AM
cron.schedule('0 3 * * *', async () => {
  logger.info('⏰ Running scheduled daily orphaned files cleanup...');
  try {
    await cleanupOrphanedFiles();
  } catch (error) {
    logger.error('Daily cleanup failed:', error);
  }
});

const server = app.listen(PORT, '0.0.0.0', async () => {
  logger.info(`🚀 Server running on http://0.0.0.0:${PORT}`);
  logger.info(`📚 API: http://localhost:${PORT}/api`);
  logger.info(`📁 Static files: http://localhost:${PORT}/uploads`);

  await seedSuperAdmin();
});

initSocket(server);

server.timeout = 300000;
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;

export default app;
