// Notification Routes — REST endpoints for push token + notification list
import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middlewares/auth.middleware';
import { validateBody } from '../middlewares/validate.middleware';
import { NotificationService } from '../services/notification.service';

const router = Router();

// All routes require auth
router.use(authMiddleware);

// GET /api/notifications — list user notifications (query: unreadOnly=true)
router.get('/', async (req, res) => {
  const unreadOnly = req.query.unreadOnly === 'true';
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

  const notifications = await NotificationService.getForUser(
    (req as any).user.id,
    unreadOnly,
    limit,
  );
  res.json({ notifications, unreadOnly, count: notifications.length });
});

// POST /api/notifications/fcm-token — save device's push token
router.post('/fcm-token', validateBody(z.object({
  token: z.string().min(10),
  platform: z.enum(['android', 'ios']),
})), async (req, res) => {
  const { token, platform } = req.body;
  await NotificationService.registerPushToken((req as any).user.id, token, platform);
  res.json({ ok: true, registered: true });
});

// POST /api/notifications/:id/read — mark one notification as read
router.post('/:id/read', async (req, res) => {
  const result = await NotificationService.markRead((req as any).user.id, req.params.id);
  if (result.count === 0) {
    return res.status(404).json({ error: 'Notification not found or not yours' });
  }
  res.json({ ok: true });
});

// POST /api/notifications/read-all — mark all as read
router.post('/read-all', async (req, res) => {
  const result = await NotificationService.markAllRead((req as any).user.id);
  res.json({ ok: true, marked: result.count });
});

export default router;
