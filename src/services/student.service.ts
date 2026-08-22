import { PrismaClient } from '@prisma/client';
import { AuthUser } from '../middlewares/auth.middleware';
import { resolveOwnerId } from '../utils/ownerId';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/appError';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

const assertStudent = (authUser: AuthUser | undefined, message: string): AuthUser => {
  if (!authUser || authUser.role !== 'STUDENT') {
    throw new ForbiddenError(message);
  }
  return authUser;
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/students/my-dashboard
// ─────────────────────────────────────────────────────────────────────────────
export const getStudentDashboard = async (authUser: AuthUser | undefined) => {
  assertStudent(authUser, 'Access denied. Students only.');
  const studentId = authUser!.id;

  // Previously read from the legacy Subject/Enrollment tables, which nothing in
  // the app ever wrote to - this always returned an empty dashboard. Course/
  // CourseEnrollment is the system actually used for enrollment everywhere else
  // (teacher.routes.ts, tracking.routes.ts, enrollment.controller.ts).
  const courseEnrollments = await prisma.courseEnrollment.findMany({
    where: { studentId, status: 'APPROVED' },
    include: {
      course: {
        include: {
          teacher: { select: { id: true, name: true } },
          lessons: {
            select: { id: true, title: true, thumbnailUrl: true },
          },
        },
      },
    },
  });

  let totalLessons = 0;
  let completedLessons = 0;
  let watchedHours = 0;

  const enrolledCourses = await Promise.all(
    courseEnrollments.map(async (enrollment) => {
      const course = enrollment.course;
      const lessons = course.lessons || [];
      const courseTotalLessons = lessons.length;

      const trackingRecords = await prisma.tracking.findMany({
        where: {
          studentId,
          lesson: { courseId: course.id },
          isPresent: true,
        },
      });

      const completedCount = trackingRecords.length;
      totalLessons += courseTotalLessons;
      completedLessons += completedCount;

      const progress = courseTotalLessons > 0
        ? Math.round((completedCount / courseTotalLessons) * 100)
        : 0;

      watchedHours += completedCount * 0.5;

      return {
        id: course.id,
        name: course.title,
        code: course.id,
        teacherName: course.teacher?.name || 'Unknown',
        totalLessons: courseTotalLessons,
        completedLessons: completedCount,
        progress: progress,
        thumbnailUrl: lessons[0]?.thumbnailUrl,
      };
    })
  );

  const overallProgress = totalLessons > 0
    ? Math.round((completedLessons / totalLessons) * 100)
    : 0;

  return {
    student: {
      id: studentId,
      name: (authUser as any).name || 'Student',
    },
    dashboard: {
      enrolledCourses,
      stats: {
        totalEnrolled: enrolledCourses.length,
        totalLessons,
        completedLessons,
        overallProgress,
        watchedHours: Math.round(watchedHours * 10) / 10,
      },
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/students/weekly-progress
// ─────────────────────────────────────────────────────────────────────────────
export const getWeeklyProgress = async (authUser: AuthUser | undefined) => {
  assertStudent(authUser, 'Access denied. Students only.');
  const studentId = authUser!.id;

  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const weeklyGoalHours = 10;

  const weeklyTrackings = await prisma.tracking.findMany({
    where: {
      studentId,
      isPresent: true,
      createdAt: {
        gte: startOfWeek,
      },
    },
  });

  const watchedHoursThisWeek = Math.round(weeklyTrackings.length * 0.5 * 10) / 10;
  const progressPercentage = Math.min(
    Math.round((watchedHoursThisWeek / weeklyGoalHours) * 100),
    100
  );

  return {
    watchedHours: watchedHoursThisWeek,
    weeklyGoal: weeklyGoalHours,
    progressPercentage,
    remainingHours: Math.max(0, weeklyGoalHours - watchedHoursThisWeek),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/students/recent-lessons
// ─────────────────────────────────────────────────────────────────────────────
export const getRecentLessons = async (authUser: AuthUser | undefined) => {
  assertStudent(authUser, 'Students only');
  const studentId = authUser!.id;

  const enrollments = await prisma.courseEnrollment.findMany({
    where: { studentId, status: 'APPROVED' },
    select: { courseId: true },
  });

  const courseIds = enrollments.map((e) => e.courseId).filter((id): id is string => id !== null);

  const lessons = await prisma.lesson.findMany({
    where: { courseId: { in: courseIds } },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: {
      teacher: { select: { id: true, name: true } },
    },
  });

  return lessons;
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/teachers/students
// Returns all unique students enrolled in any of the teacher's courses
// ─────────────────────────────────────────────────────────────────────────────
export const getTeacherStudents = async (authUser: AuthUser) => {
  const ownerId = resolveOwnerId(authUser);

  // Fetch ALL students
  const allStudents = await prisma.user.findMany({
    where: { role: 'STUDENT' },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
    },
    orderBy: { name: 'asc' },
  });

  // Fetch enrollments for these students in THIS teacher's courses
  const teacherEnrollments = await prisma.courseEnrollment.findMany({
    where: {
      course: { teacherId: ownerId },
      status: 'APPROVED',
    },
    select: {
      studentId: true,
      course: {
        select: {
          id: true,
          title: true,
        },
      },
    },
  });

  // Get parent relations for student parent phones
  const studentIds = allStudents.map(s => s.id);
  const parentRelations = await prisma.studentParentRelation.findMany({
    where: { studentId: { in: studentIds } },
    include: {
      parent: {
        select: { phone: true },
      },
    },
  });

  // Map studentId -> parentPhone
  const parentPhoneMap = new Map<string, string>();
  for (const rel of parentRelations) {
    if (rel.parent?.phone) {
      parentPhoneMap.set(rel.studentId, rel.parent.phone);
    }
  }

  // Map studentId -> courses
  const studentCoursesMap = new Map<string, { id: string; title: string }[]>();
  for (const e of teacherEnrollments) {
    if (!studentCoursesMap.has(e.studentId)) {
      studentCoursesMap.set(e.studentId, []);
    }
    studentCoursesMap.get(e.studentId)!.push({
      id: e.course.id,
      title: e.course.title,
    });
  }

  // Combine
  const result = allStudents.map(s => ({
    id: s.id,
    name: s.name,
    phone: s.phone,
    email: s.email,
    parentPhone: parentPhoneMap.get(s.id) || null,
    courses: studentCoursesMap.get(s.id) || [],
  }));

  logger.info('All students for teacher:', { total: result.length, ownerId });
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/teachers/students/:studentId/courses/:courseId/remove
// Removes a student from a specific course
// ─────────────────────────────────────────────────────────────────────────────
export const removeStudentEnrollment = async (
  authUser: AuthUser,
  studentId: string,
  courseId: string
) => {
  const ownerId = resolveOwnerId(authUser);

  const course = await prisma.course.findFirst({
    where: { id: courseId, teacherId: ownerId },
  });

  if (!course) {
    throw new ForbiddenError('Course not found or forbidden');
  }

  const enrollment = await prisma.courseEnrollment.findFirst({
    where: { studentId, courseId },
  });

  if (!enrollment) {
    throw new NotFoundError('Enrollment not found');
  }

  await prisma.courseEnrollment.delete({ where: { id: enrollment.id } });
  logger.info('Student removed from course:', { studentId, courseId, by: authUser.id });
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/teachers/courses - Returns courses for grading
// ─────────────────────────────────────────────────────────────────────────────
export const getTeacherCoursesForGrading = async (authUser: AuthUser) => {
  const ownerId = resolveOwnerId(authUser);

  const courses = await prisma.course.findMany({
    where: { teacherId: ownerId },
    select: {
      id: true,
      title: true,
      thumbnailUrl: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  // Get student count per course
  const coursesWithCount = await Promise.all(
    courses.map(async (course) => {
      const count = await prisma.courseEnrollment.count({
        where: { courseId: course.id, status: 'APPROVED' },
      });
      return { ...course, studentsCount: count };
    })
  );

  return coursesWithCount;
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/teachers/courses/:courseId/assignments
// Returns lessons with homework for a course
// ─────────────────────────────────────────────────────────────────────────────
export const getCourseAssignments = async (authUser: AuthUser, courseId: string) => {
  const ownerId = resolveOwnerId(authUser);

  // Verify course ownership
  const course = await prisma.course.findFirst({
    where: { id: courseId, teacherId: ownerId },
  });

  if (!course) {
    throw new ForbiddenError('Course not found or forbidden');
  }

  // Get lessons (assignments) for this course
  const lessons = await prisma.lesson.findMany({
    where: { courseId },
    select: {
      id: true,
      title: true,
      description: true,
      homeworkText: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  // Get submission counts per lesson
  const assignments = await Promise.all(
    lessons.map(async (lesson) => {
      // Count all enrolled students for this course
      const totalCount = await prisma.courseEnrollment.count({
        where: { courseId, status: 'APPROVED' },
      });

      // Count students who submitted homework for this lesson (via tracking hwStatus)
      const submittedCount = await prisma.tracking.count({
        where: {
          lessonId: lesson.id,
          hwStatus: { not: 'NOT_SUBMITTED' },
        },
      });

      return {
        id: lesson.id,
        title: lesson.title,
        description: lesson.description,
        dueDate: lesson.createdAt,
        totalCount,
        submittedCount,
      };
    })
  );

  return assignments;
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/teachers/courses/:courseId/quizzes
// Returns lessons with quizzes for a course
// ─────────────────────────────────────────────────────────────────────────────
export const getCourseQuizzes = async (authUser: AuthUser, courseId: string) => {
  const ownerId = resolveOwnerId(authUser);

  const course = await prisma.course.findFirst({
    where: { id: courseId, teacherId: ownerId },
  });

  if (!course) {
    throw new ForbiddenError('Course not found or forbidden');
  }

  // Get lessons with quizzes for this course (via quizzes relation)
  const lessons = await prisma.lesson.findMany({
    where: { courseId },
    include: {
      quizzes: {
        select: {
          id: true,
          questions: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Filter only lessons that have quizzes
  const lessonsWithQuizzes = lessons.filter(l => l.quizzes && l.quizzes.length > 0);

  // Get submission counts per quiz
  const quizzes = await Promise.all(
    lessonsWithQuizzes.map(async (lesson) => {
      // Get total enrolled students for this course
      const totalEnrolled = await prisma.courseEnrollment.count({
        where: { courseId, status: 'APPROVED' },
      });

      // Count students who have submitted (essayStatus = PENDING) - these need manual grading
      const pendingCount = await prisma.tracking.count({
        where: {
          lessonId: lesson.id,
          essayStatus: 'PENDING',
        },
      });

      // Count students who have a quiz score (graded)
      const gradedCount = await prisma.tracking.count({
        where: {
          lessonId: lesson.id,
          essayStatus: 'GRADED',
        },
      });

      return {
        id: lesson.quizzes[0].id,
        title: lesson.title,
        pendingCount: pendingCount,
        totalEnrolled: totalEnrolled,
        gradedCount: gradedCount,
      };
    })
  );

  return quizzes;
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/teachers/assignments/:assignmentId/submissions
// Returns student submissions for an assignment
// ─────────────────────────────────────────────────────────────────────────────
export const getAssignmentSubmissions = async (authUser: AuthUser, assignmentId: string) => {
  const lesson = await prisma.lesson.findUnique({
    where: { id: assignmentId },
    include: { course: true },
  });

  if (!lesson || !lesson.course) {
    throw new ForbiddenError('Assignment not found or forbidden');
  }

  // Support both TEACHER and ASSISTANT roles: an assistant is authorized if
  // linked to the course owner via parentTeacherId (see resolveOwnerId).
  const isAuthorized = lesson.course.teacherId === resolveOwnerId(authUser);

  if (!isAuthorized) {
    throw new ForbiddenError('Assignment not found or forbidden');
  }

  const courseId = lesson.courseId;

  // Get all enrolled students for the course
  const enrollments = await prisma.courseEnrollment.findMany({
    where: { courseId: courseId || '', status: 'APPROVED' },
    include: {
      student: {
        select: { id: true, name: true, phone: true },
      },
    },
  });

  const submissions = await Promise.all(
    enrollments.map(async (enrollment) => {
      const tracking = await prisma.tracking.findUnique({
        where: { studentId_lessonId: { studentId: enrollment.studentId, lessonId: assignmentId } },
      });

      const student = (enrollment as any).student;
      const hasSubmission = tracking && tracking.hwStatus !== 'NOT_SUBMITTED';

      return {
        id: tracking?.id || '',
        studentId: student.id,
        studentName: student.name,
        studentPhone: student.phone,
        submissionText: hasSubmission ? 'تم التسليم' : '',
        status: tracking?.hwStatus || 'NOT_SUBMITTED',
        submittedAt: tracking?.createdAt,
        score: tracking?.quizScore,
        hwFileUrl: tracking?.hwFileUrl ?? null, // raw stored value; controller formats to absolute URL(s)
      };
    })
  );

  logger.info(`📡 Submissions for ${assignmentId}:`, submissions.map(s => ({ n: s.studentName, st: s.status, hasF: !!s.hwFileUrl })));

  return submissions;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/teachers/assignments/:assignmentId/status
// Approve or reject a student submission (File Verification Workflow)
// ─────────────────────────────────────────────────────────────────────────────
export const updateSubmissionStatus = async (
  authUser: AuthUser,
  assignmentId: string,
  status: string | undefined,
  studentId: string | undefined
) => {
  if (!status || !['APPROVED', 'REJECTED'].includes(status)) {
    throw new BadRequestError('Invalid status. Must be APPROVED or REJECTED.');
  }

  if (!studentId) {
    throw new BadRequestError('studentId is required');
  }

  const lesson = await prisma.lesson.findUnique({
    where: { id: assignmentId },
    include: { course: true },
  });

  if (!lesson || !lesson.course) {
    throw new ForbiddenError('Assignment not found or forbidden');
  }

  // Support both TEACHER and ASSISTANT roles
  const isAuthorized = lesson.course.teacherId === resolveOwnerId(authUser);

  if (!isAuthorized) {
    throw new ForbiddenError('Assignment not found or forbidden');
  }

  // Find or create tracking record
  let tracking = await prisma.tracking.findUnique({
    where: { studentId_lessonId: { studentId, lessonId: assignmentId } },
  });

  if (!tracking) {
    // Create tracking if doesn't exist
    tracking = await prisma.tracking.create({
      data: {
        studentId,
        lessonId: assignmentId,
        isPresent: true,
        hwStatus: status,
      },
    });
  } else {
    // Update existing tracking
    tracking = await prisma.tracking.update({
      where: { id: tracking.id },
      data: { hwStatus: status },
    });
  }

  logger.info('Submission status updated:', { assignmentId, studentId, status, by: authUser.id });
  return tracking;
};
