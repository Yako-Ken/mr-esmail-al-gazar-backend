import { Request, Response, RequestHandler } from 'express';
import { AuthUser } from '../middlewares/auth.middleware';
import { handleControllerError } from '../middlewares/errorHandler';
import { getBaseUrl, toAbsoluteUploadUrl } from '../utils/urls';
import * as studentService from '../services/student.service';

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
      videoUrl: toAbsoluteUploadUrl(baseUrl, lesson.videoUrl),
      thumbnailUrl: toAbsoluteUploadUrl(baseUrl, lesson.thumbnailUrl),
      pdfUrl: toAbsoluteUploadUrl(baseUrl, lesson.pdfUrl),
      homeworkText: lesson.homeworkText,
      homeworkPdfUrl: toAbsoluteUploadUrl(baseUrl, lesson.homeworkPdfUrl),
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
    res.json(result);
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
            return trimmed.startsWith('http') ? trimmed : `${baseUrl}/${trimmed}`;
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
