import { Router, Request, Response, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthUser } from '../middlewares/auth.middleware';
import { submitQuiz } from '../controllers/lesson.controller';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = Router();
const prisma = new PrismaClient();

// ─── Multer storage for homework file uploads ─────────────────────────────────
const homeworkStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.cwd(), 'uploads', 'homeworks');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, `hw-${unique}${ext}`);
  },
});

const homeworkUpload = multer({
  storage: homeworkStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and image files are allowed'));
    }
  },
});

// ─── GET /api/quiz/pending-essays ───────────────────────────────────────────────
// MUST be at the TOP to avoid being caught by /:lessonId wildcard route
const getPendingEssays: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser || authUser.role !== 'TEACHER') {
      res.status(403).json({ error: 'Only teachers can access this endpoint' });
      return;
    }

    const ownerId = (authUser as any).role === 'ASSISTANT' && (authUser as any).parentTeacherId
      ? (authUser as any).parentTeacherId
      : authUser.id;

    const courseId = req.query.courseId as string;
    const quizId = req.query.quizId as string;

    if (!quizId) {
      res.status(400).json({ error: 'quizId is required' });
      return;
    }

    // Verify course ownership
    if (courseId) {
      const course = await prisma.course.findFirst({
        where: { id: courseId, teacherId: ownerId },
      });
      if (!course) {
        res.status(403).json({ error: 'Course not found or forbidden' });
        return;
      }
    }

    // Find the Quiz using quizId (Quiz UUID)
    const quiz = await prisma.quiz.findUnique({
      where: { id: quizId },
    });

    if (!quiz) {
      res.status(404).json({ error: 'Quiz not found' });
      return;
    }

    // Get the lesson ID from the quiz
    const lessonId = quiz.lessonId;

    // Parse quiz questions to find essay questions with their points and model answer
    let essayQuestions: any[] = [];
    let quizData: any = null;
    try {
      quizData = JSON.parse(quiz.questions);
      // Get all questions - handle both {questions: [...]} and direct array formats
      const allQuestions = quizData.questions || quizData || [];
      essayQuestions = allQuestions.filter(
        (q: any) => q.type === 'essay' || q.type === 'essayAnswer'
      );
      // Transform to include all needed fields for frontend
      essayQuestions = essayQuestions.map((q: any, index: number) => ({
        id: q.id || q.questionId || `essay_${index}`,
        type: q.type,
        question: q.question || q.text || q.questionText || '',
        essayAnswer: q.essayAnswer || q.modelAnswer || q.answer || q.correctAnswer || '',
        points: q.points || q.mark || q.score || q.maxPoints || 10,
      }));
      console.log('Parsed essay questions:', JSON.stringify(essayQuestions));
    } catch (e) {
      console.error('Failed to parse quiz questions:', e);
    }

    // Get all enrolled students in the course
    const enrollments = await prisma.courseEnrollment.findMany({
      where: { courseId: courseId, status: 'APPROVED' },
      include: { student: true },
    });

    // Get all trackings for this lesson
    const trackings = await prisma.tracking.findMany({
      where: { lessonId: lessonId },
      include: { student: true },
    });

    // Map students to submissions with proper status
    const students = enrollments.map(enrollment => {
      const tracking = trackings.find(t => t.studentId === enrollment.studentId);
      
      // Determine status: NOT_STARTED, PENDING_GRADING, or GRADED
      // Check hwStatus for pending (essay questions need manual grading)
      let status: string;
      let needsManualGrading: boolean;
      let answer: string;
      let submission: any = null;
      
      if (tracking) {
        // Parse essay answers from tracking if available
        let parsedEssayAnswers: Record<string, any> = {};
        if (tracking?.essayAnswers) {
          try {
            parsedEssayAnswers = JSON.parse(tracking.essayAnswers);
          } catch (e) {
            console.error('Failed to parse essay answers:', e);
          }
        }
        
        // Build answers array for frontend extraction with question details
        const answers: any[] = [];
        let essayAnswerText = '';
        
        for (const [key, value] of Object.entries(parsedEssayAnswers)) {
          if (typeof value === 'object' && value !== null) {
            // New format: { questionText, answerText, type }
            answers.push({
              questionId: key,
              questionText: value.questionText || '',
              answerText: value.answerText || '',
              questionType: value.type || 'essay',
            });
            if (value.answerText && value.answerText.trim()) {
              essayAnswerText += (essayAnswerText ? '\n\n' : '') + value.answerText;
            }
          } else if (typeof value === 'string') {
            // Legacy format: just the answer text
            answers.push({
              questionId: key,
              questionText: '',
              answerText: value,
              questionType: 'essay',
            });
            if (value.trim()) {
              essayAnswerText += (essayAnswerText ? '\n\n' : '') + value;
            }
          }
        }
        
        if (tracking.essayStatus === 'PENDING') {
          // Student has submitted but NOT yet graded by teacher
          status = 'PENDING_GRADING';
          needsManualGrading = true;
          answer = essayAnswerText || '';
        } else if (tracking.essayStatus === 'GRADED') {
          // Student has been graded (either auto-graded or manually by teacher)
          status = 'GRADED';
          needsManualGrading = false;
          answer = essayAnswerText || '';
        } else if (tracking.quizScore !== null) {
          // Fallback for old records without essayStatus but with a score
          status = 'GRADED';
          needsManualGrading = false;
          answer = essayAnswerText || '';
        } else {
          // No submission yet
          status = 'NOT_STARTED';
          needsManualGrading = false;
          answer = '';
        }
        
        // Create submission object with needsManualGrading for frontend to parse
        submission = {
          id: tracking.id,
          needsManualGrading: needsManualGrading,
          status: status,
          score: tracking.quizScore,
          answers: answers,
          answer: essayAnswerText, // Direct answer text for easy access
          feedback: null,
        };
      } else {
        // Student has not taken the quiz at all
        status = 'NOT_STARTED';
        needsManualGrading = false;
        answer = '';
      }

      return {
        id: tracking?.id || `${enrollment.studentId}-${lessonId}`,
        studentId: enrollment.studentId,
        studentName: enrollment.student.name,
        studentPhone: enrollment.student.phone,
        trackingId: tracking?.id ?? '',
        answer: answer,
        status: status,
        needsManualGrading: needsManualGrading,
        score: tracking?.quizScore,
        feedback: null,
        essayQuestions: essayQuestions,
        hasSubmitted: tracking !== null,
        hwStatus: tracking?.hwStatus ?? 'NOT_SUBMITTED',
        essayStatus: tracking?.essayStatus ?? 'NOT_SUBMITTED',
        submission: submission, // Explicitly null when not submitted
      };
    });

    res.json(students);
  } catch (error) {
    console.error('Get pending essays error:', error);
    res.status(500).json({ error: 'Failed to fetch pending essays' });
  }
};

router.get('/pending-essays', authMiddleware, getPendingEssays);

// ─── POST /api/trackings/homework/submit ──────────────────────────────────────
// Student uploads their homework file. Backend saves it and sets
// hwStatus = 'PENDING' so it appears in the teacher's grading dashboard.
export const submitHomework: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;

    if (!authUser || authUser.role !== 'STUDENT') {
      // Clean up any uploaded files before returning
      const files = (req as any).files as Express.Multer.File[] | undefined;
      if (files) {
        for (const f of files) {
          if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
        }
      }
      res.status(403).json({ error: 'Only students can submit homework' });
      return;
    }

    const { lessonId } = req.body as { lessonId?: string };
    const files = (req as any).files as Express.Multer.File[] | undefined;

    console.log('📥 submitHomework called:', {
      lessonId,
      files: files?.map(f => f.originalname),
      studentId: authUser.id
    });

    if (!lessonId) {
      if (files) {
        for (const f of files) {
          if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
        }
      }
      res.status(400).json({ error: 'lessonId is required' });
      return;
    }

    if (!files || files.length === 0) {
      res.status(400).json({ error: 'At least one homework file is required' });
      return;
    }

    // Verify the lesson exists
    const lesson = await prisma.lesson.findUnique({ where: { id: lessonId } });
    if (!lesson) {
      for (const f of files) {
        if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
      }
      res.status(404).json({ error: 'Lesson not found' });
      return;
    }

    // Relative URLs served as /uploads/homeworks/<filename> separated by comma
    const hwFileUrl = files.map(f => `uploads/homeworks/${f.filename}`).join(',');

    // Upsert tracking: create if first interaction, otherwise update hw fields
    const tracking = await prisma.tracking.upsert({
      where: {
        studentId_lessonId: {
          studentId: authUser.id,
          lessonId,
        },
      },
      update: {
        hwStatus: 'PENDING',
        hwFileUrl,
      },
      create: {
        studentId: authUser.id,
        lessonId,
        isPresent: true,
        hwStatus: 'PENDING',
        hwFileUrl,
      },
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    console.log('📝 Homework submitted:', {
      studentId: authUser.id,
      lessonId,
      filesCount: files.length,
      status: 'PENDING',
    });

    res.json({
      message: 'Homework submitted successfully',
      status: tracking.hwStatus,
      fileUrl: `${baseUrl}/${hwFileUrl}`,
    });
  } catch (error) {
    console.error('submitHomework error:', error);
    res.status(500).json({ error: 'Failed to submit homework' });
  }
};

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

    const lesson = await prisma.lesson.findUnique({
      where: { id: lessonId },
    });

    if (!lesson) {
      res.status(404).json({ error: 'Lesson not found' });
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

    res.json({
      message: 'Attendance marked successfully',
      tracking,
    });
  } catch (error) {
    console.error('Mark attendance error:', error);
    res.status(500).json({ error: 'Failed to mark attendance' });
  }
};

export const getLessonWithQuiz: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { lessonId } = req.params;
    const authUser = (req as Request & { user?: AuthUser }).user;

    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const lesson = await prisma.lesson.findUnique({
      where: { id: lessonId },
      include: {
        teacher: {
          select: { id: true, name: true, phone: true },
        },
        quizzes: true, // 'questions' is a plain String field on Quiz, always included
      },
    });

    if (!lesson) {
      res.status(404).json({ error: 'Lesson not found' });
      return;
    }

    const tracking = await prisma.tracking.findUnique({
      where: {
        studentId_lessonId: {
          studentId: authUser.id,
          lessonId,
        },
      },
    });

    // Parse questions from JSON string to actual array for each quiz
    // so the Flutter client doesn't have to do JSON-within-JSON parsing
    const quizzesWithParsedQuestions = lesson.quizzes.map((quiz) => {
      let parsedQuestions: unknown = [];
      let timeLimit: number | undefined;
      try {
        let raw: any = JSON.parse(quiz.questions);
        // Handle double-encoded strings (e.g. "\"[...]\"")
        if (typeof raw === 'string') {
          raw = JSON.parse(raw);
        }
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          parsedQuestions = raw.questions || [];
          timeLimit = raw.timeLimit || raw.duration;
        } else {
          parsedQuestions = raw || [];
        }
      } catch (e) {
        console.error('Failed to parse quiz questions for quiz', quiz.id, e);
      }
      return {
        id: quiz.id,
        lessonId: quiz.lessonId,
        questions: parsedQuestions, // Send as actual array, not string
        timeLimit: timeLimit,
      };
    });

// Fetch course if lesson has courseId
    let courseName: string | null = null;
    if (lesson.courseId) {
      const course = await prisma.course.findUnique({ where: { id: lesson.courseId } });
      courseName = course?.title ?? null;
    }

    res.json({
      lesson: {
        id:           lesson.id,
        title:        lesson.title,
        videoUrl:     lesson.videoUrl,
        thumbnailUrl: lesson.thumbnailUrl,
      },
      courseId:      lesson.courseId,
      courseName:    courseName,
      quiz: quizzesWithParsedQuestions.length > 0 ? quizzesWithParsedQuestions[0] : null,
      hasCompletedQuiz: tracking !== null,
      hasQuizScore: tracking?.quizScore !== null,
      quizScore: tracking?.quizScore ?? null,
      hwStatus: tracking?.hwStatus ?? null,
      essayStatus: tracking?.essayStatus ?? null,
      needsManualGrading: tracking?.essayStatus === 'PENDING',
      tracking: tracking || null,
    });
  } catch (error) {
    console.error('Get lesson error:', error);
    res.status(500).json({ error: 'Failed to fetch lesson' });
  }
};

// ─── Routes (static routes BEFORE /:lessonId dynamic route!) ────────────────
router.post('/attend', authMiddleware, markAttendance);
router.post('/submit-quiz', authMiddleware, submitQuiz);

// Homework file upload — authMiddleware first, then multer, then handler
router.post(
  '/homework/submit',
  authMiddleware,
  (req, res, next) => {
    homeworkUpload.array('files', 10)(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: `Multer error: ${err.message}` });
      } else if (err) {
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  submitHomework,
);

// MUST be last to avoid swallowing other routes!
router.get('/:lessonId', authMiddleware, getLessonWithQuiz);

// ─── POST /api/trackings/:trackingId/grade-essay ───────────────────────────────
const gradeEssay: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser || (authUser.role !== 'TEACHER' && authUser.role !== 'ASSISTANT')) {
      res.status(403).json({ error: 'Only teachers or assistants can grade essays' });
      return;
    }

    const { trackingId } = req.params;
    const { score, feedback, gradedQuestionId } = req.body;

    const ownerId = authUser.role === 'ASSISTANT' && (authUser as any).parentTeacherId
      ? (authUser as any).parentTeacherId
      : authUser.id;

    const tracking = await prisma.tracking.findUnique({
      where: { id: trackingId },
      include: { lesson: true },
    });

    if (!tracking || tracking.lesson.teacherId !== ownerId) {
      res.status(403).json({ error: 'Not authorized to grade this submission' });
      return;
    }

    let answersData: Record<string, any> = {};
    if (tracking.essayAnswers) {
      try { answersData = JSON.parse(tracking.essayAnswers); }
      catch (e) { answersData = {}; }
    }

    const rawScore  = (score !== undefined && score !== null) ? parseInt(String(score), 10) : 0;
    const safeScore = isNaN(rawScore) ? 0 : rawScore;

    // Find the essay entry to grade:
    // If gradedQuestionId supplied (e.g. "essay_1"), target only that key.
    // Otherwise target ALL essay_N entries (single-essay quiz).
    const allDataKeys  = Object.keys(answersData).filter(k => k !== '__graded__');
    const essayKeys    = allDataKeys.filter(k => k.startsWith('essay_'));
    const keysToGrade  = gradedQuestionId
      ? allDataKeys.filter(k => k === gradedQuestionId || answersData[k]?.questionId === gradedQuestionId)
      : essayKeys;

    // Stamp ALL score variants so every Flutter fallback path resolves
    keysToGrade.forEach((key) => {
      const entry = answersData[key];
      if (entry && typeof entry === 'object') {
        entry.score         = safeScore;
        entry.awardedPoints = safeScore;
        entry.earnedPoints  = safeScore;
        entry.isGraded      = true;
        entry.status        = 'COMPLETED';
        if (feedback) entry.feedback = feedback;
      }
    });

    answersData['__graded__'] = true;

    // ── Definitive total: SUM every entry score (mcq_N + essay_N) ───────────
    // Avoids the old additive bug where re-grading would accumulate scores.
    const newTotalScore = allDataKeys.reduce((sum, key) => {
      return sum + (Number(answersData[key]?.score) || 0);
    }, 0);

    const updated = await prisma.tracking.update({
      where: { id: trackingId },
      data: {
        quizScore:    newTotalScore,
        hwStatus:     'SUBMITTED',
        essayStatus:  'GRADED',
        essayAnswers: JSON.stringify(answersData),
      },
    });

    console.log('✅ Essay graded:', { trackingId, keysToGrade, safeScore, newTotalScore });

    res.json({
      success:            true,
      quizScore:          updated.quizScore,
      hwStatus:           updated.hwStatus,
      needsManualGrading: updated.hwStatus === 'PENDING',
    });
  } catch (error) {
    console.error('Grade essay error:', error);
    res.status(500).json({ error: 'Failed to grade essay' });
  }
};

router.post('/:trackingId/grade-essay', authMiddleware, gradeEssay);

export default router;

