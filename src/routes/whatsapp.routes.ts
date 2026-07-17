import { Router } from 'express';
import { logger } from '../utils/logger';
import { env } from '../utils/env';
import { otpRateLimit } from '../middlewares/rateLimit.middleware';
import { validateBody } from '../middlewares/validate.middleware';
import { requestOtpSchema } from '../schemas/auth.schema';

const router = Router();

// POST /api/auth/student/request-otp
// Dummy endpoint - returns success without actually sending SMS
router.post('/student/request-otp', otpRateLimit, validateBody(requestOtpSchema), async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'Phone number is required',
      });
    }

    // TODO: Implement Telegram SMS integration
    // For now, just return success so Flutter app doesn't break
    logger.info(`📱 OTP request for ${phone} (Telegram integration pending)`);

    return res.status(200).json({
      success: true,
      message: 'تم إرسال الكود بنجاح',
    });
  } catch (error: any) {
    logger.error('❌ Error sending OTP:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to send OTP',
    });
  }
});

// POST /api/auth/student/verify-otp
// Dummy verification - accepts any 4-digit code
router.post('/student/verify-otp', otpRateLimit, async (req, res) => {
  try {
    const { phone, code } = req.body;

    if (!phone || !code) {
      return res.status(400).json({
        success: false,
        error: 'Phone and code are required',
      });
    }

    // TODO: Implement proper OTP verification from database
    // For now, accept any 4-digit code
    logger.info(`🔐 Verifying OTP ${code} for ${phone}`);

    if (code.length === 4 && /^\d+$/.test(code)) {
      return res.status(200).json({
        success: true,
        message: 'تم التأكد من الكود',
      });
    } else {
      return res.status(400).json({
        success: false,
        error: 'كود غير صحيح',
      });
    }
  } catch (error: any) {
    logger.error('❌ Error verifying OTP:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to verify OTP',
    });
  }
});

// POST /api/auth/parent/request-otp
router.post('/parent/request-otp', otpRateLimit, validateBody(requestOtpSchema), async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'Phone number is required',
      });
    }

    // TODO: Implement Telegram SMS integration
    logger.info(`📱 Parent OTP request for ${phone} (Telegram integration pending)`);

    return res.status(200).json({
      success: true,
      message: 'تم إرسال الكود بنجاح',
    });
  } catch (error: any) {
    logger.error('❌ Error sending OTP:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to send OTP',
    });
  }
});

// POST /api/auth/parent/verify-otp
router.post('/parent/verify-otp', otpRateLimit, async (req, res) => {
  try {
    const { phone, code } = req.body;

    if (!phone || !code) {
      return res.status(400).json({
        success: false,
        error: 'Phone and code are required',
      });
    }

    logger.info(`🔐 Verifying parent OTP ${code} for ${phone}`);

    if (code.length === 4 && /^\d+$/.test(code)) {
      return res.status(200).json({
        success: true,
        message: 'تم التأكد من الكود',
      });
    } else {
      return res.status(400).json({
        success: false,
        error: 'كود غير صحيح',
      });
    }
  } catch (error: any) {
    logger.error('❌ Error verifying OTP:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to verify OTP',
    });
  }
});

// GET /api/auth/student/parent-verification-status
router.get('/student/parent-verification-status', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        verified: false,
        error: 'No token provided',
      });
    }

    const token = authHeader.split(' ')[1];
    const jwt = require('jsonwebtoken');

    try {
      jwt.verify(token, env.JWT_SECRET);
    } catch (e) {
      return res.status(401).json({
        verified: false,
        error: 'Invalid token',
      });
    }

    // TODO: Check database for actual parent verification status
    return res.status(200).json({
      verified: true,
      message: 'Parent verified',
    });
  } catch (error: any) {
    logger.error('❌ Error checking parent verification:', error);
    return res.status(500).json({
      verified: false,
      error: error.message || 'Failed to check verification',
    });
  }
});

export default router;