import { Request, Response, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthUser } from '../middlewares/auth.middleware';

const prisma = new PrismaClient();

export const getStudentDashboard = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: any }).user;

    if (!authUser || authUser.role !== 'STUDENT') {
      res.status(403).json({ error: 'Access denied. Students only.' });
      return;
    }

    const studentId = authUser.id;

    const enrollments = await prisma.enrollment.findMany({
      where: { studentId },
      include: {
        subject: {
          include: {
            teacher: {
              select: {
                id: true,
                name: true,
              },
            },
            lessons: {
              select: {
                id: true,
                title: true,
                thumbnailUrl: true,
                videoUrl: true,
              },
            },
          },
        },
      },
    });

    let totalLessons = 0;
    let completedLessons = 0;
    let watchedHours = 0;

    const enrolledCourses = await Promise.all(
      enrollments.map(async (enrollment) => {
        const subject = enrollment.subject;
        const lessons = subject.lessons || [];
        const subjectTotalLessons = lessons.length;

        const trackingRecords = await prisma.tracking.findMany({
          where: {
            studentId,
            lesson: {
              subjectId: subject.id,
            },
            isPresent: true,
          },
        });

        const completedCount = trackingRecords.length;
        totalLessons += subjectTotalLessons;
        completedLessons += completedCount;

        const progress = subjectTotalLessons > 0 
          ? Math.round((completedCount / subjectTotalLessons) * 100) 
          : 0;

        watchedHours += completedCount * 0.5;

        return {
          id: subject.id,
          name: subject.name,
          code: subject.code,
          teacherName: subject.teacher?.name || 'Unknown',
          totalLessons: subjectTotalLessons,
          completedLessons: completedCount,
          progress: progress,
          thumbnailUrl: lessons[0]?.thumbnailUrl,
        };
      })
    );

    const overallProgress = totalLessons > 0 
      ? Math.round((completedLessons / totalLessons) * 100) 
      : 0;

    res.json({
      student: {
        id: studentId,
        name: authUser.name || 'Student',
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
    });
  } catch (error) {
    console.error('getStudentDashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
};

export const getWeeklyProgress = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: any }).user;

    if (!authUser || authUser.role !== 'STUDENT') {
      res.status(403).json({ error: 'Access denied. Students only.' });
      return;
    }

    const studentId = authUser.id;

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

    res.json({
      watchedHours: watchedHoursThisWeek,
      weeklyGoal: weeklyGoalHours,
      progressPercentage,
      remainingHours: Math.max(0, weeklyGoalHours - watchedHoursThisWeek),
    });
  } catch (error) {
    console.error('getWeeklyProgress error:', error);
    res.status(500).json({ error: 'Failed to fetch weekly progress data' });
  }
};

export const getRecentLessons: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser || authUser.role !== 'STUDENT') {
      res.status(403).json({ error: 'Students only' });
      return;
    }

    const studentId = authUser.id;

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

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const formatUrl = (url: string | null | undefined) => {
      if (!url) return null;
      if (url.startsWith('http')) return url;
      const clean = url.startsWith('/') ? url.slice(1) : url;
      return clean.startsWith('uploads/') ? `${baseUrl}/${clean}` : `${baseUrl}/uploads/${clean}`;
    };

    const result = lessons.map((lesson) => ({
      id: lesson.id,
      title: lesson.title,
      description: lesson.description,
      subject: lesson.subject,
      grade: lesson.grade,
      teacherId: lesson.teacherId,
      courseId: lesson.courseId,
      videoUrl: formatUrl(lesson.videoUrl),
      thumbnailUrl: formatUrl(lesson.thumbnailUrl),
      pdfUrl: formatUrl(lesson.pdfUrl),
      homeworkText: lesson.homeworkText,
      homeworkPdfUrl: formatUrl(lesson.homeworkPdfUrl),
      hasQuiz: false, // We can populate this if we query it, but for recent lessons UI it's rarely used
      createdAt: lesson.createdAt,
      teacher: lesson.teacher,
    }));

    res.json(result);
  } catch (error) {
    console.error('getRecentLessons error:', error);
    res.status(500).json({ error: 'Failed to fetch recent lessons' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/teachers/students
// Returns all unique students enrolled in any of the teacher's courses
// ─────────────────────────────────────────────────────────────────────────────
export const getTeacherStudents: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId
      ? authUser.parentTeacherId
      : authUser.id;

    const enrollments = await prisma.courseEnrollment.findMany({
      where: {
        status: 'APPROVED',
        course: { teacherId: ownerId },
      },
      include: {
        student: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
          },
        },
        course: {
          select: {
            id: true,
            title: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Get parent relations for all students
    const studentIds = [...new Set(enrollments.map(e => e.studentId))];
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

    // Group by student
    const studentMap = new Map<string, {
      id: string;
      name: string;
      phone: string;
      email: string | null;
      parentPhone: string | null;
      courses: { id: string; title: string }[];
    }>();

    for (const e of enrollments) {
      if (!studentMap.has(e.studentId)) {
        studentMap.set(e.studentId, {
          id: e.studentId,
          name: e.student.name,
          phone: e.student.phone,
          email: e.student.email,
          parentPhone: parentPhoneMap.get(e.studentId) || null,
          courses: [],
        });
      }
      studentMap.get(e.studentId)!.courses.push({
        id: e.course.id,
        title: e.course.title,
      });
    }

    const result = Array.from(studentMap.values());
    console.log('Teacher students:', { count: result.length, ownerId });
    res.json(result);
  } catch (error) {
    console.error('getTeacherStudents error:', error);
    res.status(500).json({ error: 'Failed to fetch students' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/teachers/students/:studentId/courses/:courseId/remove
// Removes a student from a specific course
// ──────────────────────────────────────────────────────────────────────────���──
export const removeStudentEnrollment: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { studentId, courseId } = req.params;
    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId
      ? authUser.parentTeacherId
      : authUser.id;

    const course = await prisma.course.findFirst({
      where: { id: courseId, teacherId: ownerId },
    });

    if (!course) {
      res.status(403).json({ error: 'Course not found or forbidden' });
      return;
    }

    const enrollment = await prisma.courseEnrollment.findFirst({
      where: { studentId, courseId },
    });

    if (!enrollment) {
      res.status(404).json({ error: 'Enrollment not found' });
      return;
    }

    await prisma.courseEnrollment.delete({ where: { id: enrollment.id } });
    console.log('Student removed from course:', { studentId, courseId, by: authUser.id });
    res.json({ message: 'Student removed successfully' });
  } catch (error) {
    console.error('removeStudentEnrollment error:', error);
    res.status(500).json({ error: 'Failed to remove student' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/teachers/courses - Returns courses for grading
// ─────────────────────────────────────────────────────────────────────────────
export const getTeacherCoursesForGrading: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId
      ? authUser.parentTeacherId
      : authUser.id;

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

    res.json(coursesWithCount);
  } catch (error) {
    console.error('getTeacherCoursesForGrading error:', error);
    res.status(500).json({ error: 'Failed to fetch courses' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/teachers/courses/:courseId/assignments
// Returns lessons with homework for a course
// ─────────────────────────────────────────────────────────────────────────────
export const getCourseAssignments: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { courseId } = req.params;
    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId
      ? authUser.parentTeacherId
      : authUser.id;

    // Verify course ownership
    const course = await prisma.course.findFirst({
      where: { id: courseId, teacherId: ownerId },
    });

    if (!course) {
      res.status(403).json({ error: 'Course not found or forbidden' });
      return;
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

    res.json(assignments);
  } catch (error) {
    console.error('getCourseAssignments error:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/teachers/courses/:courseId/quizzes
// Returns lessons with quizzes for a course
// ─────────────────────────────────────────────────────────────────────────────
export const getCourseQuizzes: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { courseId } = req.params;
    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId
      ? authUser.parentTeacherId
      : authUser.id;

    const course = await prisma.course.findFirst({
      where: { id: courseId, teacherId: ownerId },
    });

    if (!course) {
      res.status(403).json({ error: 'Course not found or forbidden' });
      return;
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

        // Count students who have submitted (hwStatus = PENDING) - these need manual grading
        const pendingCount = await prisma.tracking.count({
          where: {
            lessonId: lesson.id,
            hwStatus: 'PENDING',
          },
        });

        // Count students who have a quiz score (graded)
        const gradedCount = await prisma.tracking.count({
          where: {
            lessonId: lesson.id,
            quizScore: { not: null },
            hwStatus: 'SUBMITTED',
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

    res.json(quizzes);
  } catch (error) {
    console.error('getCourseQuizzes error:', error);
    res.status(500).json({ error: 'Failed to fetch quizzes' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/teachers/assignments/:assignmentId/submissions
// Returns student submissions for an assignment
// ─────────────────────────────────────────────────────────────────────────────
export const getAssignmentSubmissions: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { assignmentId } = req.params;

    const lesson = await prisma.lesson.findUnique({
      where: { id: assignmentId },
      include: { course: true },
    });

    if (!lesson || !lesson.course) {
      res.status(403).json({ error: 'Assignment not found or forbidden' });
      return;
    }
    
    // Support both TEACHER and ASSISTANT roles
    // For assistants, check if they're linked to the course's teacher
    let isAuthorized = lesson.course.teacherId === authUser.id;
    if (authUser.role === 'ASSISTANT' && authUser.parentTeacherId) {
      // Assistant can access if they're linked to the course owner
      isAuthorized = lesson.course.teacherId === authUser.parentTeacherId;
    }
    
    if (!isAuthorized) {
      res.status(403).json({ error: 'Assignment not found or forbidden' });
      return;
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

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const submissions = await Promise.all(
      enrollments.map(async (enrollment) => {
        const tracking = await prisma.tracking.findUnique({
          where: { studentId_lessonId: { studentId: enrollment.studentId, lessonId: assignmentId } },
        });

        const student = (enrollment as any).student;
        const hasSubmission = tracking && tracking.hwStatus !== 'NOT_SUBMITTED';

        // Build absolute URL for the homework file(s) if they exist
        const hwFileUrl = tracking?.hwFileUrl
          ? tracking.hwFileUrl.split(',').map(url => {
              const trimmed = url.trim();
              if (!trimmed) return '';
              return trimmed.startsWith('http') ? trimmed : `${baseUrl}/${trimmed}`;
            }).filter(u => u).join(',')
          : null;
        
        return {
          id: tracking?.id || '',
          studentId: student.id,
          studentName: student.name,
          studentPhone: student.phone,
          submissionText: hasSubmission ? 'تم التسليم' : '',
          status: tracking?.hwStatus || 'NOT_SUBMITTED',
          submittedAt: tracking?.createdAt,
          score: tracking?.quizScore,
          hwFileUrl,          // ← file the student uploaded (PENDING review)
        };
      })
    );

    console.log(`📡 Submissions for ${assignmentId}:`, submissions.map(s => ({ n: s.studentName, st: s.status, hasF: !!s.hwFileUrl })));

    res.json(submissions);
  } catch (error) {
    console.error('getAssignmentSubmissions error:', error);
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/teachers/assignments/:assignmentId/status
// Approve or reject a student submission (File Verification Workflow)
// ─────────────────────────────────────────────────────────────────────────────
export const updateSubmissionStatus: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { assignmentId } = req.params;
    const { status, studentId } = req.body as { status?: string; studentId?: string };

    if (!status || !['APPROVED', 'REJECTED'].includes(status)) {
      res.status(400).json({ error: 'Invalid status. Must be APPROVED or REJECTED.' });
      return;
    }

    if (!studentId) {
      res.status(400).json({ error: 'studentId is required' });
      return;
    }

    const lesson = await prisma.lesson.findUnique({
      where: { id: assignmentId },
      include: { course: true },
    });

    if (!lesson || !lesson.course) {
      res.status(403).json({ error: 'Assignment not found or forbidden' });
      return;
    }
    
    // Support both TEACHER and ASSISTANT roles
    let isAuthorized = lesson.course.teacherId === authUser.id;
    if (authUser.role === 'ASSISTANT' && authUser.parentTeacherId) {
      isAuthorized = lesson.course.teacherId === authUser.parentTeacherId;
    }
    
    if (!isAuthorized) {
      res.status(403).json({ error: 'Assignment not found or forbidden' });
      return;
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

    console.log('Submission status updated:', { assignmentId, studentId, status, by: authUser.id });
    res.json({ message: `Submission ${status} successfully`, status: tracking.hwStatus });
  } catch (error) {
    console.error('updateSubmissionStatus error:', error);
    res.status(500).json({ error: 'Failed to update submission status' });
  }
};
