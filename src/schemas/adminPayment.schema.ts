import { z } from 'zod';

export const listPaymentsQuerySchema = z
  .object({
    status: z.enum(['PENDING', 'PAID', 'FAILED', 'ALL']).default('ALL'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export const initiateRefundSchema = z
  .object({
    reason: z.string().trim().min(4).max(500),
  })
  .strict();

export const listAuditEventsQuerySchema = z
  .object({
    category: z.enum(['finance', 'content', 'attendance', 'security', 'ALL']).default('ALL'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  })
  .strict();

export type InitiateRefundInput = z.infer<typeof initiateRefundSchema>;
