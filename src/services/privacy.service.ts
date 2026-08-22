import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { disconnectUserSockets } from '../socket';

const DELETE_GRACE_PERIOD_DAYS = 7;
const DELETE_REQUEST_KEY = (userId: string) => `DELETE:${userId}`;

export class PrivacyServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const verifyCurrentPassword = async (
  prisma: PrismaClient,
  userId: string,
  password: string,
): Promise<void> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { password: true },
  });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    throw new PrivacyServiceError(
      'INVALID_REAUTH',
      400,
      'تعذر تأكيد كلمة المرور الحالية.',
    );
  }
};

export const buildAccountExport = async (
  prisma: PrismaClient,
  userId: string,
): Promise<Record<string, unknown>> => {
  const [
    profile,
    enrollments,
    payments,
    entitlements,
    attendance,
    progress,
    tracking,
    relationsAsStudent,
    relationsAsParent,
    courses,
    lessons,
    notifications,
    linkRequests,
    attendanceQrUses,
    analytics,
  ] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          role: true,
          status: true,
          isApproved: true,
          isVerified: true,
          subjectId: true,
          vodafoneCashNumber: true,
          instapayHandle: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.courseEnrollment.findMany({
        where: { studentId: userId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          status: true,
          paymentMethod: true,
          receiptImageUrl: true,
          createdAt: true,
          updatedAt: true,
          course: { select: { id: true, title: true, subject: true, grade: true } },
        },
      }),
      prisma.paymentOrder.findMany({
        where: { studentId: userId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          courseId: true,
          amountMinor: true,
          currency: true,
          provider: true,
          status: true,
          paidAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.courseEntitlement.findMany({
        where: { studentId: userId },
        orderBy: { grantedAt: 'asc' },
        select: {
          id: true,
          courseId: true,
          status: true,
          grantedAt: true,
          revokedAt: true,
          updatedAt: true,
        },
      }),
      prisma.attendanceRecord.findMany({
        where: { studentId: userId },
        orderBy: { timestamp: 'asc' },
        select: {
          id: true,
          timestamp: true,
          session: { select: { id: true, date: true, subject: true, grade: true } },
        },
      }),
      prisma.lessonProgress.findMany({
        where: { studentId: userId },
        orderBy: { createdAt: 'asc' },
        select: {
          lessonId: true,
          courseId: true,
          watchPercentage: true,
          isCompleted: true,
          createdAt: true,
          updatedAt: true,
          lesson: { select: { title: true } },
        },
      }),
      prisma.tracking.findMany({
        where: { studentId: userId },
        orderBy: { createdAt: 'asc' },
        select: {
          lessonId: true,
          isPresent: true,
          hwStatus: true,
          essayStatus: true,
          quizScore: true,
          essayAnswers: true,
          hwFileUrl: true,
          createdAt: true,
          updatedAt: true,
          lesson: { select: { title: true } },
        },
      }),
      prisma.studentParentRelation.findMany({
        where: { studentId: userId },
        select: { parentId: true },
      }),
      prisma.studentParentRelation.findMany({
        where: { parentId: userId },
        select: { studentId: true },
      }),
      prisma.course.findMany({
        where: { teacherId: userId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          title: true,
          description: true,
          subject: true,
          grade: true,
          priceMinor: true,
          currency: true,
          isPublished: true,
          publishedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.lesson.findMany({
        where: { teacherId: userId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          courseId: true,
          title: true,
          description: true,
          subject: true,
          grade: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          type: true,
          title: true,
          body: true,
          isRead: true,
          createdAt: true,
        },
      }),
      prisma.parentLinkRequest.findMany({
        where: { OR: [{ studentId: userId }, { parentId: userId }] },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          studentId: true,
          parentId: true,
          status: true,
          attempts: true,
          expiresAt: true,
          consumedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.attendanceQrUse.findMany({
        where: { studentId: userId },
        orderBy: { usedAt: 'asc' },
        select: { sessionId: true, expiresAt: true, usedAt: true },
      }),
      prisma.analyticsEvent.findMany({
        where: { userId },
        orderBy: { timestamp: 'asc' },
        select: { eventType: true, metadata: true, timestamp: true },
      }),
    ]);

  if (!profile) {
    throw new PrivacyServiceError('ACCOUNT_NOT_FOUND', 404, 'الحساب غير موجود.');
  }

  const refunds = payments.length === 0
    ? []
    : await prisma.refund.findMany({
        where: { paymentOrderId: { in: payments.map((payment) => payment.id) } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          paymentOrderId: true,
          amountMinor: true,
          currency: true,
          status: true,
          reason: true,
          createdAt: true,
          updatedAt: true,
        },
      });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    profile,
    learning: {
      enrollments,
      entitlements,
      attendance,
      attendanceQrUses,
      progress,
      assessments: tracking,
    },
    commerce: { payments, refunds },
    familyLinks: {
      linkedParentCount: relationsAsStudent.length,
      linkedStudentCount: relationsAsParent.length,
    },
    teaching: { courses, lessons },
    accountActivity: { notifications, linkRequests, analytics },
    redactions: [
      'password hashes and reset secrets',
      'session tokens, user agents, and push tokens',
      'payment provider checkout URLs and webhook payloads',
      'temporary Bunny playback/upload credentials',
    ],
  };
};

export const recordCompletedExport = async (
  prisma: PrismaClient,
  userId: string,
) => prisma.dataPrivacyRequest.create({
  data: {
    userId,
    type: 'EXPORT',
    status: 'GENERATED',
    completedAt: new Date(),
  },
  select: { id: true, requestedAt: true, completedAt: true },
});

export const getPrivacyRequestStatus = async (
  prisma: PrismaClient,
  userId: string,
) => {
  const [deletion, latestExport] = await Promise.all([
    prisma.dataPrivacyRequest.findFirst({
      where: { userId, type: 'DELETE', status: 'PENDING' },
      orderBy: { requestedAt: 'desc' },
      select: { id: true, status: true, requestedAt: true, scheduledFor: true },
    }),
    prisma.dataPrivacyRequest.findFirst({
      where: { userId, type: 'EXPORT', status: 'GENERATED' },
      orderBy: { requestedAt: 'desc' },
      select: { id: true, status: true, requestedAt: true, completedAt: true },
    }),
  ]);
  return { deletion, latestExport };
};

export const scheduleAccountDeletion = async (
  prisma: PrismaClient,
  userId: string,
  reason?: string,
) => {
  const scheduledFor = new Date(
    Date.now() + DELETE_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000,
  );
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { status: true, role: true },
      });
      if (!user || user.status === 'deleted' || user.status === 'deletion_processing') {
        throw new PrivacyServiceError('ACCOUNT_NOT_ACTIVE', 409, 'الحساب غير متاح للحذف.');
      }
      if (user.role === 'SUPER_ADMIN' || user.role === 'SUPERADMIN') {
        throw new PrivacyServiceError(
          'SUPER_ADMIN_DELETION_REQUIRES_GOVERNANCE',
          403,
          'حذف حساب المدير الرئيسي يحتاج إجراءً إداريًا موثقًا.',
        );
      }
      const request = await tx.dataPrivacyRequest.create({
        data: {
          userId,
          type: 'DELETE',
          status: 'PENDING',
          requestKey: DELETE_REQUEST_KEY(userId),
          reason: reason?.trim() || null,
          scheduledFor,
          previousUserStatus: user.status,
        },
        select: { id: true, status: true, requestedAt: true, scheduledFor: true },
      });
      const revokedAt = new Date();
      await tx.userSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt },
      });
      await tx.user.update({
        where: { id: userId },
        data: { sessionVersion: { increment: 1 } },
      });
      return request;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new PrivacyServiceError(
        'DELETION_ALREADY_PENDING',
        409,
        'يوجد بالفعل طلب حذف قيد الانتظار.',
      );
    }
    throw error;
  }
};

export const cancelAccountDeletion = async (
  prisma: PrismaClient,
  userId: string,
) => {
  const now = new Date();
  const pending = await prisma.dataPrivacyRequest.findFirst({
    where: {
      userId,
      type: 'DELETE',
      status: 'PENDING',
      scheduledFor: { gt: now },
    },
    orderBy: { requestedAt: 'desc' },
    select: { id: true },
  });
  if (!pending) {
    throw new PrivacyServiceError(
      'NO_CANCELABLE_DELETION',
      409,
      'لا يوجد طلب حذف يمكن إلغاؤه خلال مهلة الأمان.',
    );
  }
  const updated = await prisma.dataPrivacyRequest.updateMany({
    where: {
      id: pending.id,
      userId,
      status: 'PENDING',
      scheduledFor: { gt: now },
    },
    data: {
      status: 'CANCELED',
      canceledAt: now,
      requestKey: null,
    },
  });
  if (updated.count !== 1) {
    throw new PrivacyServiceError(
      'DELETION_NO_LONGER_CANCELABLE',
      409,
      'انتهت مهلة إلغاء طلب الحذف.',
    );
  }
  return prisma.dataPrivacyRequest.findUniqueOrThrow({
    where: { id: pending.id },
    select: { id: true, status: true, canceledAt: true },
  });
};

export const executeDueAccountDeletions = async (
  prisma: PrismaClient,
  now = new Date(),
  limit = 20,
): Promise<{ processed: number; failed: number }> => {
  const staleLease = new Date(now.getTime() - 15 * 60 * 1000);
  const claimableWhere: Prisma.DataPrivacyRequestWhereInput = {
    type: 'DELETE',
    OR: [
      { status: 'PENDING', scheduledFor: { lte: now } },
      { status: 'PROCESSING', processingStartedAt: { lte: staleLease } },
    ],
  };
  const due = await prisma.dataPrivacyRequest.findMany({
    where: claimableWhere,
    orderBy: { scheduledFor: 'asc' },
    take: limit,
    select: {
      id: true,
      userId: true,
      attempts: true,
      previousUserStatus: true,
    },
  });

  let processed = 0;
  let failed = 0;
  for (const candidate of due) {
    const claimed = await prisma.dataPrivacyRequest.updateMany({
      where: { id: candidate.id, ...claimableWhere },
      data: {
        status: 'PROCESSING',
        attempts: { increment: 1 },
        lastError: null,
        processingStartedAt: now,
      },
    });
    if (claimed.count !== 1) continue;

    try {
      await prisma.user.updateMany({
        where: { id: candidate.userId, status: { not: 'deleted' } },
        data: { status: 'deletion_processing', isApproved: false },
      });
      disconnectUserSockets(candidate.userId);
      const user = await prisma.user.findUnique({
        where: { id: candidate.userId },
        select: { phone: true },
      });
      if (!user) {
        await prisma.dataPrivacyRequest.update({
          where: { id: candidate.id },
          data: {
            status: 'COMPLETED',
            completedAt: now,
            requestKey: null,
            processingStartedAt: null,
          },
        });
        processed += 1;
        continue;
      }

      const disabledPassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
      const deletedPhone = `DELETED_${candidate.userId}_${now.getTime()}`;
      await prisma.$transaction(async (tx) => {
        await tx.passwordResetOTP.deleteMany({ where: { studentPhone: user.phone } });
        await tx.userSession.deleteMany({ where: { userId: candidate.userId } });
        await tx.pushToken.deleteMany({ where: { userId: candidate.userId } });
        await tx.notification.deleteMany({ where: { userId: candidate.userId } });
        await tx.studentParentRelation.deleteMany({
          where: { OR: [{ studentId: candidate.userId }, { parentId: candidate.userId }] },
        });
        await tx.parentLinkRequest.deleteMany({
          where: { OR: [{ studentId: candidate.userId }, { parentId: candidate.userId }] },
        });
        await tx.analyticsEvent.deleteMany({
          where: { userId: candidate.userId },
        });
        await tx.user.updateMany({
          where: { parentTeacherId: candidate.userId },
          data: { parentTeacherId: null },
        });
        await tx.user.update({
          where: { id: candidate.userId },
          data: {
            name: 'Deleted account',
            phone: deletedPhone,
            email: null,
            password: disabledPassword,
            role: 'DELETED',
            status: 'deleted',
            isApproved: false,
            isVerified: false,
            permissions: '[]',
            subjectId: null,
            parentPhone: null,
            deviceId: null,
            vodafoneCashNumber: null,
            instapayHandle: null,
            parentTeacherId: null,
            sessionVersion: { increment: 1 },
          },
        });
        await tx.dataPrivacyRequest.update({
          where: { id: candidate.id },
          data: {
            status: 'COMPLETED',
            completedAt: now,
            requestKey: null,
            reason: null,
            lastError: null,
            processingStartedAt: null,
          },
        });
      });
      processed += 1;
    } catch (error) {
      failed += 1;
      const finalFailure = candidate.attempts + 1 >= 5;
      await prisma.$transaction([
        prisma.dataPrivacyRequest.update({
          where: { id: candidate.id },
          data: {
            status: finalFailure ? 'FAILED' : 'PENDING',
            requestKey: finalFailure ? null : DELETE_REQUEST_KEY(candidate.userId),
            processingStartedAt: null,
            lastError: error instanceof Error
              ? error.message.slice(0, 500)
              : 'Unknown failure',
          },
        }),
        prisma.user.updateMany({
          where: { id: candidate.userId, status: 'deletion_processing' },
          data: {
            status: candidate.previousUserStatus || 'approved',
            isApproved: true,
          },
        }),
      ]);
    }
  }
  return { processed, failed };
};
