import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { getPrivateMedia } from '../controllers/media.controller';

const router = Router();

router.get('/', authMiddleware, getPrivateMedia);

export default router;
