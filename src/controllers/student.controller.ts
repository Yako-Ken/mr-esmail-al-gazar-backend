import { Request, Response, RequestHandler } from 'express';
import { AuthUser } from '../middlewares/auth.middleware';
import { handleControllerError } from '../middlewares/errorHandler';
import { getBaseUrl, toAbsoluteUploadUrl, toProtectedMediaUrl } from '../utils/urls';
import { logger } from '../utils/logger';
import * as studentService from '../services/student.service';
import * as homeworkService from '../services/homework.service';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/students/my-dashboard
// ─────────────────────────────────────────────────────────────────────────────
export const getStudentDashboard = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    const result = await studentService.getStudentDashboard(authUser);
    res.json(result);
  } catch (error) {
    handleControllerError('getStudentDashboard', error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/students/weekly-progress
// ─────────────────────────────────────────────────────────────────────────────
export const getWeeklyProgress = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    const result = await studentService.getWeeklyProgress(authUser);
    res.json(result);
  } catch (error) {
    handleControllerError('getWeeklyProgress', error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/students/recent-lessons
// ─────────────────────────────────────────────────────────────────────────────
export const getRecentLessons: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    const lessons = await studentService.getRecentLessons(authUser);
    const baseUrl = getBaseUrl(req);

    const result = lessons.map((lesson) => ({
      id: lesson.id,
      title: lesson.title,
      description: lesson.description,
      subject: lesson.subject,
      grade: lesson.grade,
      teacherId: lesson.teacherId,
      courseId: lesson.courseId,
      hasVideo: Boolean(lesson.videoUrl),
      thumbnailUrl: toAbsoluteUploadUrl(baseUrl, lesson.thumbnailUrl),
      hasQuiz: false, // We can populate this if we query it, but for recent lessons UI it's rarely used
      createdAt: lesson.createdAt,
      teacher: lesson.teacher,
    }));

    res.json(result);
  } catch (error) {
    handleControllerError('getRecentLessons', error, res);
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

    const result = await studentService.getTeacherStudents(authUser);

    // `getTeacherStudents` returns each enrolled student's own phone and email
    // plus `parentPhone` — the contact number of that student's *guardian*.
    // The teacher's entitlement is to reach their own student, which the phone
    // and email already cover. A roster listing every enrolled student is a bulk
    // export of third-party contact details, so the guardian number is dropped
    // here rather than in the service.
    const projected = (result as {
      id: string;
      name: string;
      phone: string;
      email: string | null;
      parentPhone?: string | null;
      courses: unknown;
    }[]).map((student) => ({
      id: student.id,
      name: student.name,
      phone: student.phone,
      email: student.email,
      courses: student.courses,
    }));

    logger.info('[GET /teachers/students] roster projected', {
      total: projected.length,
      by: authUser.id,
    });

    res.json(projected);
  } catch (error) {
    handleControllerError('getTeacherStudents', error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/teachers/students/:studentId/courses/:courseId/remove
// Removes a student from a specific course
// ─────────────────────────────────────────────────────────────────────────────
export const removeStudentEnrollment: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { studentId, courseId } = req.params;
    await studentService.removeStudentEnrollment(authUser, studentId, courseId);
    res.json({ message: 'Student removed successfully' });
  } catch (error) {
    handleControllerError('removeStudentEnrollment', error, res);
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

    const result = await studentService.getTeacherCoursesForGrading(authUser);
    res.json(result);
  } catch (error) {
    handleControllerError('getTeacherCoursesForGrading', error, res);
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
    const assignments = await studentService.getCourseAssignments(authUser, courseId);
    res.json(assignments);
  } catch (error) {
    handleControllerError('getCourseAssignments', error, res);
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
    const quizzes = await studentService.getCourseQuizzes(authUser, courseId);
    res.json(quizzes);
  } catch (error) {
    handleControllerError('getCourseQuizzes', error, res);
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
    const submissions = await studentService.getAssignmentSubmissions(authUser, assignmentId);
    const baseUrl = getBaseUrl(req);

    // Build absolute URL for the homework file(s) if they exist. hwFileUrl can
    // contain multiple comma-separated relative paths.
    const result = submissions.map((s) => ({
      ...s,
      hwFileUrl: s.hwFileUrl
        ? s.hwFileUrl.split(',').map((url) => {
            const trimmed = url.trim();
            if (!trimmed) return '';
            return toProtectedMediaUrl(baseUrl, trimmed) ?? '';
          }).filter((u) => u).join(',')
        : null,
    }));

    res.json(result);
  } catch (error) {
    handleControllerError('getAssignmentSubmissions', error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/teachers/assignments/:assignmentId/status
// Approve or reject a student submission (File Verification Workflow)
// ─────────────────────────────────────────────────────────────────────────────
/**
   * Grade a submission. Grade and maxGrade are both mandatory — a submission
   * marked GRADED with no mark is what made "graded" meaningless to a parent
   * reading the dashboard.
   */
  export const gradeHomework: RequestHandler = async (req, res): Promise<void> => {
    try {
      const authUser = (req as Request & { user?: AuthUser }).user;
      if (!authUser) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const { assignmentId } = req.params;
      const { studentId, grade, maxGrade, comment } = req.body as {
        studentId?: string;
        grade?: number;
        maxGrade?: number;
        comment?: string;
      };

      const result = await homeworkService.gradeHomework(
        authUser,
        assignmentId,
        studentId,
        grade,
        maxGrade,
        comment,
      );
      res.json({ message: 'Homework graded', result });
    } catch (error) {
      handleControllerError('gradeHomework', error, res);
    }
  };

  /** Return a submission for revision. Feedback is mandatory. */
  export const returnHomework: RequestHandler = async (req, res): Promise<void> => {
    try {
      const authUser = (req as Request & { user?: AuthUser }).user;
      if (!authUser) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const { assignmentId } = req.params;
      const { studentId, comment } = req.body as { studentId?: string; comment?: string };

      const result = await homeworkService.returnHomework(
        authUser,
        assignmentId,
        studentId,
        comment,
      );
      res.json({ message: 'Homework returned for revision', result });
    } catch (error) {
      handleControllerError('returnHomework', error, res);
    }
  };

  /** Move a submission into review. */
  export const startHomeworkReview: RequestHandler = async (req, res): Promise<void> => {
    try {
      const authUser = (req as Request & { user?: AuthUser }).user;
      if (!authUser) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const { assignmentId } = req.params;
      const { studentId } = req.body as { studentId?: string };

      const result = await homeworkService.startReview(authUser, assignmentId, studentId);
      res.json({ message: 'Review started', result });
    } catch (error) {
      handleControllerError('startHomeworkReview', error, res);
    }
  };

  /** Full register for one assignment: every enrolled student's real state. */
  export const getHomeworkRegister: RequestHandler = async (req, res): Promise<void> => {
    try {
      const authUser = (req as Request & { user?: AuthUser }).user;
      if (!authUser) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const { assignmentId } = req.params;
      const result = await homeworkService.getHomeworkRegister(authUser, assignmentId);
      res.json(result);
    } catch (error) {
      handleControllerError('getHomeworkRegister', error, res);
    }
  };

  export const updateSubmissionStatus: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { assignmentId } = req.params;
    const { status, studentId } = req.body as { status?: string; studentId?: string };

    const tracking = await studentService.updateSubmissionStatus(authUser, assignmentId, status, studentId);
    res.json({ message: `Submission ${status} successfully`, status: tracking.hwStatus });
  } catch (error) {
    handleControllerError('updateSubmissionStatus', error, res);
  }
};
