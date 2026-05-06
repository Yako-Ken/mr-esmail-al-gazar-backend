import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { getIO } from '../socket';

const prisma = new PrismaClient();

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('📥 LOGIN REQUEST RECEIVED');
    console.log('   Body:', JSON.stringify(req.body));

    const identifier = req.body.identifier || req.body.phone || req.body.email;
    const password = req.body.password;

    if (!identifier || !password) {
      res.status(400).json({ error: 'Identifier (phone/email) and password are required' });
      return;
    }

    // Explicitly treat the identifier as a string
    const searchIdentifier = String(identifier);

    console.log('🔍 Looking for user with identifier:', searchIdentifier);

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
      console.log('❌ User not found for identifier:', searchIdentifier);
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    console.log('✅ User found:', user.name);

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      console.log('❌ Invalid password for user:', searchIdentifier);
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const token = jwt.sign(
      { id: user.id, phone: user.phone, role: user.role },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    );

    console.log('✅ Login successful for user:', searchIdentifier);

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
    console.error('🔴 Login error:', error);
    
    if (error instanceof Error && error.message.includes('database')) {
      res.status(503).json({ error: 'Database unavailable. Please try again later.' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
};

export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, phone, password, role, parentPhone, deviceId } = req.body;

    const sanitizedPhone = phone?.toString().trim();
    const sanitizedParentPhone = parentPhone?.toString().trim();
    const sanitizedDeviceId = deviceId?.toString().trim() || null;

    if (!name || !sanitizedPhone || !password) {
      res.status(400).json({ error: 'Name, phone and password are required' });
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
        password: hashedPassword,
        role: role || 'STUDENT',
        isApproved: role === 'TEACHER' ? false : true,
        status: role === 'TEACHER' ? 'pending' : 'approved',
        parentPhone: role === 'STUDENT' && sanitizedParentPhone ? sanitizedParentPhone : null,
        deviceId: sanitizedDeviceId,
      },
    });

    if (user.role === 'TEACHER') {
      const io = getIO();
      if (io) {
        io.to('admins').emit('new_teacher_pending', {
          teacherId: user.id,
          name: user.name,
          phone: user.phone,
          status: user.status,
          message: 'A new teacher has registered and is awaiting approval.'
        });
      }
    }

    // ── Auto-link: when a PARENT registers, find students whose stored
    // parentPhone matches this parent's phone and create the relation.
    if (user.role === 'PARENT') {
      console.log(`✅ PARENT registered: ${user.phone} — children will be linked via /api/parents/my-children`);
    }

    // Issue JWT immediately so the client is authenticated without a separate login
    const token = jwt.sign(
      { id: user.id, phone: user.phone, role: user.role },
      process.env.JWT_SECRET!,
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
    console.error('Register error:', error);
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

    const { name, phone, password, vodafoneCashNumber, instapayHandle } = req.body;

    const updateData: any = {};

    if (name) updateData.name = name;
    if (phone) updateData.phone = phone;
    if (password) {
      updateData.password = await bcrypt.hash(password, 10);
    }
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
    console.error('editProfile error:', error);
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
    console.error('getMe error:', error);
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

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: authUser.id },
      data: { password: hashedPassword },
    });

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('changePassword error:', error);
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

export const requestForgotPasswordOTP = async (req: Request, res: Response): Promise<void> => {
  try {
    const { studentPhone, parentPhone, email } = req.body;

    if (!studentPhone || !parentPhone || !email) {
      res.status(400).json({ error: 'All fields are required' });
      return;
    }

    // Validate student and parent phone match
    const student = await prisma.user.findFirst({
      where: {
        phone: studentPhone,
        parentPhone: parentPhone,
        role: 'STUDENT',
      },
    });

    if (!student) {
      res.status(404).json({ error: 'Student with this phone and parent phone not found' });
      return;
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiration = new Date();
    expiration.setMinutes(expiration.getMinutes() + 15);

    // Save or update OTP in DB
    await prisma.passwordResetOTP.deleteMany({ where: { studentPhone } });
    await prisma.passwordResetOTP.create({
      data: {
        studentPhone,
        otp,
        expiresAt: expiration,
      },
    });

    // Send email
    const mailOptions = {
      from: `"تطبيق مستر إسماعيل الجزار" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'كود التحقق - تطبيق مستر إسماعيل الجزار 🔒',
      html: `
        <div dir="rtl" style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f7f6; padding: 40px; text-align: center; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 15px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.05); border: 1px solid #e0e0e0;">
            <div style="background-color: #0D0F18; padding: 30px; color: #ffffff;">
              <img src="https://i.ibb.co/chQn8ztr/logo-page-0001.jpg" alt="Logo" style="width: 150px; margin-bottom: 15px; border-radius: 10px;">
              <p style="margin: 0; opacity: 0.8; font-size: 18px;">منصة مستر إسماعيل الجزار التعليمية</p>
            </div>
            <div style="padding: 40px;">
              <h2 style="color: #0D0F18; margin-top: 0; font-weight: 700;">طلب استعادة كلمة السر</h2>
              <p style="font-size: 16px; line-height: 1.6; margin-bottom: 30px;">
                مرحباً بك، لقد طلبت كود التحقق لتغيير كلمة السر الخاصة بك في <strong>تطبيق مستر إسماعيل الجزار</strong>. يرجى استخدام الكود التالي لإتمام العملية:
              </p>
              <div style="background-color: #f9f9f9; border: 2px dashed #0D0F18; border-radius: 12px; padding: 25px; margin-bottom: 30px;">
                <span style="font-family: 'Courier New', Courier, monospace; font-size: 42px; font-weight: 900; letter-spacing: 10px; color: #0D0F18;">${otp}</span>
              </div>
              <p style="font-size: 14px; background-color: #fff9e6; border-right: 4px solid #ffcc00; padding: 15px; border-radius: 4px; display: inline-block; text-align: right; width: 100%; box-sizing: border-box;">
                <strong>⚠️ ملاحظة هامة:</strong> هذا الكود صالح لمدة <strong>15 دقيقة</strong> فقط. إذا لم تكن أنت من طلب هذا الكود، يرجى تجاهل هذا البريد.
              </p>
            </div>
            <div style="background-color: #fafafa; padding: 20px; border-top: 1px solid #eeeeee; font-size: 12px; color: #999;">
              © ${new Date().getFullYear()} تطبيق مستر إسماعيل الجزار - جميع الحقوق محفوظة
            </div>
          </div>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);

    res.json({ message: 'OTP sent to your email' });
  } catch (error) {
    console.error('requestForgotPasswordOTP error:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
};

export const verifyForgotPasswordOTP = async (req: Request, res: Response): Promise<void> => {
  try {
    const { studentPhone, otp } = req.body;

    if (!studentPhone || !otp) {
      res.status(400).json({ error: 'Phone and OTP are required' });
      return;
    }

    const record = await prisma.passwordResetOTP.findFirst({
      where: {
        studentPhone,
        otp,
        expiresAt: { gt: new Date() },
      },
    });

    if (!record) {
      res.status(400).json({ error: 'Invalid or expired OTP' });
      return;
    }

    // Generate a secure reset token
    const resetToken = crypto.randomBytes(32).toString('hex');

    await prisma.passwordResetOTP.update({
      where: { id: record.id },
      data: { resetToken },
    });

    res.json({ message: 'OTP verified', resetToken });
  } catch (error) {
    console.error('verifyForgotPasswordOTP error:', error);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
};

export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { studentPhone, resetToken, newPassword } = req.body;

    if (!studentPhone || !resetToken || !newPassword) {
      res.status(400).json({ error: 'All fields are required' });
      return;
    }

    const record = await prisma.passwordResetOTP.findUnique({
      where: { resetToken },
    });

    if (!record || record.studentPhone !== studentPhone || record.expiresAt < new Date()) {
      res.status(400).json({ error: 'Invalid or expired reset token' });
      return;
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update user password
    await prisma.user.update({
      where: { phone: studentPhone },
      data: { password: hashedPassword },
    });

    // Delete the OTP record
    await prisma.passwordResetOTP.delete({ where: { id: record.id } });

    res.json({ message: 'Password reset successful' });
  } catch (error) {
    console.error('resetPassword error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
};
