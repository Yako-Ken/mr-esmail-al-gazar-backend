import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config();

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const phone = process.env.SUPER_ADMIN_PHONE?.trim();
  const email = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const passwordHash = process.env.SUPER_ADMIN_PASSWORD_HASH?.trim();

  if (!phone || !passwordHash) {
    console.log('Super Admin seed skipped: credentials are not configured.');
    return;
  }

  if (!/^\$2[aby]\$\d{2}\$/.test(passwordHash)) {
    throw new Error('SUPER_ADMIN_PASSWORD_HASH must be a bcrypt hash.');
  }

  await prisma.user.upsert({
    where: { phone },
    update: {},
    create: {
      name: 'Super Admin',
      phone,
      email: email || null,
      password: passwordHash,
      role: 'SUPER_ADMIN',
      status: 'approved',
      isApproved: true,
      isVerified: true,
      permissions: '["ALL"]',
    },
  });

  console.log(`Super Admin seed complete: ${phone}`);
}

main()
  .catch((error) => {
    console.error('Seeding failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
