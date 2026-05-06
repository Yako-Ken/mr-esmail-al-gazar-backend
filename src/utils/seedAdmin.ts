import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

export const seedSuperAdmin = async () => {
  try {
    const adminPhone = '01094270799';
    const adminEmail = 'admin@lms.com';
    const adminPassword = await bcrypt.hash('Ahmed1448', 10);

    const existingAdmin = await prisma.user.findFirst({
      where: { role: 'SUPER_ADMIN' },
    });

    if (!existingAdmin) {
      console.log('🌱 Super Admin not found. Creating default admin account...');
      
      const admin = await prisma.user.create({
        data: {
          name: 'Super Admin',
          phone: adminPhone,
          email: adminEmail,
          password: adminPassword,
          role: 'SUPER_ADMIN',
          isApproved: true,
          isVerified: true,
          permissions: '["ALL"]',
        },
      });
      
      console.log(`✅ Super Admin created! Phone: ${admin.phone}, Email: ${adminEmail}, Password: Ahmed1448`);
    } else {
      console.log('✅ Super Admin account exists. Verifying identifiers...');
      // Logic to update the existing admin if it is missing phone or email
      if (existingAdmin.phone !== adminPhone || existingAdmin.email !== adminEmail) {
        await prisma.user.update({
          where: { id: existingAdmin.id },
          data: {
            phone: adminPhone,
            email: adminEmail,
            // We can also reset password here if requested, but let's just update the identifier
          }
        });
        console.log(`✅ Super Admin updated to ensure Phone: ${adminPhone} and Email: ${adminEmail}`);
      } else {
        console.log(`✅ Super Admin identifiers are correct.`);
      }
    }
  } catch (error) {
    console.error('❌ Error seeding Super Admin:', error);
  }
};
