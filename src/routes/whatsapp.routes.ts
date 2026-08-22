import { Router, RequestHandler } from 'express';
import { logger } from '../utils/logger';
import { otpRateLimit } from '../middlewares/rateLimit.middleware';

const router = Router();

// =============================================================================
// WhatsApp/SMS parent-verification — PLACEHOLDER, disabled by default.
//
// SECURITY HISTORY (do not re-enable without reading this):
//   These routes previously returned success for ANY 4-digit code
//   (`if (code.length === 4 && /^\d+$/.test(code))`), which is an auth-bypass
//   backdoor. Shipping that to production means anyone can register a student
//   account against any phone number with no verification at all.
//
//   The routes are now hard-gated behind the WHATSAPP_OTP_ENABLED env flag.
//   Until a real SMS/WhatsApp provider (Twilio Verify, Vodafone Egypt, etc.)
//   is integrated — meaning a code is generated server-side, sent to the
//   device, stored, rate-limited, and validated — keep this flag unset.
//
// A regression test lives in src/routes/whatsapp.routes.test.ts and fails CI
// if any of these endpoints ever returns 200 again while the flag is off.
// =============================================================================

const isEnabled = (): boolean => process.env.WHATSAPP_OTP_ENABLED === 'true';

const featureDisabled: RequestHandler = (_req, res): void => {
  res.status(501).json({
    success: false,
    error: 'WhatsApp verification is not available yet.',
    code: 'FEATURE_DISABLED',
  });
};

const otpHandler: RequestHandler = (req, res, next): void => {
  if (!isEnabled()) {
    // Log once per attempt so abuse of the disabled feature is visible in logs
    logger.warn(`⚠️ Disabled WhatsApp OTP endpoint hit: ${req.method} ${req.path}`);
    featureDisabled(req, res, next);
    return;
  }
  // When a real provider is wired, replace the routes below with the actual
  // request/verify handlers and remove the featureDisabled gates.
  next();
};

router.post('/student/request-otp', otpRateLimit, otpHandler, featureDisabled);
router.post('/student/verify-otp', otpRateLimit, otpHandler, featureDisabled);
router.post('/parent/request-otp', otpRateLimit, otpHandler, featureDisabled);
router.post('/parent/verify-otp', otpRateLimit, otpHandler, featureDisabled);

// GET /api/auth/student/parent-verification-status
// Previously returned a blanket `{ verified: true }` — also a backdoor.
router.get('/student/parent-verification-status', (req, res) => {
  if (!isEnabled()) {
    return res.status(200).json({
      verified: false,
      pending: true,
      message: 'Phone verification provider is not configured.',
    });
  }
  // Real implementation: look up the parent's verification status in the DB.
  return res.status(200).json({ verified: false, pending: true });
});

export default router;
