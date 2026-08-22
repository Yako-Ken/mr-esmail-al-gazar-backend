import { z } from 'zod';

const password = z.string().min(1).max(128);

export const exportAccountDataSchema = z.object({
  password,
}).strict();

export const requestAccountDeletionSchema = z.object({
  password,
  reason: z.string().trim().max(500).optional(),
}).strict();

export const cancelAccountDeletionSchema = z.object({
  password,
}).strict();
