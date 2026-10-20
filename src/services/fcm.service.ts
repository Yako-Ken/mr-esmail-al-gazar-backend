// FCM Service — decides *whether* and *to whom* to push, then retires dead tokens.
//
// Contract with the rest of the backend:
//   - `pushToUser` never throws and never rejects. A notification write that
//     already succeeded in the DB must stay succeeded even if Google is down,
//     the service account was revoked, or the network is gone.
//   - it is expected to be called without `await` (fire-and-forget) so a slow
//     push cannot add latency to posting a grade, approving a payment, etc.
import { PrismaClient } from '@prisma/client';
import { readFcmConfig, sendHttpV1 } from '../utils/fcm';
import { logger } from '../utils/logger';

import prisma from '../config/prisma';

export interface FcmPushPayload {
  /** Stored on the notification so the client can deep-link from a push. */
  notificationId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export class FcmService {
  /**
   * Pushes to every active device of one user.
   *
   * Tokens reported `UNREGISTERED` are deactivated rather than deleted, so the
   * history stays auditable and a re-registration (same user, same device) can
   * reactivate the row via the existing upsert.
   */
  static async pushToUser(
    userId: string,
    payload: FcmPushPayload,
  ): Promise<void> {
    try {
      const config = readFcmConfig();
      // Disabled or incomplete config is the expected state in dev/CI.
      if (!config) return;

      const devices = await prisma.pushToken.findMany({
        where: { userId, active: true },
        select: { id: true, token: true },
      });
      if (devices.length === 0) return;

      let delivered = 0;
      const retiredIds: string[] = [];

      // Sequential on purpose: a user has one or two devices, and FCM HTTP v1
      // has no multicast endpoint, so a fan-out would only risk rate limits.
      for (const device of devices) {
        const result = await sendHttpV1(config, device.token, {
          title: payload.title,
          body: payload.body,
          data: {
            ...(payload.data ?? {}),
            notificationId: payload.notificationId,
            type: payload.type,
          },
        });

        if (result.ok) {
          delivered++;
        } else if (result.unregistered) {
          retiredIds.push(device.id);
        }
      }

      if (retiredIds.length > 0) {
        await prisma.pushToken.updateMany({
          where: { id: { in: retiredIds } },
          data: { active: false },
        });
      }

      // Counts and the notification type only — no token, no error body.
      logger.info(
        `[fcm] ${payload.type} → ${userId}: delivered=${delivered} ` +
          `retired=${retiredIds.length} devices=${devices.length}`,
      );
    } catch (err) {
      // Nothing above is allowed to escape. Log a short, safe reason so an FCM
      // outage is visible, but never the axios payload that could hold a token.
      const reason = err instanceof Error ? err.name : 'unknown';
      logger.warn(`[fcm] push skipped (${reason}) — notification write unaffected`);
    }
  }
}