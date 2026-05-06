import { Request, Response, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthUser } from '../middlewares/auth.middleware';
import path from 'path';
import fs from 'fs';

const prisma = new PrismaClient();

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

    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId 
      ? authUser.parentTeacherId 
      : authUser.id;

    const courses = await prisma.course.findMany({
      where: { teacherId: ownerId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { lessons: true } },
      },
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const formatUrl = (url: string | null | undefined) => {
      if (!url) return null;
      if (url.startsWith('http')) return url;
      const normalized = url.replace(/\\/g, '/').replace(/\/+/g, '/');
      if (normalized.startsWith('/uploads/')) {
        return `${baseUrl}${normalized}`;
      }
      return `${baseUrl}/uploads/${normalized}`;
    };

    const result = courses.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      price: c.price,
      subject: c.subject,
      thumbnailUrl: formatUrl(c.thumbnailUrl),
      lessonCount: c._count.lessons,
      createdAt: c.createdAt,
    }));

    res.json(result);
  } catch (error) {
    console.error('getTeacherCourses error:', error);
    res.status(500).json({ error: 'Internal server error' });
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

    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId 
      ? authUser.parentTeacherId 
      : authUser.id;

    const whereClause = authUser.role === 'SUPER_ADMIN' 
      ? {} 
      : { teacherId: ownerId };

    const courses = await prisma.course.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      include: {
        teacher: { select: { id: true, name: true } },
        _count: { select: { lessons: true } },
      },
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const formatUrl = (url: string | null | undefined) => {
      if (!url) return null;
      if (url.startsWith('http')) return url;
      const normalized = url.replace(/\\/g, '/');
      return `${baseUrl}/uploads/${normalized}`;
    };

    const result = courses.map((c) => ({
      id: c.id,
      title: c.title,
      price: c.price,
      thumbnailUrl: formatUrl(c.thumbnailUrl),
      teacherName: c.teacher.name,
      lessonCount: c._count.lessons,
      createdAt: c.createdAt,
    }));

    res.json(result);
  } catch (error) {
    console.error('getAllCourses error:', error);
    res.status(500).json({ error: 'Internal server error' });
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

    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId 
      ? authUser.parentTeacherId 
      : authUser.id;

    const { title, description, price, subject, grade } = req.body as { 
      title?: string; 
      description?: string;
      price?: string;
      subject?: string;
      grade?: string;
    };

    if (!title || title.trim() === '') {
      res.status(400).json({ error: 'Course title is required' });
      return;
    }
    
    // DEBUG: Log what's being received
    console.log('🔥 DEBUG createCourse body:', req.body);

    const parsedPrice = price ? parseFloat(price) : 0;
    if (isNaN(parsedPrice) || parsedPrice < 0) {
      res.status(400).json({ error: 'Price must be a non-negative number' });
      return;
    }

    // Thumbnail is optional — multer puts single file in req.file
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
    let thumbnailUrl: string | undefined;
    if (files?.thumbnail?.[0]) {
      thumbnailUrl = files.thumbnail[0].path.replace(UPLOADS_DIR, '').replace(/^[/\\]/, '');
    }

    const course = await prisma.course.create({
      data: {
        teacherId: ownerId,
        title: title.trim(),
        description: description?.trim() ?? null,
        subject: subject?.trim() ?? null,
        grade: grade?.trim() ?? null,
        price: parsedPrice,
        thumbnailUrl: thumbnailUrl ?? null,
      },
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.status(201).json({
      message: 'Course created successfully',
      course: {
        id: course.id,
        title: course.title,
        price: course.price,
        thumbnailUrl: thumbnailUrl ? `${baseUrl}/uploads/${thumbnailUrl}` : null,
        createdAt: course.createdAt,
      },
    });
  } catch (error) {
    console.error('createCourse error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/courses/:id  — fetch a single course (public)
// ─────────────────────────────────────────────────────────────────────────────
export const getCourseById: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const course = await prisma.course.findUnique({
      where: { id },
      include: {
        lessons: {
          include: { quizzes: true },
          orderBy: { createdAt: 'asc' },
        },
        teacher: { select: { id: true, name: true, vodafoneCashNumber: true, instapayHandle: true } },
      },
    });

    if (!course) {
      res.status(404).json({ error: 'Course not found' });
      return;
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const fmt = (url: string | null | undefined) => {
      if (!url) return null;
      if (url.startsWith('http')) return url;
      return `${baseUrl}/uploads/${url}`;
    };

    res.json({
      id: course.id,
      title: course.title,
      price: course.price,
      description: (course as any).description ?? null,
      subject: (course as any).subject ?? null,
      thumbnailUrl: fmt(course.thumbnailUrl),
      teacher: course.teacher,
      lessons: course.lessons.map((l) => {
        const firstQuiz = l.quizzes && l.quizzes.length > 0 ? l.quizzes[0] : null;
        
        // Parse the questions JSON string to get the actual questions array and timeLimit
        let parsedQuizData: any = null;
        if (firstQuiz?.questions != null) {
          try {
            parsedQuizData = JSON.parse(firstQuiz.questions);
          } catch (e) {
            console.error('Failed to parse quiz questions:', e);
          }
        }
        
        return {
          id: l.id,
          title: l.title,
          thumbnailUrl: fmt(l.thumbnailUrl),
          videoUrl: l.videoUrl ? fmt(l.videoUrl) : null,
          subjectId: l.subjectId,
          createdAt: l.createdAt,
          homeworkPdfUrl: l.homeworkPdfUrl,
          homeworkText: l.homeworkText,
          hasQuiz: firstQuiz !== null,
          quizId: firstQuiz?.id ?? null,
          quiz: firstQuiz ? {
            id: firstQuiz.id,
            title: parsedQuizData != null ? (parsedQuizData['title'] || 'Untitled Quiz') : 'Untitled Quiz',
            questions: parsedQuizData != null && parsedQuizData['questions'] != null 
                ? parsedQuizData['questions'] 
                : [],
            timeLimitMinutes: parsedQuizData != null && parsedQuizData['timeLimit'] != null 
                ? parsedQuizData['timeLimit'] 
                : 30,
          } : null,
        };
      }),
    });
  } catch (error) {
    console.error('getCourseById error:', error);
    res.status(500).json({ error: 'Internal server error' });
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
    const { title, description, price, subject, thumbnailUrl } = req.body as {
      title?: string;
      description?: string;
      price?: string;
      subject?: string;
      thumbnailUrl?: string;
    };

    const course = await prisma.course.findFirst({
      where: { id },
    });

    if (!course) {
      res.status(404).json({ error: 'Course not found' });
      return;
    }

    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId
      ? authUser.parentTeacherId
      : authUser.id;

    if (course.teacherId !== ownerId && authUser.role !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const updateData: any = {};
    if (title !== undefined) updateData.title = title.trim();
    if (description !== undefined) updateData.description = description.trim();
    if (price !== undefined) {
      const parsed = parseFloat(price);
      if (!isNaN(parsed) && parsed >= 0) updateData.price = parsed;
    }
    if (subject !== undefined) updateData.subject = subject.trim();
    if (thumbnailUrl !== undefined) updateData.thumbnailUrl = thumbnailUrl.trim();

    const updated = await prisma.course.update({
      where: { id },
      data: updateData,
    });

    console.log('Course updated:', { id: updated.id, title: updated.title, by: authUser.id });
    res.json({ message: 'Course updated', course: updated });
  } catch (error) {
    console.error('updateCourse error:', error);
    res.status(500).json({ error: 'Internal server error' });
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

    const course = await prisma.course.findFirst({
      where: { id },
    });

    if (!course) {
      res.status(404).json({ error: 'Course not found' });
      return;
    }

    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId
      ? authUser.parentTeacherId
      : authUser.id;

    if (course.teacherId !== ownerId && authUser.role !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.tracking.deleteMany({ where: { lesson: { courseId: id } } });
      await tx.quiz.deleteMany({ where: { lesson: { courseId: id } } });
      await tx.lesson.deleteMany({ where: { courseId: id } });
      await tx.courseEnrollment.deleteMany({ where: { courseId: id } });
      await tx.course.delete({ where: { id } });
    });

    console.log('Course DELETED (cascade):', { id, title: course.title, by: authUser.id });
    res.json({ message: 'Course deleted successfully' });
  } catch (error) {
    console.error('deleteCourse error:', error);
    res.status(500).json({ error: 'Internal server error' });
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

    const course = await prisma.course.findFirst({ where: { id } });
    if (!course) {
      res.status(404).json({ error: 'Course not found' });
      return;
    }

    const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId
      ? authUser.parentTeacherId
      : authUser.id;

    if (course.teacherId !== ownerId && authUser.role !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
    const relativePath = file.path.replace(UPLOADS_DIR, '').replace(/^[/\\]/, '');

    const updated = await prisma.course.update({
      where: { id },
      data: { thumbnailUrl: relativePath },
    });

    console.log('Thumbnail uploaded:', { courseId: id, relativePath, by: authUser.id });
    res.json({ message: 'Thumbnail updated', thumbnailUrl: `/uploads/${relativePath}`, courseId: updated.id });
  } catch (error) {
    console.error('uploadThumbnail error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
