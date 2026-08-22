import { Request, Response, RequestHandler } from 'express';
import path from 'path';
import { AuthUser } from '../middlewares/auth.middleware';
import { handleControllerError } from '../middlewares/errorHandler';
import { getBaseUrl, toAbsoluteUploadUrl } from '../utils/urls';
import * as courseService from '../services/course.service';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/courses/my  — returns all courses owned by the logged-in teacher
// ─────────────────────────────────────────────────────────────────────────────
export const getTeacherCourses: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const courses = await courseService.listTeacherCourses(authUser);
    const baseUrl = getBaseUrl(req);

    res.json(
      courses.map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        price: c.price,
        subject: c.subject,
        thumbnailUrl: toAbsoluteUploadUrl(baseUrl, c.thumbnailUrl),
        lessonCount: c._count.lessons,
        isPublished: c.isPublished,
        publishedAt: c.publishedAt,
        createdAt: c.createdAt,
      }))
    );
  } catch (error) {
    handleControllerError('getTeacherCourses', error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/courses  — returns ALL courses (Admin) or teacher's own (Teacher)
// ─────────────────────────────────────────────────────────────────────────────
export const getAllCourses: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const courses = await courseService.listAllCourses(authUser);
    const baseUrl = getBaseUrl(req);

    res.json(
      courses.map((c) => ({
        id: c.id,
        title: c.title,
        price: c.price,
        thumbnailUrl: toAbsoluteUploadUrl(baseUrl, c.thumbnailUrl),
        teacherName: c.teacher.name,
        lessonCount: c._count.lessons,
        isPublished: c.isPublished,
        createdAt: c.createdAt,
      }))
    );
  } catch (error) {
    handleControllerError('getAllCourses', error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/courses  — create a new course (multipart: title, price, thumbnail)
// ─────────────────────────────────────────────────────────────────────────────
export const createCourse: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
    let thumbnailRelativePath: string | undefined;
    if (files?.thumbnail?.[0]) {
      thumbnailRelativePath = files.thumbnail[0].path.replace(UPLOADS_DIR, '').replace(/^[/\\]/, '');
    }

    const course = await courseService.createCourse(authUser, req.body, thumbnailRelativePath);
    const baseUrl = getBaseUrl(req);

    res.status(201).json({
      message: 'Course created successfully',
      course: {
        id: course.id,
        title: course.title,
        price: course.price,
        priceMinor: course.priceMinor,
        currency: course.currency,
        isPublished: course.isPublished,
        thumbnailUrl: thumbnailRelativePath ? `${baseUrl}/uploads/${thumbnailRelativePath}` : null,
        createdAt: course.createdAt,
      },
    });
  } catch (error) {
    handleControllerError('createCourse', error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/courses/:id  — fetch a single course (public)
// ─────────────────────────────────────────────────────────────────────────────
export const getCourseById: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const course = await courseService.getCourseWithLessons(id);
    const baseUrl = getBaseUrl(req);

    res.json({
      id: course.id,
      title: course.title,
      price: course.price,
      description: (course as any).description ?? null,
      subject: (course as any).subject ?? null,
      thumbnailUrl: toAbsoluteUploadUrl(baseUrl, course.thumbnailUrl),
      isPublished: course.isPublished,
      publishedAt: course.publishedAt,
      teacher: course.teacher,
      lessons: course.lessons.map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        thumbnailUrl: toAbsoluteUploadUrl(baseUrl, lesson.thumbnailUrl),
        createdAt: lesson.createdAt,
        hasVideo: Boolean(lesson.videoUrl || lesson.bunnyVideoId),
        hasQuiz: lesson.quizzes.length > 0,
      })),
    });
  } catch (error) {
    handleControllerError('getCourseById', error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/courses/:id  — update course title/description (teacher owner only)
// ─────────────────────────────────────────────────────────────────────────────
export const updateCourse: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const updated = await courseService.updateCourse(id, authUser, req.body);
    res.json({ message: 'Course updated', course: updated });
  } catch (error) {
    handleControllerError('updateCourse', error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/courses/:id  — cascade delete (teacher owner only)
// ─────────────────────────────────────────────────────────────────────────────
export const deleteCourse: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    await courseService.deleteCourse(id, authUser);
    res.json({ message: 'Course deleted successfully' });
  } catch (error) {
    handleControllerError('deleteCourse', error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/courses/:id/thumbnail  — upload/update course thumbnail
// ─────────────────────────────────────────────────────────────────────────────
export const uploadThumbnail: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const file = (req as any).file;
    if (!file) {
      res.status(400).json({ error: 'No thumbnail file provided' });
      return;
    }

    const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
    const relativePath = file.path.replace(UPLOADS_DIR, '').replace(/^[/\\]/, '');

    const updated = await courseService.updateCourseThumbnail(id, authUser, relativePath);
    res.json({ message: 'Thumbnail updated', thumbnailUrl: `/uploads/${relativePath}`, courseId: updated.id });
  } catch (error) {
    handleControllerError('uploadThumbnail', error, res);
  }
};
