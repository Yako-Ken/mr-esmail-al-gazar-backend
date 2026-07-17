import { Request, RequestHandler } from 'express';
import { AuthUser } from '../middlewares/auth.middleware';
import { handleControllerError } from '../middlewares/errorHandler';
import { getBaseUrl, toAbsoluteUploadUrl } from '../utils/urls';
import * as lessonService from '../services/lesson.service';

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lessons/mark-attendance
// ─────────────────────────────────────────────────────────────────────────────
export const markAttendance: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { lessonId } = req.body;
    const authUser = (req as Request & { user?: AuthUser }).user;
    const studentId = authUser?.id;

    if (!studentId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const tracking = await lessonService.markAttendance(studentId, lessonId);
    res.json(tracking);
  } catch (error) {
    handleControllerError('markAttendance', error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lessons/submit-quiz
// ─────────────────────────────────────────────────────────────────────────────
export const submitQuiz: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { lessonId, answers } = req.body;
    const authUser = (req as Request & { user?: AuthUser }).user;
    const studentId = authUser?.id;

    if (!studentId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const result = await lessonService.submitQuiz(studentId, lessonId, answers);

    if (result.status === 'alreadySubmitted') {
      res.status(409).json({ error: 'Quiz already submitted', score: result.score });
      return;
    }

    if (result.status === 'emptyAnswers') {
      res.json({ score: 0, totalQuestions: 0, correctAnswers: 0, tracking: result.tracking });
      return;
    }

    res.json({
      score: result.score,
      totalQuestions: result.totalQuestions,
      correctAnswers: result.correctAnswers,
      tracking: result.tracking,
      needsManualGrading: result.needsManualGrading,
    });
  } catch (error) {
    handleControllerError('submitQuiz', error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lessons/fetch-students
// ─────────────────────────────────────────────────────────────────────────────
export const fetchStudents: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const students = await lessonService.fetchStudents(authUser);
    res.json(students);
  } catch (error) {
    handleControllerError('fetchStudents', error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lessons  and GET /api/lessons/public
// ─────────────────────────────────────────────────────────────────────────────
export const getLessons: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { subject, grade, teacherId: queryTeacherId } = req.query;

    const lessons = await lessonService.listLessons({
      subject: subject as string | undefined,
      grade: grade as string | undefined,
      teacherId: queryTeacherId as string | undefined,
    });
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
      bunnyVideoId: lesson.bunnyVideoId,
      videoLibraryId: lesson.videoLibraryId,
      thumbnailUrl: toAbsoluteUploadUrl(baseUrl, lesson.thumbnailUrl),
      pdfUrl: toAbsoluteUploadUrl(baseUrl, lesson.pdfUrl),
      homeworkText: lesson.homeworkText,
      homeworkPdfUrl: toAbsoluteUploadUrl(baseUrl, lesson.homeworkPdfUrl),
      hasQuiz: lesson.quizzes.length > 0,
      createdAt: lesson.createdAt,
    }));

    res.json(result);
  } catch (error) {
    handleControllerError('getLessons', error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lessons
// ─────────────────────────────────────────────────────────────────────────────
export const createLesson: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser?.id) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const lesson = await lessonService.createLesson(authUser, req.body);
    res.json({ success: true, data: lesson });
  } catch (error) {
    handleControllerError('createLesson', error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/lessons/:id
// ─────────────────────────────────────────────────────────────────────────────
export const updateLesson: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser?.id) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const lesson = await lessonService.updateLesson(id, authUser, req.body);
    res.json(lesson);
  } catch (error) {
    handleControllerError('updateLesson', error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/lessons/:id
// ─────────────────────────────────────────────────────────────────────────────
export const deleteLesson: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser?.id) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await lessonService.deleteLesson(id, authUser);
    res.json({ message: 'Lesson deleted successfully' });
  } catch (error) {
    handleControllerError('deleteLesson', error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lessons/:id
// ─────────────────────────────────────────────────────────────────────────────
export const getLessonById: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const authUser = (req as Request & { user?: AuthUser }).user;

    const { lesson, userTracking } = await lessonService.getLessonById(id, authUser);
    const baseUrl = getBaseUrl(req);

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.json({
      id: lesson.id,
      title: lesson.title,
      description: lesson.description,
      subject: lesson.subject,
      grade: lesson.grade,
      teacherId: lesson.teacherId,
      courseId: lesson.courseId,
      videoUrl: toAbsoluteUploadUrl(baseUrl, lesson.videoUrl),
      bunnyVideoId: lesson.bunnyVideoId,
      videoLibraryId: lesson.videoLibraryId,
      thumbnailUrl: toAbsoluteUploadUrl(baseUrl, lesson.thumbnailUrl),
      pdfUrl: toAbsoluteUploadUrl(baseUrl, lesson.pdfUrl),
      homeworkText: lesson.homeworkText,
      homeworkPdfUrl: toAbsoluteUploadUrl(baseUrl, lesson.homeworkPdfUrl),
      hasQuiz: lesson.quizzes.length > 0,
      hasCompletedQuiz: userTracking != null && (userTracking.essayStatus !== 'NOT_SUBMITTED' || userTracking.quizScore !== null),
      quizScore: userTracking?.quizScore ?? null,
      trackingId: userTracking?.id ?? null,
      createdAt: lesson.createdAt,
      teacher: lesson.teacher,
    });
  } catch (error) {
    handleControllerError('getLessonById', error, res);
  }
};
