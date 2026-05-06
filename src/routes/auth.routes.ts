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
import { authMiddleware } from '../middlewares/auth.middleware';

const router = Router();

router.post('/login', login);
router.post('/register', register);
router.post('/logout', authMiddleware, logout);
router.get('/me', authMiddleware, getMe);
router.put('/profile', authMiddleware, editProfile);
router.patch('/profile', authMiddleware, editProfile);
router.post('/change-password', authMiddleware, changePassword);

// Forgot Password Flow
router.post('/forgot-password', requestForgotPasswordOTP);
router.post('/verify-otp', verifyForgotPasswordOTP);
router.post('/reset-password', resetPassword);

export default router;
