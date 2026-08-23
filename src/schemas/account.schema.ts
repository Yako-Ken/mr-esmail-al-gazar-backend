import { z } from 'zod';

const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Use HH:MM 24-hour format');

export const updatePreferencesSchema = z
  .object({
    analyticsConsent: z.boolean().optional(),
    productMessagesConsent: z.boolean().optional(),
    notifLessons: z.boolean().optional(),
    notifHomework: z.boolean().optional(),
    notifAttendance: z.boolean().optional(),
    notifPayments: z.boolean().optional(),
    notifProduct: z.boolean().optional(),
    quietHoursEnabled: z.boolean().optional(),
    quietHoursStart: hhmm.optional(),
    quietHoursEnd: hhmm.optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    'At least one preference must be provided',
  );

export const createSupportTicketSchema = z
  .object({
    subject: z.string().trim().min(4).max(150),
    details: z.string().trim().min(12).max(4000),
  })
  .strict();

export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;
export type CreateSupportTicketInput = z.infer<typeof createSupportTicketSchema>;
