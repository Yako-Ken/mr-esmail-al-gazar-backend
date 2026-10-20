import { Request, RequestHandler } from 'express';
import { AuthUser } from '../middlewares/auth.middleware';
import { handleControllerError } from '../middlewares/errorHandler';
import { getBaseUrl, toAbsoluteUploadUrl, toProtectedMediaUrl } from '../utils/urls';
import * as lessonService from '../services/lesson.service';
import { env } from '../utils/env';
import { isAllowedBunnyUrl, signBunnyCdnUrl } from '../utils/bunnyToken';

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lessons/mark-attendance
// ─────────────────────────────────────────────────────────────────────────────
export const markAttendance: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { lessonId } = req.body;
    const authUser = (req as Request & { user?: AuthUser }).user;
    const studentId = authUser?.id;

    if (!studentId || authUser?.role !== 'STUDENT') {
      res.status(403).json({ error: 'Students only' });
      return;
    }

    await lessonService.getLessonById(lessonId, authUser);
    const tracking = await lessonService.markAttendance(studentId, lessonId);
    res.json(tracking);
  } catch (error) {
    handleControllerError('markAttendance', error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lessons/submit-quiz
// ─────────────────────────────────────────────────────────────────────────────
export const submitHomework: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser || authUser.role !== 'STUDENT') {
      res.status(403).json({ error: 'Students only' });
      return;
    }

    const lessonId = String(req.params.id ?? '').trim();
    const { answer } = req.body as { answer: string };
    const { lesson } = await lessonService.getLessonById(lessonId, authUser);
    if (!lesson.homeworkText && !lesson.homeworkPdfUrl) {
      res.status(400).json({ error: 'This lesson has no homework' });
      return;
    }

const existing = await lessonService.getTracking(authUser.id, lessonId);
      // Once work has been handed in it must not be silently replaced. The
      // only state a student may submit from is NOT_SUBMITTED or a returned
      // NEEDS_REVISION (resubmission after a teacher's revision request).
      const RESUBMITTABLE: string[] = ['NOT_SUBMITTED', 'NEEDS_REVISION'];
      if (existing && !RESUBMITTABLE.includes(existing.hwStatus)) {
        res.status(409).json({ error: 'Homework already submitted', tracking: existing });
        return;
      }

    const tracking = await lessonService.submitHomework(authUser.id, lessonId, answer);
    res.status(201).json({ success: true, tracking });
  } catch (error) {
    handleControllerError('submitHomework', error, res);
  }
};

export const submitQuiz: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { lessonId, answers } = req.body;
    const authUser = (req as Request & { user?: AuthUser }).user;
    const studentId = authUser?.id;

    if (!studentId || authUser?.role !== 'STUDENT') {
      res.status(403).json({ error: 'Students only' });
      return;
    }

    await lessonService.getLessonById(lessonId, authUser);
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
      hasVideo: Boolean(lesson.videoUrl || lesson.bunnyVideoId),
      thumbnailUrl: toAbsoluteUploadUrl(baseUrl, lesson.thumbnailUrl),
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

    const isOverdue = Boolean(
      lesson.homeworkDueAt &&
        new Date() > new Date(lesson.homeworkDueAt) &&
        (!userTracking || !userTracking.hwSubmittedAt || userTracking.hwStatus === 'NOT_SUBMITTED'),
    );

    const lessonData = {
      id: lesson.id,
      title: lesson.title,
      description: lesson.description,
      subject: lesson.subject,
      grade: lesson.grade,
      teacherId: lesson.teacherId,
      courseId: lesson.courseId,
      hasVideo: Boolean(lesson.videoUrl || lesson.bunnyVideoId),
      thumbnailUrl: toAbsoluteUploadUrl(baseUrl, lesson.thumbnailUrl),
      pdfUrl: toProtectedMediaUrl(baseUrl, lesson.pdfUrl),
      homeworkText: lesson.homeworkText,
      homeworkPdfUrl: toProtectedMediaUrl(baseUrl, lesson.homeworkPdfUrl),
      homeworkDueAt: lesson.homeworkDueAt ? lesson.homeworkDueAt.toISOString() : null,
      isOverdue,
      hasQuiz: lesson.quizzes.length > 0,
      hasCompletedQuiz: userTracking?.quizScore !== null && userTracking?.quizScore !== undefined,
      quizScore: userTracking?.quizScore ?? null,
      hwStatus: userTracking?.hwStatus ?? 'NOT_SUBMITTED',
      essayStatus: userTracking?.essayStatus ?? 'NOT_SUBMITTED',
      trackingId: userTracking?.id ?? null,
      createdAt: lesson.createdAt,
      teacher: lesson.teacher,
    };

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.json({
      ...lessonData,
      lesson: lessonData,
    });
  } catch (error) {
    handleControllerError('getLessonById', error, res);
  }
};

// GET /api/lessons/:id/playback — returns media only after authorization.
// Permanent Bunny URLs are never included in lesson/list payloads.
export const getLessonPlayback: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    const { lesson } = await lessonService.getLessonById(req.params.id, authUser);

    res.setHeader('Cache-Control', 'private, no-store, max-age=0');

    if (lesson.bunnyVideoId) {
      const streamCdn = env.BUNNY_STREAM_CDN_URL?.replace(/\/$/, '');
      if (!streamCdn) {
        res.status(503).json({
          error: 'Bunny Stream playback is not configured',
          code: 'STREAM_PLAYBACK_NOT_CONFIGURED',
        });
        return;
      }
      const rawStreamUrl = `${streamCdn}/${lesson.bunnyVideoId}/playlist.m3u8`;
      if (!env.BUNNY_STREAM_TOKEN_KEY) {
        if (env.NODE_ENV === 'production') {
          res.status(503).json({
            error: 'Protected Bunny Stream playback is not configured',
            code: 'STREAM_TOKEN_NOT_CONFIGURED',
          });
          return;
        }
        res.json({ url: rawStreamUrl, expiresAt: null, protected: false, format: 'hls' });
        return;
      }
      const signedStream = signBunnyCdnUrl(
        rawStreamUrl,
        env.BUNNY_STREAM_TOKEN_KEY,
        7200,
      );
      res.json({
        url: signedStream.url,
        expiresAt: signedStream.expiresAt,
        protected: true,
        format: 'hls',
      });
      return;
    }

    if (!lesson.videoUrl) {
      res.status(404).json({ error: 'Lesson video is not available' });
      return;
    }

    const rawUrl = toAbsoluteUploadUrl(getBaseUrl(req), lesson.videoUrl);
    if (!rawUrl) {
      res.status(404).json({ error: 'Lesson video is not available' });
      return;
    }

    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    if (env.BUNNY_CDN_URL && isAllowedBunnyUrl(rawUrl, env.BUNNY_CDN_URL)) {
      if (!env.BUNNY_CDN_TOKEN_KEY) {
        if (env.NODE_ENV === 'production') {
          res.status(503).json({
            error: 'Protected playback is not configured',
            code: 'PLAYBACK_NOT_CONFIGURED',
          });
          return;
        }
        res.json({ url: rawUrl, expiresAt: null, protected: false });
        return;
      }

      // Two hours permits normal seeking/range requests while keeping the URL temporary.
      const signed = signBunnyCdnUrl(rawUrl, env.BUNNY_CDN_TOKEN_KEY, 7200);
      res.json({ url: signed.url, expiresAt: signed.expiresAt, protected: true });
      return;
    }

    if (env.NODE_ENV === 'production') {
      res.status(503).json({
        error: 'Production lessons must use the configured protected Bunny CDN',
        code: 'UNPROTECTED_MEDIA_URL',
      });
      return;
    }

    // Local uploads are allowed only for development/test demos.
    res.json({ url: rawUrl, expiresAt: null, protected: false });
  } catch (error) {
    handleControllerError('getLessonPlayback', error, res);
  }
};
