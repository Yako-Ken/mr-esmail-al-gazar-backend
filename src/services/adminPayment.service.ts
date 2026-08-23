import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

const orderSelect = {
  id: true,
  studentId: true,
  courseId: true,
  amountMinor: true,
  currency: true,
  provider: true,
  status: true,
  failureReason: true,
  paidAt: true,
  createdAt: true,
} as const;

export type PaymentOrderRow = {
  id: string;
  amountMinor: number;
  currency: string;
  status: string;
  provider: string;
  createdAt: Date;
  paidAt: Date | null;
  studentName: string;
  studentPhoneMasked: string;
  courseTitle: string;
};

const maskPhone = (phone: string): string =>
  phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-3)}` : '***';

export interface ListPaymentsParams {
  status?: 'PENDING' | 'PAID' | 'FAILED' | 'ALL';
  page?: number;
  limit?: number;
}

export const listPaymentOrders = async ({
  status = 'ALL',
  page = 1,
  limit = 20,
}: ListPaymentsParams) => {
  const where = status === 'ALL' ? {} : { status };
  const [orders, total, statusGroups] = await Promise.all([
    prisma.paymentOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: orderSelect,
    }),
    prisma.paymentOrder.count({ where }),
    prisma.paymentOrder.groupBy({
      by: ['status'],
      _count: { _all: true },
    }),
  ]);

  const studentIds = [...new Set(orders.map((order) => order.studentId))];
  const courseIds = [...new Set(orders.map((order) => order.courseId))];
  const [students, courses] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: studentIds } },
      select: { id: true, name: true, phone: true },
    }),
    prisma.course.findMany({
      where: { id: { in: courseIds } },
      select: { id: true, title: true },
    }),
  ]);
  const studentById = new Map(students.map((student) => [student.id, student]));
  const courseById = new Map(courses.map((course) => [course.id, course]));

  const counts: Record<string, number> = {};
  for (const group of statusGroups) {
    counts[group.status] = group._count._all;
  }

  return {
    orders: orders.map<PaymentOrderRow>((order) => {
      const student = studentById.get(order.studentId);
      return {
        id: order.id,
        amountMinor: order.amountMinor,
        currency: order.currency,
        status: order.status,
        provider: order.provider,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        studentName: student?.name ?? 'مستخدم محذوف',
        studentPhoneMasked: student ? maskPhone(student.phone) : '***',
        courseTitle: courseById.get(order.courseId)?.title ?? 'كورس محذوف',
      };
    }),
    total,
    page,
    limit,
    summary: counts,
  };
};

export const getPaymentOrderDetail = async (orderId: string) => {
  const order = await prisma.paymentOrder.findUnique({
    where: { id: orderId },
    select: orderSelect,
  });
  if (!order) return null;

  const [student, course, attempts, events, refunds] = await Promise.all([
    prisma.user.findUnique({
      where: { id: order.studentId },
      select: { name: true, phone: true },
    }),
    prisma.course.findUnique({
      where: { id: order.courseId },
      select: { title: true },
    }),
    prisma.paymentAttempt.findMany({
      where: { paymentOrderId: orderId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, responseCode: true, createdAt: true },
    }),
    prisma.paymentEvent.findMany({
      where: { paymentOrderId: orderId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, eventType: true, processingStatus: true, createdAt: true },
    }),
    prisma.refund.findMany({
      where: { paymentOrderId: orderId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        amountMinor: true,
        currency: true,
        status: true,
        reason: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    order: {
      id: order.id,
      amountMinor: order.amountMinor,
      currency: order.currency,
      status: order.status,
      provider: order.provider,
      failureReason: order.failureReason,
      paidAt: order.paidAt,
      createdAt: order.createdAt,
      studentName: student?.name ?? 'مستخدم محذوف',
      studentPhoneMasked: student ? maskPhone(student.phone) : '***',
      courseTitle: course?.title ?? 'كورس محذوف',
    },
    attempts,
    events: events.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      processingStatus: event.processingStatus,
      createdAt: event.createdAt,
    })),
    refunds,
  };
};

// A refund is idempotent per order while it is still active: replaying the
// request returns the existing row instead of creating a duplicate.
const ACTIVE_REFUND_STATUSES = ['REQUESTED', 'PROCESSING'];

export const initiateRefund = async (
  actorId: string,
  orderId: string,
  reason: string,
) => {
  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.paymentOrder.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, amountMinor: true, currency: true },
    });
    if (!order) return { code: 'NOT_FOUND' as const };

    if (order.status !== 'PAID') {
      return { code: 'REFUND_NOT_ALLOWED' as const };
    }

    const activeRefund = await tx.refund.findFirst({
      where: {
        paymentOrderId: orderId,
        status: { in: ACTIVE_REFUND_STATUSES },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        paymentOrderId: true,
        amountMinor: true,
        currency: true,
        status: true,
        reason: true,
        createdAt: true,
      },
    });
    if (activeRefund) return { code: 'EXISTING' as const, refund: activeRefund };

    const refund = await tx.refund.create({
      data: {
        paymentOrderId: orderId,
        amountMinor: order.amountMinor,
        currency: order.currency,
        status: 'REQUESTED',
        reason,
      },
      select: {
        id: true,
        paymentOrderId: true,
        amountMinor: true,
        currency: true,
        status: true,
        reason: true,
        createdAt: true,
      },
    });

    await tx.adminAuditEvent.create({
      data: {
        actorId,
        action: 'refund_initiated',
        category: 'finance',
        targetType: 'payment_order',
        targetId: orderId,
        metadata: JSON.stringify({
          refundId: refund.id,
          amountMinor: refund.amountMinor,
          currency: refund.currency,
        }),
      },
    });

    return { code: 'CREATED' as const, refund };
  });

  if (result.code === 'NOT_FOUND') logger.warn(`refund for missing order ${orderId}`);
  return result;
};

export const listRefunds = async ({ page = 1, limit = 20 }) => {
  const [refunds, total] = await Promise.all([
    prisma.refund.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        paymentOrderId: true,
        amountMinor: true,
        currency: true,
        status: true,
        reason: true,
        createdAt: true,
      },
    }),
    prisma.refund.count(),
  ]);
  return { refunds, total, page, limit };
};

export interface AuditEventRow {
  id: string;
  action: string;
  category: string;
  targetType: string;
  targetId: string;
  actorName: string;
  actorRole: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export const listAuditEvents = async ({
  category = 'ALL',
  page = 1,
  limit = 30,
}: { category?: string; page?: number; limit?: number } = {}) => {
  const where = category === 'ALL' ? {} : { category };
  const [events, total] = await Promise.all([
    prisma.adminAuditEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.adminAuditEvent.count({ where }),
  ]);

  const actorIds = [...new Set(events.map((event) => event.actorId))];
  const actors = await prisma.user.findMany({
    where: { id: { in: actorIds } },
    select: { id: true, name: true, role: true },
  });
  const actorById = new Map(actors.map((actor) => [actor.id, actor]));

  const mapped: AuditEventRow[] = events.map((event) => {
    let metadata: Record<string, unknown> | null = null;
    if (event.metadata) {
      try {
        metadata = JSON.parse(event.metadata) as Record<string, unknown>;
      } catch {
        metadata = null;
      }
    }
    const actor = actorById.get(event.actorId);
    return {
      id: event.id,
      action: event.action,
      category: event.category,
      targetType: event.targetType,
      targetId: event.targetId,
      actorName: actor?.name ?? 'مسؤول سابق',
      actorRole: actor?.role ?? 'SUPER_ADMIN',
      metadata,
      createdAt: event.createdAt,
    };
  });

  return { events: mapped, total, page, limit };
};
