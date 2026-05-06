import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const SUPER_ADMIN_PHONE = '01094270799';
const SUPER_ADMIN_PASSWORD = 'Ahmed1448';

// ⚠️ IMPORTANT: Replace with your actual teacher ID from Prisma Studio
// Run: npx prisma studio (look at User table, copy a teacher's ID)
const TEACHER_ID = 'PASTE_YOUR_TEACHER_ID_HERE';

const EGYPTIAN_SUBJECTS = [
  { name: 'اللغة العربية', code: 'ARB' },
  { name: 'اللغة الإنجليزية', code: 'ENG' },
  { name: 'اللغة الفرنسية', code: 'FRA' },
  { name: 'الرياضيات', code: 'MATH' },
  { name: 'الفيزياء', code: 'PHY' },
  { name: 'الكيمياء', code: 'CHEM' },
  { name: 'الأحياء', code: 'BIO' },
  { name: 'التاريخ', code: 'HIST' },
  { name: 'الجغرافيا', code: 'GEO' },
  { name: 'الفلسفة والمنطق', code: 'PHIL' },
  { name: 'التربية الوطنيه', code: 'NAT' },
  { name: 'التربية الفنية', code: 'ART' },
  { name: 'التربية الدينية', code: 'REL' },
  { name: 'الكمبيوتر', code: 'COMP' },
];

async function main() {
  console.log('🌱 Starting database seeding...');
  
  // Validate teacher ID
  if (TEACHER_ID === 'PASTE_YOUR_TEACHER_ID_HERE') {
    console.error('\n❌ ERROR: Please edit prisma/seed.ts');
    console.error('   1. Run: npx prisma studio');
    console.error('   2. Find your teacher user and copy the ID');
    console.error('   3. Replace TEACHER_ID on line 9\n');
    process.exit(1);
  }

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

    // 2. إنشاء مدرس افتراضي آلياً (عشان نربط بيه المواد)
    console.log('\n--- Checking Default Teacher ---');
    const teacherPassword = await bcrypt.hash('teacher123', 10);
    const defaultTeacher = await prisma.user.upsert({
      where: { phone: '01000000001' }, // رقم المدرس الافتراضي
      update: {},
      create: {
        id: 'teacher_default_001',
        name: 'Teacher Default',
        phone: '01000000001',
        password: teacherPassword,
        role: 'TEACHER',
        isApproved: true,
        isVerified: true,
      },
    });
    console.log('✅ Teacher ready. ID:', defaultTeacher.id);

    // 3. إضافة المواد الدراسية وربطها بالمدرس المحدد
    console.log('\n📚 Seeding Egyptian High School Subjects...');
    
    // Use provided teacher ID, or fallback to default teacher
    const teacherIdToUse = (await prisma.user.findUnique({ where: { id: TEACHER_ID } }))
      ? TEACHER_ID 
      : defaultTeacher.id;
    
    console.log(`   Using teacher ID: ${teacherIdToUse}`);

    for (const subject of EGYPTIAN_SUBJECTS) {
      await prisma.subject.upsert({
        where: { code: subject.code },
        update: {},
        create: {
          id: `subject_${subject.code.toLowerCase()}`,
          name: subject.name,
          code: subject.code,
          teacherId: teacherIdToUse,
        },
      });
      console.log(` ✅ Ready: ${subject.name} (${subject.code})`);
    }

    console.log('\n✨ Seeding completed successfully!');

  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();