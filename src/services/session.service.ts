import { PrismaClient, UserSession } from '@prisma/client';
import { Request } from 'express';

const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const sanitizeHeader = (value: unknown, maxLength: number): string | null => {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\r\n\0]/g, ' ').trim();
  return clean ? clean.slice(0, maxLength) : null;
};

export const maskIpAddress = (rawIp: string | undefined): string | null => {
  if (!rawIp) return null;
  const ip = rawIp.replace(/^::ffff:/, '').trim();
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.*`;
  if (ip.includes(':')) {
    const parts = ip.split(':').filter(Boolean);
    return `${parts.slice(0, 3).join(':')}::*`;
  }
  return null;
};

export const describeDevice = (req: Request): string => {
  const supplied = sanitizeHeader(req.headers['x-device-name'], 80);
  if (supplied) return supplied;

  const agent = sanitizeHeader(req.headers['user-agent'], 300)?.toLowerCase() ?? '';
  if (agent.includes('android')) return 'Android';
  if (agent.includes('iphone') || agent.includes('ipad')) return 'iPhone / iPad';
  if (agent.includes('windows')) return 'Windows';
  if (agent.includes('mac os') || agent.includes('macintosh')) return 'macOS';
  if (agent.includes('linux')) return 'Linux';
  if (agent.includes('dart')) return 'تطبيق الموبايل';
  return 'جهاز غير معروف';
};

export const createUserSession = async (
  prisma: PrismaClient,
  req: Request,
  userId: string,
): Promise<UserSession> => {
  const now = new Date();
  return prisma.userSession.create({
    data: {
      userId,
      deviceName: describeDevice(req),
      userAgent: sanitizeHeader(req.headers['user-agent'], 500),
      ipHint: maskIpAddress(req.ip),
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS),
    },
  });
};
