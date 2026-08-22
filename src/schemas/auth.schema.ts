import { z } from 'zod';

export const loginSchema = z.object({
  identifier: z.string().trim().min(1).optional(),
  phone: z.string().trim().min(1).optional(),
  email: z.string().trim().min(1).optional(),
  password: z.string().min(1, 'Password is required'),
}).refine((data) => data.identifier || data.phone || data.email, {
  message: 'Identifier (phone/email) is required',
  path: ['identifier'],
});

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters'),
  phone: z.string().trim().regex(/^01[0125]\d{8}$/, 'Phone must be a valid Egyptian mobile number'),
  email: z.string().trim().email('A valid email is required').max(254),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  // Public registration is intentionally limited to customer roles. Teachers,
  // assistants and administrators are provisioned by an authenticated admin.
  role: z.enum(['STUDENT', 'PARENT']).default('STUDENT'),
  parentPhone: z.string().trim().regex(/^01[0125]\d{8}$/).optional(),
  deviceId: z.string().trim().max(200).optional(),
});

export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, 'Old password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

// `studentPhone` remains as a temporary compatibility alias for installed demo
// builds. The server ignores caller-supplied email/parent details and always
// sends to the verified email stored on the matched account.
export const forgotPasswordRequestSchema = z.object({
  identifier: z.string().trim().min(3).max(254).optional(),
  studentPhone: z.string().trim().min(8).max(20).optional(),
}).refine((data) => data.identifier || data.studentPhone, {
  message: 'Phone or email is required',
  path: ['identifier'],
});

export const verifyOtpSchema = z.object({
  identifier: z.string().trim().min(3).max(254).optional(),
  studentPhone: z.string().trim().min(8).max(20).optional(),
  otp: z.string().trim().regex(/^\d{6}$/, 'OTP must be 6 digits'),
}).refine((data) => data.identifier || data.studentPhone, {
  message: 'Phone or email is required',
  path: ['identifier'],
});

export const resetPasswordSchema = z.object({
  identifier: z.string().trim().min(3).max(254).optional(),
  studentPhone: z.string().trim().min(8).max(20).optional(),
  resetToken: z.string().trim().length(64, 'Invalid reset token'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
}).refine((data) => data.identifier || data.studentPhone, {
  message: 'Phone or email is required',
  path: ['identifier'],
});

export const requestOtpSchema = z.object({
  phone: z.string().trim().min(8, 'Phone number is required'),
});

// Placeholder (WhatsApp) OTP schema. NOTE: the corresponding routes in
// whatsapp.routes.ts are DISABLED until a real SMS/WhatsApp provider is wired.
// If those routes are re-enabled, `code` must be a 6-digit string and the
// verify handler must validate it against a server-side stored OTP (it currently
// accepts ANY 4-digit code — that backdoor must not ship).
export const placeholderOtpVerifySchema = z.object({
  phone: z.string().trim().min(8, 'Phone number is required'),
  code: z.string().trim().length(6, 'OTP must be 6 digits'),
});
