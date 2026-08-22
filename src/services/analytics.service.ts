// Analytics Service — self-hosted, no third-party required
// Tracks key user actions for funnel optimization
// POST /api/analytics/track { eventType, metadata{} }
// Events: login, course_view, video_play, quiz_submit, payment_intent, payment_complete

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export type AnalyticsEventType =
  | 'login'
  | 'register'
  | 'course_view'
  | 'course_enroll'
  | 'lesson_view'
  | 'video_play'
  | 'video_complete'
  | 'quiz_start'
  | 'quiz_submit'
  | 'payment_intent'
  | 'payment_complete'
  | 'share_course'
  | 'onboarding_complete';

export class AnalyticsService {
  /**
   * Track an analytics event. Fire-and-forget — never throws.
   */
  static async track(
    eventType: AnalyticsEventType,
    userId: string | null,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await prisma.analyticsEvent.create({
        data: {
          eventType,
          userId: userId ?? undefined,
          // SQLite stores analytics metadata as a JSON string (schema.prisma).
          // Passing an object makes Prisma reject the write while the route still
          // returns 204 because analytics is deliberately non-blocking.
          metadata: metadata ? JSON.stringify(metadata) : undefined,
          timestamp: new Date(),
        },
      });
    } catch (err) {
      // Silently ignore analytics failures — never block the request
      console.warn(`[analytics] Failed to track ${eventType}:`, err);
    }
  }

  static async getFunnelStats(daysBack = 7) {
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    return prisma.analyticsEvent.groupBy({
      by: ['eventType'],
      _count: { eventType: true },
      where: { timestamp: { gte: since } },
    });
  }
}
