import { Request, Response } from 'express';
import { Prisma, PrismaClient } from '@prisma/client';
import { AuthUser } from '../middlewares/auth.middleware';
import { logger } from '../utils/logger';
import {
  CreateSupportTicketInput,
  UpdatePreferencesInput,
} from '../schemas/account.schema';

const prisma = new PrismaClient();

type AuthenticatedRequest = Request & { user?: AuthUser };

const requireUser = (req: AuthenticatedRequest, res: Response): AuthUser | null => {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return req.user;
};

const preferenceSelect = {
  analyticsConsent: true,
  productMessagesConsent: true,
  notifLessons: true,
  notifHomework: true,
  notifAttendance: true,
  notifPayments: true,
  notifProduct: true,
  quietHoursEnabled: true,
  quietHoursStart: true,
  quietHoursEnd: true,
  updatedAt: true,
} as const;

type PreferencePayload = Prisma.UserPreferenceGetPayload<{
  select: typeof preferenceSelect;
}>;

// Returns the user's preferences, creating defaults plus a one-time
// 'terms_accepted' consent event on first access. Safe under concurrency.
const ensureDefaultPreferences = async (
  client: Prisma.TransactionClient | PrismaClient,
  userId: string,
): Promise<PreferencePayload> => {
  const existing = await client.userPreference.findUnique({
    where: { userId },
    select: preferenceSelect,
  });
  if (existing) return existing;

  await client.consentEvent.create({
    data: { userId, kind: 'terms_accepted', value: 'accepted' },
  });
  return client.userPreference
    .create({
      data: { user: { connect: { id: userId } } },
      select: preferenceSelect,
    })
    .catch(async () => {
      // Lost the creation race against a concurrent first request.
      return client.userPreference.findUniqueOrThrow({
        where: { userId },
        select: preferenceSelect,
      });
    });
};

export const getPreferences = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const user = requireUser(req, res);
    if (!user) return;

    const preferences = await prisma.$transaction((tx) =>
      ensureDefaultPreferences(tx, user.id),
    );

    res.json({ preferences });
  } catch (error) {
    logger.error('getPreferences error:', error);
    res.status(500).json({ error: 'Unable to load preferences' });
  }
};

export const updatePreferences = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    const input = req.body as UpdatePreferencesInput;

    const result = await prisma.$transaction(async (tx): Promise<PreferencePayload> => {
      const current = await ensureDefaultPreferences(tx, user.id);

      const consentChanges: Array<{ kind: string; value: string }> = [];
      if (input.analyticsConsent !== undefined && input.analyticsConsent !== current.analyticsConsent) {
        consentChanges.push({
          kind: 'analytics_consent',
          value: input.analyticsConsent ? 'granted' : 'withdrawn',
        });
      }
      if (
        input.productMessagesConsent !== undefined &&
        input.productMessagesConsent !== current.productMessagesConsent
      ) {
        consentChanges.push({
          kind: 'product_messages_consent',
          value: input.productMessagesConsent ? 'granted' : 'withdrawn',
        });
      }

      if (consentChanges.length > 0) {
        await tx.consentEvent.createMany({
          data: consentChanges.map((change) => ({
            userId: user.id,
            kind: change.kind,
            value: change.value,
          })),
        });
      }

      return tx.userPreference.update({
        where: { userId: user.id },
        data: input,
        select: preferenceSelect,
      });
    });

    res.json({ preferences: result });
  } catch (error) {
    logger.error('updatePreferences error:', error);
    res.status(500).json({ error: 'Unable to save preferences' });
  }
};

export const listConsentHistory = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const user = requireUser(req, res);
    if (!user) return;

    const events = await prisma.consentEvent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, kind: true, value: true, createdAt: true },
    });

    res.json({ events });
  } catch (error) {
    logger.error('listConsentHistory error:', error);
    res.status(500).json({ error: 'Unable to load consent history' });
  }
};

export const createSupportTicket = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    const input = req.body as CreateSupportTicketInput;

    const ticket = await prisma.supportTicket.create({
      data: {
        userId: user.id,
        subject: input.subject,
        details: input.details,
      },
      select: {
        id: true,
        subject: true,
        status: true,
        createdAt: true,
      },
    });

    res.status(201).json({ ticket });
  } catch (error) {
    logger.error('createSupportTicket error:', error);
    res.status(500).json({ error: 'Unable to submit support ticket' });
  }
};

export const listSupportTickets = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const user = requireUser(req, res);
    if (!user) return;

    const tickets = await prisma.supportTicket.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        subject: true,
        status: true,
        createdAt: true,
      },
    });

    res.json({ tickets });
  } catch (error) {
    logger.error('listSupportTickets error:', error);
    res.status(500).json({ error: 'Unable to load support tickets' });
  }
};
