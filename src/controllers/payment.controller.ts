import { Request, RequestHandler } from 'express';
import { Prisma, PrismaClient } from '@prisma/client';
import { AuthUser } from '../middlewares/auth.middleware';
import { createPaymobIntention, isPaymobConfigured } from '../services/paymob.service';
import { env } from '../utils/env';
import { logger } from '../utils/logger';
import { verifyPaymobHmac } from '../utils/paymobHmac';

import prisma from '../config/prisma';

const publicOrder = (order: {
  id: string;
  courseId: string;
  amountMinor: number;
  currency: string;
  provider: string;
  status: string;
  checkoutUrl: string | null;
  failureReason: string | null;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: order.id,
  courseId: order.courseId,
  amountMinor: order.amountMinor,
  currency: order.currency,
  provider: order.provider,
  status: order.status,
  checkoutUrl: order.checkoutUrl,
  failureReason: order.failureReason,
  paidAt: order.paidAt,
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
});

export const createCheckoutIntention: RequestHandler = async (req, res): Promise<void> => {
  const authUser = (req as Request & { user?: AuthUser }).user;
  if (!authUser || authUser.role !== 'STUDENT') {
    res.status(403).json({ error: 'Students only' });
    return;
  }

  const { courseId, idempotencyKey, channel } = req.body as {
    courseId: string;
    idempotencyKey: string;
    channel: 'WEB' | 'DIRECT_APK';
  };

  try {
    const existing = await prisma.paymentOrder.findUnique({ where: { idempotencyKey } });
    if (existing) {
      if (existing.studentId !== authUser.id || existing.courseId !== courseId) {
        res.status(409).json({ error: 'Idempotency key is already used for another order.' });
        return;
      }
      res.json({ order: publicOrder(existing), reused: true });
      return;
    }

    if (!isPaymobConfigured()) {
      res.status(503).json({
        error: 'Online payments are not configured in this environment.',
        code: 'PAYMENTS_NOT_CONFIGURED',
      });
      return;
    }

    const [course, student, entitlement] = await Promise.all([
      prisma.course.findUnique({ where: { id: courseId } }),
      prisma.user.findUnique({ where: { id: authUser.id } }),
      prisma.courseEntitlement.findUnique({
        where: { studentId_courseId: { studentId: authUser.id, courseId } },
      }),
    ]);

    if (!course) {
      res.status(404).json({ error: 'Course not found' });
      return;
    }
    if (entitlement?.status === 'ACTIVE') {
      res.status(409).json({ error: 'Course is already owned.', code: 'ALREADY_OWNED' });
      return;
    }
    const amountMinor = course.priceMinor > 0 ? course.priceMinor : Math.round(course.price * 100);
    if (amountMinor <= 0) {
      res.status(400).json({ error: 'Use the free enrollment endpoint for this course.' });
      return;
    }
    if (!student?.email) {
      res.status(400).json({ error: 'A verified email is required before payment.' });
      return;
    }

    const order = await prisma.paymentOrder.create({
      data: {
        studentId: authUser.id,
        courseId,
        amountMinor,
        currency: course.currency || 'EGP',
        provider: `PAYMOB_${channel}`,
        status: 'CREATING',
        idempotencyKey,
      },
    });
    await prisma.paymentAttempt.create({ data: { paymentOrderId: order.id } });

    try {
      const intention = await createPaymobIntention({
        orderId: order.id,
        courseTitle: course.title,
        amountMinor,
        currency: order.currency,
        customer: { name: student.name, email: student.email, phone: student.phone },
      });
      const updated = await prisma.paymentOrder.update({
        where: { id: order.id },
        data: {
          status: 'PENDING',
          providerOrderId: intention.providerOrderId,
          providerIntentionId: intention.intentionId,
          checkoutUrl: intention.checkoutUrl,
        },
      });
      res.status(201).json({ order: publicOrder(updated), reused: false });
    } catch (error) {
      await prisma.paymentOrder.update({
        where: { id: order.id },
        data: { status: 'FAILED', failureReason: 'PROVIDER_INTENTION_FAILED' },
      });
      logger.error('Paymob intention creation failed:', error);
      res.status(502).json({ error: 'Payment provider is temporarily unavailable.' });
    }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      res.status(409).json({ error: 'Duplicate checkout request.' });
      return;
    }
    logger.error('createCheckoutIntention error:', error);
    res.status(500).json({ error: 'Could not start checkout.' });
  }
};

export const getPaymentOrder: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const order = await prisma.paymentOrder.findUnique({ where: { id: req.params.orderId } });
    if (!order || (order.studentId !== authUser.id && authUser.role !== 'SUPER_ADMIN')) {
      res.status(404).json({ error: 'Payment order not found.' });
      return;
    }
    res.json({ order: publicOrder(order) });
  } catch (error) {
    logger.error('getPaymentOrder error:', error);
    res.status(500).json({ error: 'Could not load payment status.' });
  }
};

export const listMyPayments: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser || authUser.role !== 'STUDENT') {
      res.status(403).json({ error: 'Students only' });
      return;
    }
    const orders = await prisma.paymentOrder.findMany({
      where: { studentId: authUser.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ orders: orders.map(publicOrder) });
  } catch (error) {
    logger.error('listMyPayments error:', error);
    res.status(500).json({ error: 'Could not load payment history.' });
  }
};

export const paymobWebhook: RequestHandler = async (req, res): Promise<void> => {
  try {
    if (!env.PAYMOB_HMAC_SECRET) {
      res.status(503).json({ error: 'Payment webhook is not configured.' });
      return;
    }

    const object = (req.body?.obj ?? req.body) as Record<string, any>;
    const receivedHmac = String(req.query.hmac ?? req.body?.hmac ?? '');
    if (!receivedHmac || !verifyPaymobHmac(object, receivedHmac, env.PAYMOB_HMAC_SECRET)) {
      res.status(401).json({ error: 'Invalid webhook signature.' });
      return;
    }

    const transactionId = String(object.id ?? '');
    const providerOrderId = String(object.order?.id ?? '');
    const merchantOrderId = String(
      object.order?.merchant_order_id ?? object.special_reference ?? object.extras?.merchant_order_id ?? '',
    );
    if (!transactionId || (!providerOrderId && !merchantOrderId)) {
      res.status(400).json({ error: 'Invalid webhook payload.' });
      return;
    }

    const order = await prisma.paymentOrder.findFirst({
      where: {
        OR: [
          ...(merchantOrderId ? [{ id: merchantOrderId }] : []),
          ...(providerOrderId ? [{ providerOrderId }] : []),
        ],
      },
    });
    if (!order) {
      res.status(202).json({ received: true, matched: false });
      return;
    }

    const eventState = `${object.success}-${object.pending}-${object.is_refunded}-${object.is_voided}`;
    const externalEventId = `paymob:${transactionId}:${eventState}`;
    const amountMinor = Number(object.amount_cents);
    const currency = String(object.currency ?? '').toUpperCase();
    const successful = object.success === true && object.pending !== true && object.error_occured !== true;
    const amountMatches = amountMinor === order.amountMinor && currency === order.currency;
    const eventPayload = JSON.stringify({
      transactionId,
      providerOrderId,
      amountMinor,
      currency,
      success: object.success === true,
      pending: object.pending === true,
      refunded: object.is_refunded === true,
      voided: object.is_voided === true,
    });

    try {
      await prisma.$transaction(async (tx) => {
        const duplicate = await tx.paymentEvent.findUnique({ where: { externalEventId } });
        if (duplicate) return;

        const event = await tx.paymentEvent.create({
          data: {
            externalEventId,
            paymentOrderId: order.id,
            eventType: successful ? 'PAYMENT_SUCCEEDED' : 'PAYMENT_UPDATED',
            payload: eventPayload,
            processingStatus: amountMatches ? 'PROCESSING' : 'REJECTED_AMOUNT_MISMATCH',
          },
        });

        if (successful && amountMatches) {
          await tx.paymentOrder.update({
            where: { id: order.id },
            data: { status: 'PAID', paidAt: new Date(), failureReason: null },
          });
          await tx.paymentAttempt.updateMany({
            where: { paymentOrderId: order.id, status: 'CREATED' },
            data: { status: 'SUCCEEDED', providerAttemptId: transactionId },
          });
          await tx.courseEntitlement.upsert({
            where: { studentId_courseId: { studentId: order.studentId, courseId: order.courseId } },
            create: {
              studentId: order.studentId,
              courseId: order.courseId,
              sourceOrderId: order.id,
              status: 'ACTIVE',
            },
            update: { sourceOrderId: order.id, status: 'ACTIVE', revokedAt: null },
          });
          await tx.courseEnrollment.upsert({
            where: { studentId_courseId: { studentId: order.studentId, courseId: order.courseId } },
            create: {
              studentId: order.studentId,
              courseId: order.courseId,
              paymentMethod: 'PAYMOB',
              status: 'APPROVED',
            },
            update: { paymentMethod: 'PAYMOB', status: 'APPROVED', receiptImageUrl: null },
          });
        } else if (!amountMatches) {
          await tx.paymentOrder.update({
            where: { id: order.id },
            data: { failureReason: 'WEBHOOK_AMOUNT_MISMATCH' },
          });
        } else if (object.pending !== true) {
          await tx.paymentOrder.update({
            where: { id: order.id },
            data: { status: 'FAILED', failureReason: 'PROVIDER_REJECTED' },
          });
        }

        await tx.paymentEvent.update({
          where: { id: event.id },
          data: { processingStatus: amountMatches ? 'PROCESSED' : 'REJECTED_AMOUNT_MISMATCH', processedAt: new Date() },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        logger.info(`Concurrent duplicate webhook event detected for ${externalEventId}, resolving idempotently.`);
        res.json({ received: true, matched: true });
        return;
      }
      throw error;
    }

    res.json({ received: true, matched: true });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      res.json({ received: true, matched: true });
      return;
    }
    logger.error('paymobWebhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed.' });
  }
};
