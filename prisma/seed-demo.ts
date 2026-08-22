// Demo seed for the client trial — creates realistic, "alive" data:
// approved teacher, student with progress/grades, linked parent, courses,
// playable lessons (public sample MP4s — Bunny keys are rotated separately),
// quizzes, one PENDING payment the teacher can approve live during the demo.
//
// Run: npx ts-node prisma/seed-demo.ts   (idempotent — safe to re-run)
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const DEMO_PASSWORD = 'Demo@2026';
// Public base URL for demo videos. Keep media off the API host so playback does
// not consume the developer machine's upload bandwidth during a client trial.
// DEMO_BASE_URL remains as a backwards-compatible fallback for local demos.
const DEMO_MEDIA_BASE_URL =
  process.env.DEMO_MEDIA_BASE_URL ||
  process.env.DEMO_BASE_URL ||
  'http://localhost:5000/uploads/videos';
// Verified MP4 demo lessons (~66 MB total).
const SAMPLE_VIDEOS = [
  `${DEMO_MEDIA_BASE_URL}/video-1777567229015-645016372.mp4`, // 38MB full lesson
  `${DEMO_MEDIA_BASE_URL}/video-1777628891729-707303113.mp4`, // 8MB
  `${DEMO_MEDIA_BASE_URL}/video-1777657098684-786189401.mp4`, // 8MB
  `${DEMO_MEDIA_BASE_URL}/video-1777567304429-726181964.mp4`, // 2MB
  `${DEMO_MEDIA_BASE_URL}/video-1777628852744-747148463.mp4`, // 2MB
  `${DEMO_MEDIA_BASE_URL}/video-1777640184317-24406717.mp4`,  // 2MB
];

function quiz(questions: Array<{ q: string; opts: string[]; correct: number }>) {
  return JSON.stringify({
    questions: questions.map((x) => ({
      question: x.q,
      options: x.opts,
      correctIndex: x.correct,
      points: 5,
      type: 'mcq',
    })),
  });
}

async function upsertUser(data: {
  id: string;
  name: string;
  phone: string;
  role: string;
  extra?: Record<string, unknown>;
}) {
  const password = await bcrypt.hash(DEMO_PASSWORD, 10);
  // Force demo credentials on every run so stale users (e.g. an old teacher
  // record from before this seed) can't lock the demo accounts.
  return prisma.user.upsert({
    where: { phone: data.phone },
    update: {
      name: data.name,
      password,
      role: data.role,
      status: 'approved',
      isApproved: true,
      isVerified: true,
      ...data.extra,
    },
    create: {
      id: data.id,
      name: data.name,
      phone: data.phone,
      password,
      role: data.role,
      status: 'approved',
      isApproved: true,
      isVerified: true,
      ...data.extra,
    },
  });
}

async function main() {
  console.log('🌱 Seeding DEMO data for client trial...');

  const teacher = await upsertUser({
    id: 'demo_teacher_001',
    name: 'أ. إسماعيل الجزار',
    phone: '01000000001',
    role: 'TEACHER',
    extra: {
      email: 'teacher@demo.elgazar',
      vodafoneCashNumber: '01000000001',
      instapayHandle: 'esmailelgazar@instapay',
    },
  });

  const student = await upsertUser({
    id: 'demo_student_001',
    name: 'أحمد محمد',
    phone: '01000000002',
    role: 'STUDENT',
    extra: { email: 'student@demo.elgazar', parentPhone: '01000000003' },
  });

  const parent = await upsertUser({
    id: 'demo_parent_001',
    name: 'محمد أحمد (ولي الأمر)',
    phone: '01000000003',
    role: 'PARENT',
    extra: { email: 'parent@demo.elgazar' },
  });

  await upsertUser({
    id: 'demo_admin_001',
    name: 'إدارة Esmail ElGazar',
    phone: '01000000004',
    role: 'SUPER_ADMIN',
    extra: { email: 'admin@demo.elgazar' },
  });

  // Link parent ↔ student
  await prisma.studentParentRelation.upsert({
    where: { studentId_parentId: { studentId: student.id, parentId: parent.id } },
    update: {},
    create: { studentId: student.id, parentId: parent.id },
  });

  const coursesData = [
    {
      id: 'demo_course_001',
      title: 'أساسيات القواعد الإنجليزية',
      description: 'كورس متكامل يشرح قواعد اللغة الإنجليزية من الصفر بشكل مبسط مع أمثلة وتمارين.',
      subject: 'اللغة الإنجليزية',
      grade: 'الصف الأول الثانوي',
      price: 300,
      lessons: [
        { title: 'مقدمة: أزاي تتعلم إنجليزي صح؟', video: 0 },
        { title: 'الأزمنة — المضارع البسيط', video: 1 },
        { title: 'الأزمنة — الماضي البسيط', video: 2 },
      ],
    },
    {
      id: 'demo_course_002',
      title: 'محادثة إنجليزية للمبتدئين',
      description: 'تدريب عملي على المحادثة: مواقف يومية حقيقية وجُمل جاهزة للاستخدام.',
      subject: 'اللغة الإنجليزية',
      grade: 'الصف الثاني الإعدادي',
      price: 250,
      lessons: [
        { title: 'التعريف بالنفس — Introducing Yourself', video: 3 },
        { title: 'في المطعم — At the Restaurant', video: 4 },
      ],
    },
    {
      id: 'demo_course_003',
      title: 'مراجعة نهائية — إنجليزي ثانوية عامة',
      description: 'مراجعة مكثفة على أهم نقاط المنهج قبل الامتحان مع نماذج أسئلة محلولة.',
      subject: 'اللغة الإنجليزية',
      grade: 'الصف الثالث الثانوي',
      price: 400,
      lessons: [{ title: 'أهم 50 سؤال في القواعد', video: 5 }],
    },
  ];

  const createdLessons: Array<{ id: string; courseId: string }> = [];

  for (const c of coursesData) {
    await prisma.course.upsert({
      where: { id: c.id },
      update: {
        price: c.price,
        priceMinor: c.price * 100,
        currency: 'EGP',
        isPublished: true,
        publishedAt: new Date(),
      },
      create: {
        id: c.id,
        teacherId: teacher.id,
        title: c.title,
        description: c.description,
        subject: c.subject,
        grade: c.grade,
        price: c.price,
        priceMinor: c.price * 100,
        currency: 'EGP',
        isPublished: true,
        publishedAt: new Date(),
      },
    });

    for (let i = 0; i < c.lessons.length; i++) {
      const l = c.lessons[i];
      const lessonId = `demo_lesson_${c.id.slice(-3)}_${i + 1}`;
      await prisma.lesson.upsert({
        where: { id: lessonId },
        update: { videoUrl: SAMPLE_VIDEOS[l.video] },
        create: {
          id: lessonId,
          courseId: c.id,
          teacherId: teacher.id,
          title: l.title,
          subject: c.subject,
          grade: c.grade,
          description: `شرح تفصيلي مع أمثلة عملية على: ${l.title}`,
          videoUrl: SAMPLE_VIDEOS[l.video],
        },
      });
      createdLessons.push({ id: lessonId, courseId: c.id });

      // One quiz per lesson (first two lessons of each course)
      if (i < 2) {
        await prisma.quiz.upsert({
          where: { id: `demo_quiz_${lessonId}` },
          update: {},
          create: {
            id: `demo_quiz_${lessonId}`,
            lessonId,
            questions: quiz([
              {
                q: `سؤال 1 على «${l.title}» — إيه الاجابة الصح؟`,
                opts: ['الاختيار الأول', 'الاختيار الثاني', 'الاختيار الثالث', 'الاختيار الرابع'],
                correct: 1,
              },
              {
                q: `سؤال 2 على «${l.title}» — كمّل الجملة الصح:`,
                opts: ['كذا', 'كده', 'الاثنين صح', 'ولا واحد'],
                correct: 2,
              },
            ]),
          },
        });
      }
    }
  }

  // Enrollments: APPROVED in courses 1+2 (student sees content),
  // PENDING in course 3 → teacher approves it live during the demo.
  for (const [courseId, status] of [
    ['demo_course_001', 'APPROVED'],
    ['demo_course_002', 'APPROVED'],
    ['demo_course_003', 'PENDING'],
  ] as const) {
    await prisma.courseEnrollment.upsert({
      where: { studentId_courseId: { studentId: student.id, courseId } },
      update: { status },
      create: {
        studentId: student.id,
        courseId,
        paymentMethod: 'vodafone_cash',
        status,
      },
    });
  }

  // Progress + grades so dashboards look alive
  const course1Lessons = createdLessons.filter((l) => l.courseId === 'demo_course_001');
  for (let i = 0; i < course1Lessons.length; i++) {
    const l = course1Lessons[i];
    const done = i < 2; // first two completed, third at 40%
    await prisma.lessonProgress.upsert({
      where: { studentId_lessonId: { studentId: student.id, lessonId: l.id } },
      update: {},
      create: {
        studentId: student.id,
        lessonId: l.id,
        courseId: l.courseId,
        watchPercentage: done ? 100 : 40,
        isCompleted: done,
      },
    });
    await prisma.tracking.upsert({
      where: { studentId_lessonId: { studentId: student.id, lessonId: l.id } },
      update: {},
      create: {
        studentId: student.id,
        lessonId: l.id,
        isPresent: true,
        hwStatus: i === 0 ? 'GRADED' : i === 1 ? 'SUBMITTED' : 'NOT_SUBMITTED',
        quizScore: i === 0 ? 90 : i === 1 ? 75 : null,
      },
    });
  }

  // Notifications for student + parent
  const notifs = [
    {
      id: 'demo_notification_lesson_001',
      userId: student.id,
      type: 'lesson_new',
      title: 'درس جديد أُضيف',
      body: 'تمت إضافة «الأزمنة — الماضي البسيط» إلى كورس أساسيات القواعد.',
      data: JSON.stringify({ lessonId: course1Lessons[2]?.id }),
    },
    {
      id: 'demo_notification_grade_001',
      userId: student.id,
      type: 'grade_posted',
      title: 'نتيجة اختبار جاهزة',
      body: 'درجتك في اختبار «مقدمة: أزاي تتعلم إنجليزي صح؟» هي 90%.',
      data: JSON.stringify({ lessonId: course1Lessons[0]?.id }),
    },
    {
      id: 'demo_notification_parent_001',
      userId: parent.id,
      type: 'announcement',
      title: 'تقرير الأسبوع',
      body: 'ابنك أحمد أكمل درسين هذا الأسبوع بمتوسط درجات 82%.',
      data: null,
    },
  ];
  for (const n of notifs) {
    await prisma.notification.upsert({
      where: { id: n.id },
      update: n,
      create: n,
    });
  }

  console.log('✅ Demo data ready:');
  console.log('   معلم:  01000000001 / Demo@2026');
  console.log('   طالب:  01000000002 / Demo@2026');
  console.log('   ولي أمر: 01000000003 / Demo@2026');
  console.log('   إدارة:  01000000004 / Demo@2026');
  console.log(`   ${coursesData.length} كورسات، ${createdLessons.length} دروس، اختبارات، تقدم ودرجات`);
}

main()
  .catch((e) => {
    console.error('❌ Demo seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
