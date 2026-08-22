import { z } from 'zod';

export const linkChildSchema = z.object({
  studentPhone: z.string().trim().regex(/^01[0125]\d{8}$/, 'A valid Egyptian student phone is required'),
  code: z.string().trim().toUpperCase().regex(/^[A-HJ-NP-Z2-9]{8}$/, 'The link code must contain 8 valid characters'),
});
