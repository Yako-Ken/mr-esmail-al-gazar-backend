import { z } from 'zod';

export const homeworkSubmissionSchema = z.object({
  answer: z.string().trim().min(1, 'Answer is required').max(10_000, 'Answer is too long'),
});
