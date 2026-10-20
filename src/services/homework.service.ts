import { PrismaClient, HomeworkStatus } from '@prisma/client';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/appError';
import { AuthUser } from '../middlewares/auth.middleware';

/**
 * Homework lifecycle.
 *
 * The schema already carries hwStatus, hwGrade, hwComment, hwGradedAt,
 * hwResubmitCount and hwSubmittedAt, but nothing enforced how they may move.
 * `updateSubmissionStatus` accepted any of four statuses from the request body
 * and wrote it, so a teacher could move a GRADED submission back to SUBMITTED,
 * and a student could resubmit forever. This module is the single place that
 * decides which moves are legal.
 *
 * The rule is deliberately explicit rather than derived: an illegal transition
 * is rejected with the list of legal successors, so a caller never has to guess
 * and a rejected call can never half-apply.
 */

import prisma from '../config/prisma';

/** A graded submission is final. Reopening it would silently discard a grade. */
export const MAX_RESUBMISSIONS = 3;

/**
 * Legal successors per state.
 *
 * NOT_SUBMITTED -> SUBMITTED is the only path in.
 * GRADED is terminal.
 * NEEDS_REVISION -> SUBMITTED is the resubmission path and is additionally
 * bounded by MAX_RESUBMISSIONS at call time, not here, because the bound
 * depends on data rather than on the state alone.
 */
const TRANSITIONS: Record<HomeworkStatus, HomeworkStatus[]> = {
  NOT_SUBMITTED: ['SUBMITTED'],
  SUBMITTED: ['UNDER_REVIEW', 'GRADED', 'NEEDS_REVISION'],
  UNDER_REVIEW: ['GRADED', 'NEEDS_REVISION'],
  NEEDS_REVISION: ['SUBMITTED'],
  GRADED: [],
};

export const legalSuccessors = (from: HomeworkStatus): HomeworkStatus[] =>
  TRANSITIONS[from] ?? [];

export const canTransition = (from: HomeworkStatus, to: HomeworkStatus): boolean =>
  legalSuccessors(from).includes(to);

const assertTransition = (from: HomeworkStatus, to: HomeworkStatus, context: string): void => {
  if (canTransition(from, to)) return;
  const legal = legalSuccessors(from);
  const suffix = legal.length ? `Legal next: ${legal.join(', ')}.` : 'This state is final.';
  throw new BadRequestError(
    `Illegal homework transition ${from} -> ${to} (${context}). ${suffix}`,
  );
};

const assertGradeRange = (grade: number, maxGrade: number): void => {
  if (!Number.isInteger(maxGrade) || maxGrade <= 0) {
    throw new BadRequestError('maxGrade must be a positive whole number');
  }
  if (!Number.isInteger(grade) || grade < 0 || grade > maxGrade) {
    throw new BadRequestError(`grade must be a whole number between 0 and ${maxGrade}`);
  }
};

/** Resolves the lesson and proves the caller owns it. Returns the lesson. */
const loadOwnedLesson = async (assignmentId: string, authUser: AuthUser) => {
  const ownerId = authUser.role === 'ASSISTANT' && authUser.parentTeacherId
    ? authUser.parentTeacherId
    : authUser.id;

  const lesson = await prisma.lesson.findUnique({
    where: { id: assignmentId },
    include: { course: true },
  });

  if (!lesson || !lesson.course || lesson.course.teacherId !== ownerId) {
    throw new ForbiddenError('Assignment not found or forbidden');
  }

  return lesson;
};

const assertEnrolled = async (studentId: string, courseId: string): Promise<void> => {
  const enrollment = await prisma.courseEnrollment.findUnique({
    where: { studentId_courseId: { studentId, courseId } },
    select: { status: true },
  });
  if (enrollment?.status !== 'APPROVED') {
    throw new ForbiddenError('Student is not enrolled in this course');
  }
};

export type SubmissionView = {
  studentId: string;
  lessonId: string;
  status: HomeworkStatus;
  answer: string | null;
  grade: number | null;
  maxGrade: number | null;
  comment: string | null;
  resubmitCount: number;
  submittedAt: Date | null;
  gradedAt: Date | null;
  gradedById: string | null;
  late: boolean;
  remainingResubmissions: number;
  isOverdue: boolean;
};

const toView = (
  tracking: {
    studentId: string;
    lessonId: string;
    hwStatus: HomeworkStatus;
    essayAnswers: string | null;
    hwGrade: number | null;
    hwMaxGrade: number | null;
    hwComment: string | null;
    hwResubmitCount: number;
    hwSubmittedAt: Date | null;
    hwGradedAt: Date | null;
    hwGradedById: string | null;
  },
  deadline: Date | null,
): SubmissionView => {
  let answer: string | null = null;
  if (tracking.essayAnswers) {
    try {
      const parsed = JSON.parse(tracking.essayAnswers) as { answer?: unknown };
      answer = typeof parsed.answer === 'string' ? parsed.answer : null;
    } catch {
      // A malformed blob must not make the whole register unreadable.
      answer = null;
    }
  }

  const submittedAt = tracking.hwSubmittedAt;
  const isOverdue = Boolean(deadline) && (!submittedAt || submittedAt > (deadline as Date));

  return {
    studentId: tracking.studentId,
    lessonId: tracking.lessonId,
    status: tracking.hwStatus,
    answer,
    grade: tracking.hwGrade,
    maxGrade: tracking.hwMaxGrade,
    comment: tracking.hwComment,
    resubmitCount: tracking.hwResubmitCount,
    submittedAt,
    gradedAt: tracking.hwGradedAt,
    gradedById: tracking.hwGradedById,
    late: isOverdue,
    remainingResubmissions: Math.max(0, MAX_RESUBMISSIONS - tracking.hwResubmitCount),
    isOverdue,
  };
};

/**
 * Teacher grading. Moves SUBMITTED|UNDER_REVIEW -> GRADED and records the mark.
 *
 * Grade and maxGrade are both required: a GRADED status with no mark is the
 * state that made "graded" meaningless to a parent reading the dashboard.
 */
export const gradeHomework = async (
  authUser: AuthUser,
  assignmentId: string,
  studentId: string | undefined,
  grade: number | undefined,
  maxGrade: number | undefined,
  comment: string | undefined,
) => {
  const lesson = await loadOwnedLesson(assignmentId, authUser);

  if (!lesson.courseId) throw new ForbiddenError('Assignment has no course');
  if (!studentId) throw new BadRequestError('studentId is required');

  assertGradeRange(grade as number, maxGrade as number);
  await assertEnrolled(studentId, lesson.courseId);

  const current = await prisma.tracking.findUnique({
    where: { studentId_lessonId: { studentId, lessonId: assignmentId } },
  });
  if (!current) throw new NotFoundError('No submission for this student');

  assertTransition(current.hwStatus, 'GRADED', 'grading');

  return prisma.tracking.update({
    where: { studentId_lessonId: { studentId, lessonId: assignmentId } },
    data: {
      hwStatus: 'GRADED',
      hwGrade: grade,
      hwMaxGrade: maxGrade,
      hwComment: comment?.trim() || null,
      hwGradedAt: new Date(),
      hwGradedById: authUser.id,
      essayStatus: 'GRADED',
    },
    select: {
      studentId: true,
      lessonId: true,
      hwStatus: true,
      hwGrade: true,
      hwMaxGrade: true,
      hwComment: true,
      hwGradedAt: true,
      hwGradedById: true,
    },
  });
};

/**
 * Return a submission for revision. Moves SUBMITTED|UNDER_REVIEW ->
 * NEEDS_REVISION and requires feedback, because a student asked to redo work
 * with no comment has no way to know what to change.
 */
export const returnHomework = async (
  authUser: AuthUser,
  assignmentId: string,
  studentId: string | undefined,
  comment: string | undefined,
) => {
  const lesson = await loadOwnedLesson(assignmentId, authUser);

  if (!lesson.courseId) throw new ForbiddenError('Assignment has no course');
  if (!studentId) throw new BadRequestError('studentId is required');

  const trimmed = comment?.trim();
  if (!trimmed) {
    throw new BadRequestError('A comment is required when returning work for revision');
  }

  await assertEnrolled(studentId, lesson.courseId);

  const current = await prisma.tracking.findUnique({
    where: { studentId_lessonId: { studentId, lessonId: assignmentId } },
  });
  if (!current) throw new NotFoundError('No submission for this student');

  assertTransition(current.hwStatus, 'NEEDS_REVISION', 'returning for revision');

  if (current.hwResubmitCount >= MAX_RESUBMISSIONS) {
    throw new BadRequestError('Maximum resubmission limit reached');
  }

  return prisma.tracking.update({
    where: { studentId_lessonId: { studentId, lessonId: assignmentId } },
    data: {
      hwStatus: 'NEEDS_REVISION',
      hwComment: trimmed,
      essayStatus: 'NEEDS_REVISION',
    },
    select: {
      studentId: true,
      lessonId: true,
      hwStatus: true,
      hwComment: true,
      hwResubmitCount: true,
    },
  });
};

/** Move a submission into review. UNDER_REVIEW is where a teacher works. */
export const startReview = async (
  authUser: AuthUser,
  assignmentId: string,
  studentId: string | undefined,
) => {
  const lesson = await loadOwnedLesson(assignmentId, authUser);
  if (!lesson.courseId) throw new ForbiddenError('Assignment has no course');
  if (!studentId) throw new BadRequestError('studentId is required');

  await assertEnrolled(studentId, lesson.courseId);

  const current = await prisma.tracking.findUnique({
    where: { studentId_lessonId: { studentId, lessonId: assignmentId } },
  });
  if (!current) throw new NotFoundError('No submission for this student');

  assertTransition(current.hwStatus, 'UNDER_REVIEW', 'starting review');

  return prisma.tracking.update({
    where: { studentId_lessonId: { studentId, lessonId: assignmentId } },
    data: { hwStatus: 'UNDER_REVIEW' },
    select: { studentId: true, lessonId: true, hwStatus: true },
  });
};

/**
 * Register for one assignment: every enrolled student's real submission state.
 *
 * Students who never submitted appear with NOT_SUBMITTED, because the teacher
 * needs the denominator. They are not fabricated as submissions.
 */
export const getHomeworkRegister = async (
  authUser: AuthUser,
  assignmentId: string,
) => {
  const lesson = await loadOwnedLesson(assignmentId, authUser);
  if (!lesson.courseId) throw new ForbiddenError('Assignment has no course');

  // Enrollments first: the tracking query is scoped to these students, so the
  // two cannot be resolved in one Promise.all.
  const enrollments = await prisma.courseEnrollment.findMany({
    where: { courseId: lesson.courseId, status: 'APPROVED' },
    select: {
      studentId: true,
      student: { select: { id: true, name: true, phone: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const trackings = await prisma.tracking.findMany({
    where: { lessonId: assignmentId, studentId: { in: enrollments.map((e) => e.studentId) } },
  });

  const byStudent = new Map(trackings.map((t) => [t.studentId, t]));

  return {
    assignment: {
      id: lesson.id,
      title: lesson.title,
      homeworkDueAt: lesson.homeworkDueAt ?? null,
      maxResubmissions: MAX_RESUBMISSIONS,
    },
    enrolledCount: enrollments.length,
    students: enrollments.map((enrollment) => {
      const tracking = byStudent.get(enrollment.studentId);
      if (tracking) {
        return { student: enrollment.student, ...toView(tracking, lesson.homeworkDueAt ?? null) };
      }
      const isOverdue = Boolean(lesson.homeworkDueAt) && new Date() > (lesson.homeworkDueAt as Date);
      return {
        student: enrollment.student,
        studentId: enrollment.studentId,
        lessonId: assignmentId,
        status: 'NOT_SUBMITTED' as HomeworkStatus,
        answer: null,
        grade: null,
        maxGrade: null,
        comment: null,
        resubmitCount: 0,
        submittedAt: null,
        gradedAt: null,
        gradedById: null,
        late: isOverdue,
        remainingResubmissions: MAX_RESUBMISSIONS,
        isOverdue,
      };
    }),
  };
};

export const __testing = { TRANSITIONS, MAX_RESUBMISSIONS, toView };