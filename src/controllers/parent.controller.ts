import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const getMyChildren = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: any }).user;

    if (!authUser || authUser.role !== 'PARENT') {
      res.status(403).json({ error: 'Forbidden: Only parents can access this' });
      return;
    }

    const parentPhone = authUser.phone;

    // Find children using OR operator for robust fallback
    const children = await prisma.user.findMany({
      where: {
        role: 'STUDENT',
        OR: [
          { studentRelations: { some: { parentId: authUser.id } } },
          { parentPhone: parentPhone } // Match by phone entered during student reg
        ]
      },
      include: {
        studentRelations: true
      }
    });

    // Auto-Heal: Solidify the link if it was found via phone but lacks relation row
    const unlinkedIds = children
      .filter(c => !c.studentRelations.some(rel => rel.parentId === authUser.id))
      .map(c => c.id);

    if (unlinkedIds.length > 0) {
      await prisma.studentParentRelation.createMany({
        data: unlinkedIds.map(studentId => ({
          studentId: studentId,
          parentId: authUser.id
        })),
      });
    }

    const sanitizedChildren = children.map(c => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      role: c.role
    }));

    res.json({ children: sanitizedChildren });
  } catch (error) {
    console.error('getMyChildren error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getChildStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: any }).user;
    const { studentId } = req.params;

    if (!authUser || authUser.role !== 'PARENT') {
      res.status(403).json({ error: 'Forbidden: Only parents can access this' });
      return;
    }

    // Verify ownership
    const student = await prisma.user.findFirst({
      where: {
        id: studentId,
        role: 'STUDENT',
        OR: [
          { studentRelations: { some: { parentId: authUser.id } } },
          { parentPhone: authUser.phone }
        ]
      } as any
    });

    if (!student) {
      res.status(403).json({ error: 'Not authorized to view this student' });
      return;
    }

    // Fetch tracking data for this student (for HW and Quizzes)
    const trackings = await prisma.tracking.findMany({
      where: { studentId }
    });

    let hwSubmittedCount = 0;
    let totalQuizScore = 0;
    let quizCount = 0;

    trackings.forEach(t => {
      if (t.hwStatus !== 'NOT_SUBMITTED') hwSubmittedCount++;
      if (t.quizScore !== null) {
        totalQuizScore += t.quizScore;
        quizCount++;
      }
    });

    const physicalAttendanceCount = await prisma.attendanceRecord.count({
      where: { studentId }
    });

    const averageQuizScore = quizCount > 0 ? Math.round(totalQuizScore / quizCount) : 0;

    let overallEvaluation = 'يحتاج متابعة';
    if (averageQuizScore >= 90) {
      overallEvaluation = 'ممتاز';
    } else if (averageQuizScore >= 75) {
      overallEvaluation = 'جيد جداً';
    } else if (averageQuizScore >= 60) {
      overallEvaluation = 'جيد';
    }

    const lastTracking = await prisma.tracking.findFirst({
      where: { studentId },
      orderBy: { updatedAt: 'desc' },
      include: { lesson: { select: { title: true } } }
    });
    const lastActivity = lastTracking?.lesson ? `شاهد درس: ${lastTracking.lesson.title}` : 'لا يوجد نشاط مسجل';

    const activeEnrollments = await prisma.courseEnrollment.findMany({
      where: { studentId, status: 'APPROVED' },
      include: {
        course: {
          include: {
            lessons: true
          }
        }
      }
    });

    let totalEnrolledLessons = 0;
    activeEnrollments.forEach(enrollment => {
      if (enrollment.course && enrollment.course.lessons) {
        totalEnrolledLessons += enrollment.course.lessons.length;
      }
    });

    const completedProgress = await prisma.lessonProgress.count({
      where: { studentId, isCompleted: true }
    });

    const attendanceRate = totalEnrolledLessons > 0 ? Math.round((completedProgress / totalEnrolledLessons) * 100) : 0;
    const activeCourses = activeEnrollments.length;

    res.json({
      attendanceRate,
      physicalAttendanceCount,
      homeworkSubmitted: hwSubmittedCount,
      averageQuizScore,
      overallEvaluation,
      lastActivity,
      activeCourses
    });
  } catch (error) {
    console.error('getChildStats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
