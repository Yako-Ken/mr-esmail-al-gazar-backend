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
import {
  authRateLimit,
  otpRateLimit,
  sensitiveActionRateLimit,
} from '../middlewares/rateLimit.middleware';
import { validateBody } from '../middlewares/validate.middleware';
import {
  loginSchema,
  registerSchema,
  changePasswordSchema,
  forgotPasswordRequestSchema,
  verifyOtpSchema,
  resetPasswordSchema,
} from '../schemas/auth.schema';
import {
  cancelAccountDeletionSchema,
  exportAccountDataSchema,
  requestAccountDeletionSchema,
} from '../schemas/privacy.schema';
import {
  cancelDeletionRequest,
  exportAccountData,
  privacyRequestStatus,
  requestAccountDeletion,
} from '../controllers/privacy.controller';
import {
  createSupportTicket,
  getPreferences,
  listConsentHistory,
  listSupportTickets,
  updatePreferences,
} from '../controllers/account.controller';
import {
  createSupportTicketSchema,
  updatePreferencesSchema,
} from '../schemas/account.schema';

const router = Router();

router.post('/login', authRateLimit, validateBody(loginSchema), login);
router.post('/register', authRateLimit, validateBody(registerSchema), register);
router.post('/logout', authMiddleware, logout);
router.get('/me', authMiddleware, getMe);
router.get('/sessions', authMiddleware, listSessions);
router.delete('/sessions/:sessionId', authMiddleware, revokeSession);
router.post('/sessions/revoke-others', authMiddleware, revokeOtherSessions);
router.get('/privacy/requests', authMiddleware, privacyRequestStatus);
router.post(
  '/privacy/export',
  authMiddleware,
  sensitiveActionRateLimit,
  validateBody(exportAccountDataSchema),
  exportAccountData,
);
router.post(
  '/privacy/deletion',
  authMiddleware,
  sensitiveActionRateLimit,
  validateBody(requestAccountDeletionSchema),
  requestAccountDeletion,
);
router.post(
  '/privacy/deletion/cancel',
  authMiddleware,
  sensitiveActionRateLimit,
  validateBody(cancelAccountDeletionSchema),
  cancelDeletionRequest,
);
router.put('/profile', authMiddleware, editProfile);
router.patch('/profile', authMiddleware, editProfile);
// change-password requires the current password, so a stolen 7-day token alone
// must not be enough to brute-force it. Same limiter as the other sensitive
// account actions (privacy export / deletion).
router.post(
  '/change-password',
  authMiddleware,
  sensitiveActionRateLimit,
  validateBody(changePasswordSchema),
  changePassword,
);

// Account preferences (consent + notification settings)
router.get('/preferences', authMiddleware, getPreferences);
router.put(
  '/preferences',
  authMiddleware,
  validateBody(updatePreferencesSchema),
  updatePreferences,
);
router.get('/consent/history', authMiddleware, listConsentHistory);

// Support tickets
router.post(
  '/support/tickets',
  authMiddleware,
  authRateLimit,
  validateBody(createSupportTicketSchema),
  createSupportTicket,
);
router.get('/support/tickets', authMiddleware, listSupportTickets);

// Forgot Password Flow
router.post('/forgot-password', otpRateLimit, validateBody(forgotPasswordRequestSchema), requestForgotPasswordOTP);
router.post('/verify-otp', otpRateLimit, validateBody(verifyOtpSchema), verifyForgotPasswordOTP);
// reset-password consumes an OTP-family token and is unauthenticated, so the
// token itself is the only credential. Matches the stricter otpRateLimit already
// applied to /verify-otp rather than the 10-attempt sensitive-action budget.
router.post(
  '/reset-password',
  otpRateLimit,
  validateBody(resetPasswordSchema),
  resetPassword,
);

export default router;
