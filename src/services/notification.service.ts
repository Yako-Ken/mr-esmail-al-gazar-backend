// Notification Service — persistent store + realtime delivery
// Handles: save to DB → emit via Socket.IO → optionally push via FCM when ready
import { PrismaClient } from '@prisma/client';
import { getIO } from '../socket';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

export type NotificationType =
  | 'lesson_new'          // new lesson/course published
  | 'payment_approved'    // teacher/admin approved student's payment
  | 'payment_rejected'    // payment rejected with reason
  | 'grade_posted'        // quiz/essay graded
  | 'attendance_reminder' // attendance required today
  | 'announcement'        // admin broadcast to all
  | 'parent_weekly_report';// weekly digest for parents

interface NotificationPayload {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export class NotificationService {
  /**
   * Create + persist + broadcast a notification.
   * Fire-and-forget — never throws (silent fail).
   */
  static async sendToUser({
    userId,
    type,
    title,
    body,
    data,
  }: NotificationPayload): Promise<void> {
    try {
      // 1. Persist to DB
      const notification = await prisma.notification.create({
        data: {
          userId,
          type,
          title,
          body,
          data: data ? JSON.stringify(data) : undefined,
        },
      });

      // 2. Real-time emit via Socket.IO
      const io = getIO();
      if (io) {
        io.to(`user_${userId}`).emit('notification', {
          id: notification.id,
          type,
          title,
          body,
          data,
          createdAt: notification.createdAt.toISOString(),
          isRead: false,
        });
      }

      logger.info(`[notify] ${type} sent to ${userId}: ${title}`);
    } catch (err) {
      logger.error(`[notify] Failed to send ${type} to ${userId}:`, err);
      // Silently fail — notifications must never break the main flow
    }
  }

  /**
   * Broadcast to ALL users with a role (e.g. all students)
   */
  static async broadcastToRole(
    role: string,
    payload: Omit<NotificationPayload, 'userId'>,
  ): Promise<number> {
    const users = await prisma.user.findMany({
      where: { role, status: 'active' },
      select: { id: true },
    });

    let sent = 0;
    for (const u of users) {
      await this.sendToUser({ ...payload, userId: u.id });
      sent++;
    }
    logger.info(`[notify] broadcast ${payload.type} → ${sent} users (${role})`);
    return sent;
  }

  /**
   * Get user's notifications (paginated)
   */
  static async getForUser(userId: string, unreadOnly = false, limit = 50) {
    return prisma.notification.findMany({
      where: {
        userId,
        ...(unreadOnly ? { isRead: false } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Mark one as read
   */
  static async markRead(userId: string, notificationId: string) {
    return prisma.notification.updateMany({
      where: { id: notificationId, userId }, // security: user can only mark own
      data: { isRead: true },
    });
  }

  /**
   * Mark all as read
   */
  static async markAllRead(userId: string) {
    return prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
  }

  /**
   * Store or update FCM token for a user (+platform)
   */
  static async registerPushToken(
    userId: string,
    token: string,
    platform: 'android' | 'ios',
  ) {
    return prisma.pushToken.upsert({
      where: { userId_token: { userId, token } },
      update: { active: true, updatedAt: new Date() },
      create: { userId, token, platform },
    });
  }
}
