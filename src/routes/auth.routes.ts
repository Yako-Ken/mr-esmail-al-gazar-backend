import { Router } from 'express';
import { 
  login, 
  register, 
  getMe, 
  editProfile, 
  changePassword,
  requestForgotPasswordOTP,
  verifyForgotPasswordOTP,
  resetPassword
} from '../controllers/auth.controller';
import { logout } from '../controllers/logout.controller';
import {
  listSessions,
  revokeOtherSessions,
  revokeSession,
} from '../controllers/session.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { authRateLimit, otpRateLimit } from '../middlewares/rateLimit.middleware';
import { validateBody } from '../middlewares/validate.middleware';
import {
  loginSchema,
  registerSchema,
  changePasswordSchema,
  forgotPasswordRequestSchema,
  verifyOtpSchema,
  resetPasswordSchema,
} from '../schemas/auth.schema';

const router = Router();

router.post('/login', authRateLimit, validateBody(loginSchema), login);
router.post('/register', authRateLimit, validateBody(registerSchema), register);
router.post('/logout', authMiddleware, logout);
router.get('/me', authMiddleware, getMe);
router.get('/sessions', authMiddleware, listSessions);
router.delete('/sessions/:sessionId', authMiddleware, revokeSession);
router.post('/sessions/revoke-others', authMiddleware, revokeOtherSessions);
router.put('/profile', authMiddleware, editProfile);
router.patch('/profile', authMiddleware, editProfile);
router.post('/change-password', authMiddleware, validateBody(changePasswordSchema), changePassword);

// Forgot Password Flow
router.post('/forgot-password', otpRateLimit, validateBody(forgotPasswordRequestSchema), requestForgotPasswordOTP);
router.post('/verify-otp', otpRateLimit, validateBody(verifyOtpSchema), verifyForgotPasswordOTP);
router.post('/reset-password', validateBody(resetPasswordSchema), resetPassword);

export default router;
