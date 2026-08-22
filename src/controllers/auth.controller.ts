import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { logger } from '../utils/logger';
import { env } from '../utils/env';
import { generateOtp, hashOtp, hashResetToken, secureDigestEqual } from '../utils/otp';

const prisma = new PrismaClient();

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    // Never log request bodies or account identifiers on authentication paths.
    logger.info('Login attempt received');

    const identifier = req.body.identifier || req.body.phone || req.body.email;
    const password = req.body.password;

    if (!identifier || !password) {
      res.status(400).json({ error: 'Identifier (phone/email) and password are required' });
      return;
    }

    // Explicitly treat the identifier as a string
    const searchIdentifier = String(identifier);

    // MongoDB Mongoose uses $or, but Prisma uses OR
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { phone: searchIdentifier },
          { email: searchIdentifier }
        ]
      },
    });

    if (!user) {
      logger.warn('Login rejected: invalid credentials');
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      logger.warn('Login rejected: invalid credentials');
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const token = jwt.sign(
      { id: user.id, phone: user.phone, role: user.role, sv: user.sessionVersion },
      env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    logger.info('Login successful', { userId: user.id, role: user.role });

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        isApproved: user.isApproved,
        status: user.status,
      },
    });
  } catch (error) {
    logger.error('🔴 Login error:', error);
    
    if (error instanceof Error && error.message.includes('database')) {
      res.status(503).json({ error: 'Database unavailable. Please try again later.' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
};

export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, phone, email, password, role = 'STUDENT', parentPhone, deviceId } = req.body;

    // Defense in depth: schema validation already restricts these values, but
    // the controller must remain safe if it is ever called from another route.
    if (role !== 'STUDENT' && role !== 'PARENT') {
      res.status(403).json({ error: 'Public registration is limited to students and parents.' });
      return;
    }

    const sanitizedPhone = phone?.toString().trim();
    const sanitizedParentPhone = parentPhone?.toString().trim();
    const sanitizedDeviceId = deviceId?.toString().trim() || null;

    if (!name || !sanitizedPhone || !email || !password) {
      res.status(400).json({ error: 'Name, phone, email and password are required' });
      return;
    }

    // ── Device-limit guard: max 2 accounts per physical device ─────────────
    if (sanitizedDeviceId) {
      const existingAccounts = await prisma.user.count({
        where: { deviceId: sanitizedDeviceId },
      });
      if (existingAccounts >= 2) {
        res.status(403).json({
          error: 'This device has reached the maximum limit of 2 accounts.',
        });
        return;
      }
    }

    const existingUser = await prisma.user.findUnique({
      where: { phone: sanitizedPhone },
    });

    if (existingUser) {
      res.status(409).json({ message: 'عفواً، هذا الرقم مستخدم من قبل، يرجى تسجيل الدخول أو استخدام رقم آخر' });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name,
        phone: sanitizedPhone,
        email,
        password: hashedPassword,
        role,
        isApproved: true,
        status: 'approved',
        parentPhone: role === 'STUDENT' && sanitizedParentPhone ? sanitizedParentPhone : null,
        deviceId: sanitizedDeviceId,
      },
    });

    // A parent's phone matching a student's contact hint never grants access.
    // A verified StudentParentRelation must be created by the linking flow.

    // Issue JWT immediately so the client is authenticated without a separate login.
    const token = jwt.sign(
      { id: user.id, phone: user.phone, role: user.role, sv: user.sessionVersion },
      env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        isApproved: user.isApproved,
        status: user.status,
        isVerified: false,
      },
    });
  } catch (error) {
    logger.error('Register error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const editProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: any }).user;

    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { name, phone, vodafoneCashNumber, instapayHandle } = req.body;

    const updateData: any = {};

    if (name) updateData.name = name;
    if (phone) updateData.phone = phone;
    if (vodafoneCashNumber !== undefined) updateData.vodafoneCashNumber = vodafoneCashNumber;
    if (instapayHandle !== undefined) updateData.instapayHandle = instapayHandle;

    const user = await prisma.user.update({
      where: { id: authUser.id },
      data: updateData,
      select: {
        id: true,
        name: true,
        phone: true,
        role: true,
        status: true,
        isApproved: true,
        vodafoneCashNumber: true,
        instapayHandle: true,
      },
    });

    res.json({ user });
  } catch (error) {
    logger.error('editProfile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getMe = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: any }).user;

    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: {
        id: true,
        name: true,
        phone: true,
        role: true,
        status: true,
        isApproved: true,
        isVerified: true,
        subjectId: true,
        permissions: true,
        createdAt: true,
        vodafoneCashNumber: true,
        instapayHandle: true,
        parentTeacherId: true,
        parentTeacher: {
          select: { name: true }
        }
      }
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const response: any = { user };

    if (user.role === 'ASSISTANT' && user.parentTeacher) {
      response.user.parentTeacherName = user.parentTeacher.name;
    }

    res.json(response);
  } catch (error) {
    logger.error('getMe error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/change-password - Change user password
// ─────────────────────────────────────────────────────────────────────────────
export const changePassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: any }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      res.status(400).json({ error: 'Both oldPassword and newPassword are required' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { password: true },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const isValid = await bcrypt.compare(oldPassword, user.password);
    if (!isValid) {
      res.status(401).json({ error: 'Old password is incorrect' });
      return;
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { id: authUser.id },
      data: {
        password: hashedPassword,
        sessionVersion: { increment: 1 },
      },
    });

    res.json({ message: 'Password changed successfully. Please sign in again on every device.' });
  } catch (error) {
    logger.error('changePassword error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Forgot Password Flow ──────────────────────────────────────────────────

// Setup Nodemailer transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const genericResetRequestResponse = {
  message: 'If the account exists and has a verified email, a code will be sent shortly.',
};

const findAccountByIdentifier = (identifier: string) => prisma.user.findFirst({
  where: { OR: [{ phone: identifier }, { email: identifier }] },
});

export const requestForgotPasswordOTP = async (req: Request, res: Response): Promise<void> => {
  const identifier = String(req.body.identifier || req.body.studentPhone || '').trim();

  try {
    const account = await findAccountByIdentifier(identifier);

    // Always return the same response to prevent account enumeration.
    if (!account?.email || !env.EMAIL_USER || !env.EMAIL_PASS) {
      logger.warn('Password reset request could not be delivered', {
        accountFound: Boolean(account),
        hasVerifiedEmail: Boolean(account?.email),
        emailProviderConfigured: Boolean(env.EMAIL_USER && env.EMAIL_PASS),
      });
      res.status(202).json(genericResetRequestResponse);
      return;
    }

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.passwordResetOTP.deleteMany({ where: { studentPhone: account.phone } });
    await prisma.passwordResetOTP.create({
      data: {
        studentPhone: account.phone,
        otp: hashOtp(account.id, otp, env.JWT_SECRET),
        expiresAt,
      },
    });

    await transporter.sendMail({
      from: `"منصة مستر إسماعيل الجزار" <${env.EMAIL_USER}>`,
      to: account.email,
      subject: 'كود استعادة كلمة المرور',
      html: `
        <div dir="rtl" style="font-family:Arial,sans-serif;background:#f2ede7;padding:32px;color:#11100f">
          <div style="max-width:560px;margin:auto;background:#fff;padding:32px;border:1px solid #d6cabe">
            <h2>استعادة كلمة المرور</h2>
            <p>استخدم الكود التالي خلال 10 دقائق. لا تشاركه مع أي شخص.</p>
            <p style="font:700 36px monospace;letter-spacing:8px">${otp}</p>
            <p>إذا لم تطلب تغيير كلمة المرور، تجاهل الرسالة.</p>
          </div>
        </div>`,
    });

    res.status(202).json(genericResetRequestResponse);
  } catch (error) {
    // Keep the public response generic while preserving an actionable server log.
    logger.error('Password reset delivery failed:', error);
    res.status(202).json(genericResetRequestResponse);
  }
};

export const verifyForgotPasswordOTP = async (req: Request, res: Response): Promise<void> => {
  try {
    const identifier = String(req.body.identifier || req.body.studentPhone || '').trim();
    const account = await findAccountByIdentifier(identifier);
    const genericError = { error: 'Invalid or expired verification code' };

    if (!account) {
      res.status(400).json(genericError);
      return;
    }

    const record = await prisma.passwordResetOTP.findFirst({
      where: { studentPhone: account.phone, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!record || record.expiresAt <= new Date() || record.attempts >= 5) {
      res.status(400).json(genericError);
      return;
    }

    const actualDigest = hashOtp(account.id, String(req.body.otp), env.JWT_SECRET);
    if (!secureDigestEqual(actualDigest, record.otp)) {
      await prisma.passwordResetOTP.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      res.status(400).json(genericError);
      return;
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    await prisma.passwordResetOTP.update({
      where: { id: record.id },
      data: {
        resetToken: hashResetToken(resetToken),
        // Invalidate the short OTP immediately; only the long reset token remains usable.
        otp: hashOtp(account.id, crypto.randomBytes(16).toString('hex'), env.JWT_SECRET),
      },
    });

    res.json({ message: 'OTP verified', resetToken });
  } catch (error) {
    logger.error('verifyForgotPasswordOTP error:', error);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
};

export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const identifier = String(req.body.identifier || req.body.studentPhone || '').trim();
    const account = await findAccountByIdentifier(identifier);
    const tokenDigest = hashResetToken(String(req.body.resetToken));
    const record = await prisma.passwordResetOTP.findUnique({
      where: { resetToken: tokenDigest },
    });

    if (!account || !record || record.studentPhone !== account.phone ||
        record.consumedAt !== null || record.expiresAt <= new Date()) {
      res.status(400).json({ error: 'Invalid or expired reset request' });
      return;
    }

    const hashedPassword = await bcrypt.hash(String(req.body.newPassword), 12);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: account.id },
        data: {
          password: hashedPassword,
          sessionVersion: { increment: 1 },
        },
      }),
      prisma.passwordResetOTP.deleteMany({ where: { studentPhone: account.phone } }),
    ]);

    res.json({ message: 'Password reset successful. Please sign in again on every device.' });
  } catch (error) {
    logger.error('resetPassword error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
};
