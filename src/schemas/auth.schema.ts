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
  phone: z.string().trim().min(8, 'Phone must be a valid phone number'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: z.enum(['STUDENT', 'TEACHER', 'PARENT', 'ADMIN']).optional(),
  parentPhone: z.string().trim().optional(),
  deviceId: z.string().trim().optional(),
});

export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, 'Old password is required'),
  newPassword: z.string().min(6, 'New password must be at least 6 characters'),
});

export const forgotPasswordRequestSchema = z.object({
  studentPhone: z.string().trim().min(8),
  parentPhone: z.string().trim().min(8),
  email: z.string().trim().email('A valid email is required'),
});

export const verifyOtpSchema = z.object({
  studentPhone: z.string().trim().min(8),
  otp: z.string().trim().length(6, 'OTP must be 6 digits'),
});

export const resetPasswordSchema = z.object({
  studentPhone: z.string().trim().min(8),
  resetToken: z.string().trim().min(1),
  newPassword: z.string().min(6, 'New password must be at least 6 characters'),
});

export const requestOtpSchema = z.object({
  phone: z.string().trim().min(8, 'Phone number is required'),
});
