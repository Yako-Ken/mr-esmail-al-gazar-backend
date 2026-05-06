import { Request, Response, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthUser } from '../middlewares/auth.middleware';

const prisma = new PrismaClient();

interface QuizQuestion {
  question: string;
  options: string[];
  correctAnswer: number;
  type?: string;
  essayAnswer?: string;
  points?: number;
}

export const markAttendance: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { lessonId } = req.body;
    const authUser = (req as Request & { user?: AuthUser }).user;
    const studentId = authUser?.id;

    if (!studentId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!lessonId) {
      res.status(400).json({ error: 'Lesson ID is required' });
      return;
    }

    const tracking = await prisma.tracking.upsert({
      where: {
        studentId_lessonId: {
          studentId,
          lessonId,
        },
      },
      update: {
        isPresent: true,
      },
      create: {
        studentId,
        lessonId,
        isPresent: true,
      },
    });

    res.json(tracking);
  } catch (error) {
    console.error('Mark attendance error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const submitQuiz: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { lessonId, answers } = req.body;
    const authUser = (req as Request & { user?: AuthUser }).user;
    const studentId = authUser?.id;

    if (!studentId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!lessonId || !answers) {
      res.status(400).json({ error: 'Lesson ID and answers are required' });
      return;
    }

    // Anti-cheat lockout: check if the student already submitted a score
    const existingTracking = await prisma.tracking.findUnique({
      where: { studentId_lessonId: { studentId, lessonId } },
    });

    if (existingTracking && existingTracking.quizScore !== null) {
      res.status(409).json({
        error: 'Quiz already submitted',
        score: existingTracking.quizScore,
      });
      return;
    }
    
    // Anti-Cheat: If answers is empty [], record 0 in Tracking table without over-validating the quiz structure
    if (answers.length === 0) {
      const tracking = await prisma.tracking.upsert({
        where: { studentId_lessonId: { studentId, lessonId } },
        update: { quizScore: 0, hwStatus: 'SUBMITTED' },
        create: { studentId, lessonId, quizScore: 0, hwStatus: 'SUBMITTED' },
      });
      res.json({ score: 0, totalQuestions: 0, correctAnswers: 0, tracking });
      return;
    }

    const quiz = await prisma.quiz.findFirst({
      where: { lessonId },
    });

    if (!quiz) {
      res.status(404).json({ error: 'Quiz not found for this lesson' });
      return;
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
      : (parsedData && parsedData.questions ? parsedData.questions : []);

    let correctCount = 0;
    let mcqScore = 0;
    let hasEssayQuestions = false;

    // Combined answers map: mcq_N for MCQs (score stored), essay_N for essays (score=0 until graded)
    // Both live in the same JSON blob so gradeEssay can SUM all entries for a clean recalculation.
    const answersMap: Record<string, any> = {};

    console.log('DEBUG - Received answers:', JSON.stringify(answers));
    console.log('DEBUG - Questions:', questions.map((q: any) => `[${q.type}] correctIndex=${q.correctIndex} correctAnswer=${q.correctAnswer}`));

    questions.forEach((question: any, index: number) => {
      const qType = (question.type || '').toLowerCase().replace(/[_\s]/g, '');
      const isEssay = qType === 'essay' || qType === 'essayanswer' || qType === 'shortanswer';
      const rawAnswer = index < answers.length ? answers[index] : null;

      if (isEssay) {
        hasEssayQuestions = true;
        let essayText = '';
        if (typeof rawAnswer === 'string') {
          essayText = rawAnswer;
        } else if (rawAnswer && typeof rawAnswer === 'object') {
          essayText = rawAnswer.text || rawAnswer.answerText || rawAnswer.value || '';
        }
        console.log(`Essay [${index}]: "${essayText}"`);

        answersMap[`essay_${index}`] = {
          questionText:  question.question || question.text || '',
          answerText:    essayText,
          type:          question.type,
          maxPoints:     question.points || question.maxPoints || 10,
          score:         0,
          awardedPoints: 0,
          earnedPoints:  0,
          isGraded:      false,
          status:        'PENDING',
        };
      } else {
        // MCQ — FIX: Flutter saves correctIndex; legacy used correctAnswer. Support both.
        const correctIndex = question.correctIndex ?? question.correctAnswer;
        const maxPoints    = question.points || question.maxPoints || 1;

        // FIX: support raw integer answer OR object { selectedOptionIndex }
        let selectedIndex: number | undefined;
        if (typeof rawAnswer === 'number') {
          selectedIndex = rawAnswer;
        } else if (rawAnswer !== null && typeof rawAnswer === 'object') {
          selectedIndex = rawAnswer.selectedOptionIndex ?? rawAnswer.optionIndex ?? rawAnswer.answer;
        }

        const isCorrect = selectedIndex !== undefined
          && correctIndex !== undefined
          && selectedIndex === correctIndex;

        const earned = isCorrect ? maxPoints : 0;
        if (isCorrect) { mcqScore += earned; correctCount++; }

        console.log(`MCQ [${index}]: selected=${selectedIndex}, correct=${correctIndex}, earned=${earned}/${maxPoints}`);

        // Store MCQ answer with score so gradeEssay can SUM all entries
        answersMap[`mcq_${index}`] = {
          questionText:        question.question || question.text || '',
          type:                question.type,
          selectedOptionIndex: selectedIndex,
          correctIndex,
          maxPoints,
          score:         earned,
          awardedPoints: earned,
          earnedPoints:  earned,
          isCorrect,
        };
      }
    });

    const hwStatus       = hasEssayQuestions ? 'PENDING' : 'SUBMITTED';
    const score          = mcqScore; // essay scores added after teacher grades
    const answersMapJson = JSON.stringify(answersMap);

    console.log(`✅ Quiz graded: mcqScore=${mcqScore}, hasEssay=${hasEssayQuestions}, hwStatus=${hwStatus}`);

    const tracking = await prisma.tracking.upsert({
      where:  { studentId_lessonId: { studentId, lessonId } },
      update: { quizScore: score, hwStatus, essayAnswers: answersMapJson },
      create: { studentId, lessonId, quizScore: score, hwStatus, essayAnswers: answersMapJson },
    });

    res.json({
      score,
      totalQuestions:     questions.length,
      correctAnswers:     correctCount,
      tracking,
      needsManualGrading: hwStatus === 'PENDING',
    });
  } catch (error) {
    console.error('Submit quiz error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const fetchStudents: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    const teacherId = authUser?.id;

    if (!teacherId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const ownerId = authUser?.role === 'ASSISTANT' && authUser?.parentTeacherId 
      ? authUser.parentTeacherId 
      : teacherId;

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

    res.json(Array.from(studentMap.values()));
  } catch (error) {
    console.error('Fetch students error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getLessons: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { subject, grade, teacherId: queryTeacherId } = req.query;

    const lessons = await prisma.lesson.findMany({
      where: {
        ...(subject       ? { subject: subject as string }             : {}),
        ...(grade         ? { grade: grade as string }                 : {}),
        ...(queryTeacherId ? { teacherId: queryTeacherId as string }   : {}),
      },
      include: { quizzes: true },
      orderBy: { createdAt: 'desc' },
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const formatUrl = (url: string | null | undefined) => {
      if (!url) return null;
      if (url.startsWith('http')) return url;
      const normalized = url.replace(/\\/g, '/');
      const clean = normalized.startsWith('/') ? normalized.slice(1) : normalized;
      return clean.startsWith('uploads/')
        ? `${baseUrl}/${clean}`
        : `${baseUrl}/uploads/${clean}`;
    };

    const result = lessons.map(lesson => ({
      id:            lesson.id,
      title:         lesson.title,
      description:   lesson.description,
      subject:       lesson.subject,
      grade:         lesson.grade,
      teacherId:     lesson.teacherId,
      courseId:      lesson.courseId,
      videoUrl:      formatUrl(lesson.videoUrl),
      thumbnailUrl:  formatUrl(lesson.thumbnailUrl),
      pdfUrl:        formatUrl(lesson.pdfUrl),
      homeworkText:  lesson.homeworkText,
      homeworkPdfUrl: formatUrl(lesson.homeworkPdfUrl),
      hasQuiz:       lesson.quizzes.length > 0,
      createdAt:     lesson.createdAt,
    }));

    res.json(result);
  } catch (error) {
    console.error('Get lessons error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const createLesson: RequestHandler = async (req, res): Promise<void> => {
  console.log('RECEIVED LESSON DATA:', req.body);
  console.log('Content-Type:', req.headers['content-type']);
  console.log('Body keys:', Object.keys(req.body));
  
  try {
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
      hasQuiz
    } = req.body;

    const authUser = (req as Request & { user?: AuthUser }).user;
    const teacherId = authUser?.id;

    console.log('Auth check - teacherId:', teacherId, 'authUser:', authUser);

    if (!teacherId) {
      console.error('🚨 VALIDATION FAILED: No teacherId found in auth user');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const cleanTitle = title?.toString()?.trim();
    const cleanCourseId = courseId?.toString()?.trim();
    const cleanVideoUrl = videoUrl?.toString()?.trim();

    console.log('Required fields check - title:', cleanTitle, 'courseId:', cleanCourseId, 'videoUrl:', cleanVideoUrl);

    if (!cleanTitle || !cleanCourseId || !cleanVideoUrl) {
      console.error('🚨 VALIDATION FAILED: Missing required fields (title, courseId, or videoUrl)');
      res.status(400).json({ error: 'Title, courseId, and videoUrl are required' });
      return;
    }

    // Fetch subject and grade from the associated course
    const course = await prisma.course.findUnique({
      where: { id: cleanCourseId },
    });

    if (!course) {
      console.error('🚨 VALIDATION FAILED: Course not found:', cleanCourseId);
      res.status(400).json({ error: 'Course not found' });
      return;
    }

    const cleanSubject = subject?.toString()?.trim() || course.subject || null;
    const cleanGrade = grade?.toString()?.trim() || course.grade || null;

    const ownerId = authUser?.role === 'ASSISTANT' && authUser?.parentTeacherId 
      ? authUser.parentTeacherId 
      : teacherId;

    // Convert string booleans to actual booleans (optional)
    const isQuizAttached = hasQuiz === 'true' || hasQuiz === true;

    // Clean and cast optional fields
    const cleanDescription = description === '' || description === undefined ? null : (description?.toString() || null);
    const cleanThumbnailUrl = thumbnailUrl === '' || thumbnailUrl === undefined ? null : (thumbnailUrl?.toString() || null);
    const cleanPdfUrl = pdfUrl === '' || pdfUrl === undefined ? null : (pdfUrl?.toString() || null);
    const cleanHomeworkText = homeworkText === '' || homeworkText === undefined ? null : (homeworkText?.toString() || null);

    let parsedQuizData: any = null;
    let quizTitle = '';
    if (quizData) {
      try {
        parsedQuizData = typeof quizData === 'string' ? JSON.parse(quizData) : quizData;
        quizTitle = parsedQuizData.title || '';
      } catch (e) {
        console.error('Failed to parse quizData:', e);
      }
    }

    console.log('Parsed quizData:', parsedQuizData);
    console.log('Quiz title:', quizTitle);
    console.log('isQuizAttached:', isQuizAttached);

    try {
      const lesson = await prisma.lesson.create({
        data: {
          subject: cleanSubject,
          grade: cleanGrade,
          teacherId: ownerId,
          title: cleanTitle,
          description: cleanDescription,
          videoUrl: cleanVideoUrl,
          thumbnailUrl: cleanThumbnailUrl,
          pdfUrl: cleanPdfUrl,
          homeworkText: cleanHomeworkText,
          ...(cleanCourseId ? { courseId: cleanCourseId } : {}),
          
          ...(parsedQuizData || isQuizAttached ? {
            quizzes: {
              create: {
                questions: JSON.stringify({
                  title: quizTitle,
                  questions: parsedQuizData?.questions || [],
                  timeLimit: parsedQuizData?.timeLimit || 0,
                }),
              },
            },
          } : {}),
        },
      });

      res.json({ success: true, data: lesson });
    } catch (prismaError: any) {
      console.error('🔥 PRISMA CREATION ERROR:', prismaError);
      res.status(400).json({ 
        success: false, 
        message: prismaError.message || 'Database creation failed',
        details: prismaError 
      });
    }
  } catch (error: any) {
    console.error('Create lesson error:', error);
    res.status(400).json({ 
      success: false, 
      message: error.message || 'Validation failed', 
      details: error 
    });
  }
};

export const updateLesson: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const { title, description, homeworkText, thumbnailUrl, videoUrl, homeworkPdfUrl } = req.body;
    const authUser = (req as Request & { user?: AuthUser }).user;
    const teacherId = authUser?.id;

    if (!teacherId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const ownerId = authUser?.role === 'ASSISTANT' && authUser?.parentTeacherId 
      ? authUser.parentTeacherId 
      : teacherId;

    const existingLesson = await prisma.lesson.findUnique({
      where: { id },
    });

    if (!existingLesson) {
      res.status(404).json({ error: 'Lesson not found' });
      return;
    }

    if (existingLesson.teacherId !== ownerId) {
      res.status(403).json({ error: 'You can only update your own lessons' });
      return;
    }

    const lesson = await prisma.lesson.update({
      where: { id },
      data: {
        title: title || existingLesson.title,
        description: description !== undefined ? (description || null) : existingLesson.description,
        homeworkText: homeworkText !== undefined ? (homeworkText || null) : existingLesson.homeworkText,
        thumbnailUrl: thumbnailUrl !== undefined ? (thumbnailUrl || null) : existingLesson.thumbnailUrl,
        videoUrl: videoUrl !== undefined ? (videoUrl || null) : existingLesson.videoUrl,
        homeworkPdfUrl: homeworkPdfUrl !== undefined ? (homeworkPdfUrl || null) : existingLesson.homeworkPdfUrl,
      },
    });

    res.json(lesson);
  } catch (error) {
    console.error('Update lesson error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const deleteLesson: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const authUser = (req as Request & { user?: AuthUser }).user;
    const teacherId = authUser?.id;

    if (!teacherId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const ownerId = authUser?.role === 'ASSISTANT' && authUser?.parentTeacherId 
      ? authUser.parentTeacherId 
      : teacherId;

    const existingLesson = await prisma.lesson.findUnique({
      where: { id },
    });

    if (!existingLesson) {
      res.status(404).json({ error: 'Lesson not found' });
      return;
    }

    if (existingLesson.teacherId !== ownerId) {
      res.status(403).json({ error: 'You can only delete your own lessons' });
      return;
    }

    //... existing block end
    await prisma.lesson.delete({
      where: { id },
    });

    res.json({ message: 'Lesson deleted successfully' });
  } catch (error) {
    console.error('Delete lesson error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getLessonById: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const authUser = (req as Request & { user?: AuthUser }).user;

    const lesson = await prisma.lesson.findUnique({
      where: { id },
      include: {
        teacher: { select: { id: true, name: true } },
        quizzes: true,
      },
    });

    if (!lesson) {
      res.status(404).json({ error: 'Lesson not found' });
      return;
    }

    let userTracking = null;
    if (authUser && authUser.role === 'STUDENT') {
      userTracking = await prisma.tracking.findUnique({
        where: { studentId_lessonId: { studentId: authUser.id, lessonId: id } }
      });

      if (lesson.courseId) {
        const enrollment = await prisma.courseEnrollment.findUnique({
          where: { studentId_courseId: { studentId: authUser.id, courseId: lesson.courseId } },
        });
        if (!enrollment || enrollment.status !== 'APPROVED') {
          res.status(403).json({ error: 'You do not have access to this lesson' });
          return;
        }
      } else {
        res.status(403).json({ error: 'Lessons without a valid course access are locked' });
        return;
      }
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const formatUrl = (url: string | null | undefined) => {
      if (!url) return null;
      if (url.startsWith('http')) return url;
      const normalized = url.replace(/\\/g, '/');
      const clean = normalized.startsWith('/') ? normalized.slice(1) : normalized;
      return clean.startsWith('uploads/') ? `${baseUrl}/${clean}` : `${baseUrl}/uploads/${clean}`;
    };

    res.json({
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
      hasQuiz: lesson.quizzes.length > 0,
      hasCompletedQuiz: userTracking != null && userTracking.quizScore !== null,
      quizScore: userTracking?.quizScore ?? null,
      createdAt: lesson.createdAt,
      teacher: lesson.teacher,
    });
  } catch (error) {
    console.error('getLessonById error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
