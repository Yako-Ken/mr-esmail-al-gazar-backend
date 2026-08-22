import { z } from 'zod';

export const checkoutIntentionSchema = z.object({
  courseId: z.string().uuid().or(z.string().regex(/^demo_course_\d+$/)),
  idempotencyKey: z.string().trim().min(16).max(128),
  channel: z.enum(['WEB', 'DIRECT_APK']),
});
