import { Router } from 'express';
import { z } from 'zod';
import { AnalyticsService } from '../services/analytics.service';
import { authMiddleware, optionalAuthMiddleware } from '../middlewares/auth.middleware';

const router = Router();

const trackEventSchema = z.object({
  eventType: z.enum([
    'login',
    'register',
    'course_view',
    'course_enroll',
    'lesson_view',
    'video_play',
    'video_complete',
    'quiz_start',
    'quiz_submit',
    'payment_intent',
    'payment_complete',
    'share_course',
    'onboarding_complete',
  ]),
  metadata: z.record(z.unknown()).optional(),
});

// Optional auth — anonymous events are allowed, while signed-in events retain
// their user id for meaningful funnel analysis.
router.post('/track', optionalAuthMiddleware, async (req, res) => {
  const parsed = trackEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid event', details: parsed.error.flatten() });
  }
  const userId = (req as any).user?.id ?? null;
  await AnalyticsService.track(parsed.data.eventType, userId, parsed.data.metadata);
  return res.status(204).send();
});

// Admin-only funnel stats
router.get('/funnel', authMiddleware, async (_req, res) => {
  const stats = await AnalyticsService.getFunnelStats(7);
  return res.json({ stats });
});

export default router;
