import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const SUPER_ADMIN_PHONE = '01094270799';
const SUPER_ADMIN_PASSWORD = 'Ahmed1448';

async function main() {
  console.log('🌱 Starting database seeding...');

  try {
    // 1. إنشاء أو التأكد من وجود الـ Super Admin
    console.log('--- Checking Super Admin ---');
    const hashedPassword = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 10);
    const superAdmin = await prisma.user.upsert({
      where: { phone: SUPER_ADMIN_PHONE },
      update: {},
      create: {
        id: 'admin_001',
        name: 'Super Admin',
        phone: SUPER_ADMIN_PHONE,
        password: hashedPassword,
        role: 'SUPER_ADMIN',
        isApproved: true,
        isVerified: true,
      },
    });
    console.log('✅ Super Admin ready. ID:', superAdmin.id);

    console.log('\n✨ Seeding completed successfully!');

  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();