import { PrismaClient, Tracking } from '@prisma/client';
import { AuthUser } from '../middlewares/auth.middleware';
import { resolveOwnerId } from '../utils/ownerId';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/appError';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

interface QuizQuestion {
  question: string;
  options: string[];
  correctAnswer: number;
  type?: string;
  essayAnswer?: string;
  points?: number;
}

export interface LessonInput {
  subject?: string;
  grade?: string;
  title?: string;
  description?: string;
  videoUrl?: string;
  thumbnailUrl?: string;
  pdfUrl?: string;
  homeworkText?: string;
  courseId?: string;
  quizData?: unknown;
  hasQuiz?: unknown;
  homeworkPdfUrl?: string;
  bunnyVideoId?: string;
  videoLibraryId?: string;
}

export interface LessonListFilters {
  subject?: string;
  grade?: string;
  teacherId?: string;
}

export type SubmitQuizResult =
  | { status: 'alreadySubmitted'; score: number | null }
  | { status: 'emptyAnswers'; tracking: Tracking }
  | {
      status: 'graded';
      score: number;
      totalQuestions: number;
      correctAnswers: number;
      tracking: Tracking;
      needsManualGrading: boolean;
    };

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lessons/mark-attendance
// ─────────────────────────────────────────────────────────────────────────────
export const markAttendance = (studentId: string, lessonId: string) => {
  if (!lessonId) {
    throw new BadRequestError('Lesson ID is required');
  }

  return prisma.tracking.upsert({
    where: { studentId_lessonId: { studentId, lessonId } },
    update: { isPresent: true },
    create: { studentId, lessonId, isPresent: true },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lessons/submit-quiz
// ─────────────────────────────────────────────────────────────────────────────
export const submitQuiz = async (
  studentId: string,
  lessonId: string,
  answers: unknown[]
): Promise<SubmitQuizResult> => {
  if (!lessonId || !answers) {
    throw new BadRequestError('Lesson ID and answers are required');
  }

  // Anti-cheat lockout: check if the student already submitted a score
  const existingTracking = await prisma.tracking.findUnique({
    where: { studentId_lessonId: { studentId, lessonId } },
  });

  if (existingTracking && existingTracking.quizScore !== null) {
    return { status: 'alreadySubmitted', score: existingTracking.quizScore };
  }

  // Anti-Cheat: If answers is empty [], record 0 in Tracking table without over-validating the quiz structure
  if (answers.length === 0) {
    const tracking = await prisma.tracking.upsert({
      where: { studentId_lessonId: { studentId, lessonId } },
      update: { quizScore: 0, essayStatus: 'GRADED' },
      create: { studentId, lessonId, quizScore: 0, essayStatus: 'GRADED' },
    });
    return { status: 'emptyAnswers', tracking };
  }

  const quiz = await prisma.quiz.findFirst({ where: { lessonId } });
  if (!quiz) {
    throw new NotFoundError('Quiz not found for this lesson');
  }

  let parsedData: any;
  try {
    parsedData = JSON.parse(quiz.questions);
    if (typeof parsedData === 'string') parsedData = JSON.parse(parsedData);
  } catch (e) {
    parsedData = [];
  }

  const questions: QuizQuestion[] = Array.isArray(parsedData)
    ? parsedData
    : parsedData && parsedData.questions
    ? parsedData.questions
    : [];

  let correctCount = 0;
  let mcqScore = 0;
  let hasEssayQuestions = false;

  // Combined answers map: mcq_N for MCQs (score stored), essay_N for essays (score=0 until graded)
  // Both live in the same JSON blob so gradeEssay can SUM all entries for a clean recalculation.
  const answersMap: Record<string, any> = {};

  questions.forEach((question: any, index: number) => {
    const qType = (question.type || '').toLowerCase().replace(/[_\s]/g, '');
    const isEssay = qType === 'essay' || qType === 'essayanswer' || qType === 'shortanswer';
    const rawAnswer: any = index < answers.length ? answers[index] : null;

    if (isEssay) {
      hasEssayQuestions = true;
      let essayText = '';
      if (typeof rawAnswer === 'string') {
        essayText = rawAnswer;
      } else if (rawAnswer && typeof rawAnswer === 'object') {
        essayText = rawAnswer.text || rawAnswer.answerText || rawAnswer.value || '';
      }

      answersMap[`essay_${index}`] = {
        questionText: question.question || question.text || '',
        answerText: essayText,
        type: question.type,
        maxPoints: question.points || question.maxPoints || 10,
        score: 0,
        awardedPoints: 0,
        earnedPoints: 0,
        isGraded: false,
        status: 'PENDING',
      };
    } else {
      // MCQ — FIX: Flutter saves correctIndex; legacy used correctAnswer. Support both.
      const correctIndex = question.correctIndex ?? question.correctAnswer;
      const maxPoints = question.points || question.maxPoints || 1;

      // FIX: support raw integer answer OR object { selectedOptionIndex }
      let selectedIndex: number | undefined;
      if (typeof rawAnswer === 'number') {
        selectedIndex = rawAnswer;
      } else if (rawAnswer !== null && typeof rawAnswer === 'object') {
        selectedIndex = rawAnswer.selectedOptionIndex ?? rawAnswer.optionIndex ?? rawAnswer.answer;
      }

      const isCorrect =
        selectedIndex !== undefined && correctIndex !== undefined && selectedIndex === correctIndex;

      const earned = isCorrect ? maxPoints : 0;
      if (isCorrect) {
        mcqScore += earned;
        correctCount++;
      }

      // Store MCQ answer with score so gradeEssay can SUM all entries
      answersMap[`mcq_${index}`] = {
        questionText: question.question || question.text || '',
        type: question.type,
        selectedOptionIndex: selectedIndex,
        correctIndex,
        maxPoints,
        score: earned,
        awardedPoints: earned,
        earnedPoints: earned,
        isCorrect,
      };
    }
  });

  const hwStatus = hasEssayQuestions ? 'PENDING' : 'SUBMITTED';
  const essayStatus = hasEssayQuestions ? 'PENDING' : 'GRADED';
  const score = mcqScore; // essay scores added after teacher grades
  const answersMapJson = JSON.stringify(answersMap);

  logger.info(`Quiz graded: mcqScore=${mcqScore}, hasEssay=${hasEssayQuestions}, hwStatus=${hwStatus}, essayStatus=${essayStatus}`);

  const tracking = await prisma.tracking.upsert({
    where: { studentId_lessonId: { studentId, lessonId } },
    update: { quizScore: score, essayStatus, essayAnswers: answersMapJson },
    create: { studentId, lessonId, quizScore: score, essayStatus, essayAnswers: answersMapJson },
  });

  return {
    status: 'graded',
    score,
    totalQuestions: questions.length,
    correctAnswers: correctCount,
    tracking,
    needsManualGrading: hwStatus === 'PENDING',
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lessons/fetch-students
// ─────────────────────────────────────────────────────────────────────────────
export const fetchStudents = async (authUser: AuthUser) => {
  const ownerId = resolveOwnerId(authUser);

  // Query lessons directly by teacherId — no Subject FK needed
  const lessons = await prisma.lesson.findMany({
    where: { teacherId: ownerId },
    include: {
      trackings: {
        include: { student: true },
      },
    },
  });

  const studentMap = new Map<string, Record<string, unknown>>();

  lessons.forEach((lesson) => {
    lesson.trackings.forEach((tracking) => {
      const student = tracking.student;
      if (!studentMap.has(student.id)) {
        studentMap.set(student.id, {
          id: student.id,
          name: student.name,
          phone: student.phone,
          lessons: [],
        });
      }
      const studentData = studentMap.get(student.id);
      if (studentData && Array.isArray(studentData.lessons)) {
        studentData.lessons.push({
          lessonId: lesson.id,
          title: lesson.title,
          subject: lesson.subject,
          grade: lesson.grade,
          isPresent: tracking.isPresent,
          hwStatus: tracking.hwStatus,
          quizScore: tracking.quizScore,
        });
      }
    });
  });

  return Array.from(studentMap.values());
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lessons  (and /api/lessons/public)
// ─────────────────────────────────────────────────────────────────────────────
export const listLessons = (filters: LessonListFilters) => {
  return prisma.lesson.findMany({
    where: {
      ...(filters.subject ? { subject: filters.subject } : {}),
      ...(filters.grade ? { grade: filters.grade } : {}),
      ...(filters.teacherId ? { teacherId: filters.teacherId } : {}),
    },
    include: { quizzes: true },
    orderBy: { createdAt: 'desc' },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lessons
// ─────────────────────────────────────────────────────────────────────────────
export const createLesson = async (authUser: AuthUser, body: LessonInput) => {
  const {
    subject,
    grade,
    title,
    description,
    videoUrl,
    thumbnailUrl,
    pdfUrl,
    homeworkText,
    courseId,
    quizData,
    hasQuiz,
    homeworkPdfUrl,
    bunnyVideoId,
    videoLibraryId,
  } = body;

  const cleanTitle = title?.toString()?.trim();
  const cleanCourseId = courseId?.toString()?.trim();
  const cleanVideoUrl = videoUrl?.toString()?.trim();

  if (!cleanTitle || !cleanCourseId || (!cleanVideoUrl && !bunnyVideoId)) {
    throw new BadRequestError('Title, courseId, and a video source are required');
  }

  // Fetch subject and grade from the associated course
  const course = await prisma.course.findUnique({ where: { id: cleanCourseId } });
  if (!course) {
    throw new BadRequestError('Course not found');
  }

  const cleanSubject = subject?.toString()?.trim() || course.subject || null;
  const cleanGrade = grade?.toString()?.trim() || course.grade || null;

  const ownerId = resolveOwnerId(authUser);

  // Convert string booleans to actual booleans (optional)
  const isQuizAttached = hasQuiz === 'true' || hasQuiz === true;

  // Clean and cast optional fields
  const cleanDescription = description === '' || description === undefined ? null : description?.toString() || null;
  const cleanThumbnailUrl =
    thumbnailUrl === '' || thumbnailUrl === undefined ? null : thumbnailUrl?.toString() || null;
  const cleanPdfUrl = pdfUrl === '' || pdfUrl === undefined ? null : pdfUrl?.toString() || null;
  const cleanHomeworkText =
    homeworkText === '' || homeworkText === undefined ? null : homeworkText?.toString() || null;
  const cleanHomeworkPdfUrl =
    homeworkPdfUrl === '' || homeworkPdfUrl === undefined ? null : homeworkPdfUrl?.toString() || null;

  let parsedQuizData: any = null;
  let quizTitle = '';
  if (quizData) {
    try {
      parsedQuizData = typeof quizData === 'string' ? JSON.parse(quizData) : quizData;
      quizTitle = parsedQuizData.title || '';
    } catch (e) {
      logger.error('Failed to parse quizData:', e);
    }
  }

  const lesson = await prisma.lesson.create({
    data: {
      subject: cleanSubject,
      grade: cleanGrade,
      teacherId: ownerId,
      title: cleanTitle,
      description: cleanDescription,
      videoUrl: cleanVideoUrl || null,
      bunnyVideoId: bunnyVideoId || null,
      videoLibraryId: videoLibraryId || null,
      thumbnailUrl: cleanThumbnailUrl,
      pdfUrl: cleanPdfUrl,
      homeworkText: cleanHomeworkText,
      homeworkPdfUrl: cleanHomeworkPdfUrl,
      ...(cleanCourseId ? { courseId: cleanCourseId } : {}),
      ...(parsedQuizData || isQuizAttached
        ? {
            quizzes: {
              create: {
                questions: JSON.stringify({
                  title: quizTitle,
                  questions: parsedQuizData?.questions || [],
                  timeLimit: parsedQuizData?.timeLimit || 0,
                }),
              },
            },
          }
        : {}),
    },
  });

  return lesson;
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/lessons/:id
// ─────────────────────────────────────────────────────────────────────────────
export const updateLesson = async (id: string, authUser: AuthUser, body: LessonInput) => {
  const { title, description, homeworkText, thumbnailUrl, videoUrl, homeworkPdfUrl, bunnyVideoId, videoLibraryId } =
    body;

  const ownerId = resolveOwnerId(authUser);

  const existingLesson = await prisma.lesson.findUnique({ where: { id } });
  if (!existingLesson) {
    throw new NotFoundError('Lesson not found');
  }

  if (existingLesson.teacherId !== ownerId) {
    throw new ForbiddenError('You can only update your own lessons');
  }

  return prisma.lesson.update({
    where: { id },
    data: {
      title: title || existingLesson.title,
      description: description !== undefined ? description || null : existingLesson.description,
      homeworkText: homeworkText !== undefined ? homeworkText || null : existingLesson.homeworkText,
      thumbnailUrl: thumbnailUrl !== undefined ? thumbnailUrl || null : existingLesson.thumbnailUrl,
      videoUrl: videoUrl !== undefined ? videoUrl || null : existingLesson.videoUrl,
      bunnyVideoId: bunnyVideoId !== undefined ? bunnyVideoId || null : existingLesson.bunnyVideoId,
      videoLibraryId: videoLibraryId !== undefined ? videoLibraryId || null : existingLesson.videoLibraryId,
      homeworkPdfUrl: homeworkPdfUrl !== undefined ? homeworkPdfUrl || null : existingLesson.homeworkPdfUrl,
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/lessons/:id
// ─────────────────────────────────────────────────────────────────────────────
export const deleteLesson = async (id: string, authUser: AuthUser) => {
  const ownerId = resolveOwnerId(authUser);

  const existingLesson = await prisma.lesson.findUnique({ where: { id } });
  if (!existingLesson) {
    throw new NotFoundError('Lesson not found');
  }

  if (existingLesson.teacherId !== ownerId) {
    throw new ForbiddenError('You can only delete your own lessons');
  }

  await prisma.lesson.delete({ where: { id } });
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lessons/:id
// ─────────────────────────────────────────────────────────────────────────────
export const getLessonById = async (id: string, authUser?: AuthUser) => {
  const lesson = await prisma.lesson.findUnique({
    where: { id },
    include: {
      teacher: { select: { id: true, name: true } },
      quizzes: true,
    },
  });

  if (!lesson) {
    throw new NotFoundError('Lesson not found');
  }

  if (!authUser) throw new ForbiddenError('Authentication is required');

  let userTracking = null;
  if (authUser.role === 'STUDENT') {
    userTracking = await prisma.tracking.findUnique({
      where: { studentId_lessonId: { studentId: authUser.id, lessonId: id } },
    });

    if (!lesson.courseId) {
      throw new ForbiddenError('Lessons without a valid course access are locked');
    }
    const enrollment = await prisma.courseEnrollment.findUnique({
      where: { studentId_courseId: { studentId: authUser.id, courseId: lesson.courseId } },
    });
    if (!enrollment || enrollment.status !== 'APPROVED') {
      throw new ForbiddenError('You do not have access to this lesson');
    }
  } else if (authUser.role === 'TEACHER' || authUser.role === 'ASSISTANT') {
    const ownerId = authUser.role === 'TEACHER' ? authUser.id : authUser.parentTeacherId;
    if (!ownerId || lesson.teacherId !== ownerId) {
      throw new ForbiddenError('You can only access lessons owned by your teacher account');
    }
  } else if (authUser.role !== 'SUPER_ADMIN') {
    throw new ForbiddenError('Your role cannot access lesson media');
  }

  return { lesson, userTracking };
};
