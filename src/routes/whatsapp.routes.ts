import { Router } from 'express';

const router = Router();

// POST /api/auth/student/request-otp
// Dummy endpoint - returns success without actually sending SMS
router.post('/student/request-otp', async (req, res) => {
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
    console.log(`📱 OTP request for ${phone} (Telegram integration pending)`);

    return res.status(200).json({
      success: true,
      message: 'تم إرسال الكود بنجاح',
    });
  } catch (error: any) {
    console.error('❌ Error sending OTP:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to send OTP',
    });
  }
});

// POST /api/auth/student/verify-otp
// Dummy verification - accepts any 4-digit code
router.post('/student/verify-otp', async (req, res) => {
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
    console.log(`🔐 Verifying OTP ${code} for ${phone}`);

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
    console.error('❌ Error verifying OTP:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to verify OTP',
    });
  }
});

// POST /api/auth/parent/request-otp
router.post('/parent/request-otp', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'Phone number is required',
      });
    }

    // TODO: Implement Telegram SMS integration
    console.log(`📱 Parent OTP request for ${phone} (Telegram integration pending)`);

    return res.status(200).json({
      success: true,
      message: 'تم إرسال الكود بنجاح',
    });
  } catch (error: any) {
    console.error('❌ Error sending OTP:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to send OTP',
    });
  }
});

// POST /api/auth/parent/verify-otp
router.post('/parent/verify-otp', async (req, res) => {
  try {
    const { phone, code } = req.body;

    if (!phone || !code) {
      return res.status(400).json({
        success: false,
        error: 'Phone and code are required',
      });
    }

    console.log(`🔐 Verifying parent OTP ${code} for ${phone}`);

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
    console.error('❌ Error verifying OTP:', error);
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
    const jwtSecret = process.env.JWT_SECRET || 'your-secret-key';
    
    try {
      jwt.verify(token, jwtSecret);
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
    console.error('❌ Error checking parent verification:', error);
    return res.status(500).json({
      verified: false,
      error: error.message || 'Failed to check verification',
    });
  }
});

export default router;