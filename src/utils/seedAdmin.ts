import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { logger } from './logger';
import { maskPhone } from './redact';

import prisma from '../config/prisma';

/**
 * Bootstrap an administrator when the operator provides credentials through the environment.
 * Accepts either an existing bcrypt hash or a plaintext password that is securely hashed automatically.
 */
export const seedSuperAdmin = async (): Promise<void> => {
  const adminPhone = process.env.SUPER_ADMIN_PHONE?.trim();
  const adminEmail = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const passwordInput = process.env.SUPER_ADMIN_PASSWORD_HASH?.trim() || process.env.SUPER_ADMIN_PASSWORD?.trim();

  if (!adminPhone || !passwordInput) {
    logger.info('Super Admin bootstrap skipped: credentials are not configured.');
    return;
  }

  const passwordHash = /^\$2[aby]\$\d{2}\$/.test(passwordInput)
    ? passwordInput
    : await bcrypt.hash(passwordInput, 10);

  try {
    const existingAdmin = await prisma.user.findFirst({
      where: { phone: adminPhone },
    });

    if (existingAdmin) {
      logger.info(`Super Admin account exists: ${maskPhone(existingAdmin.phone)}`);
      return;
    }

    const admin = await prisma.user.create({
      data: {
        name: 'Super Admin',
        phone: adminPhone,
        email: adminEmail || null,
        password: passwordHash,
        role: 'SUPER_ADMIN',
        isApproved: true,
        isVerified: true,
        status: 'approved',
        permissions: '["ALL"]',
      },
    });

    // Never log the hash, a plaintext password, or the phone number.
    logger.info(`Super Admin created: ${maskPhone(admin.phone)}`);
  } catch (error) {
    logger.error('Error seeding Super Admin:', error);
  }
};
