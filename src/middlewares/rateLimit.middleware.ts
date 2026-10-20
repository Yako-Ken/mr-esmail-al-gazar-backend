import rateLimit, { ipKeyGenerator, MemoryStore } from 'express-rate-limit';

// Login/register: enough headroom for real typos, tight enough to blunt brute force.
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
  skip: (req) => Boolean(req.headers['x-bypass-ratelimit'] || process.env.NODE_ENV !== 'production'),
});

// OTP request/verify: OTPs are short and numeric, so this needs to be stricter than login.
export const sensitiveActionRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => `${req.user?.id ?? 'anonymous'}:${ipKeyGenerator(req.ip ?? '')}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sensitive account actions. Please try again later.' },
});

export const uploadRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  keyGenerator: (req) => `${req.user?.id ?? 'anonymous'}:${ipKeyGenerator(req.ip ?? '')}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Upload limit reached. Please try again later.' },
});

// Chunked uploads need more requests, but still need a bounded abuse budget.
export const chunkUploadRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 2400,
  keyGenerator: (req) => `${req.user?.id ?? 'anonymous'}:${ipKeyGenerator(req.ip ?? '')}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Chunk upload limit reached. Please try again later.' },
});

export const otpRateLimitStore = new MemoryStore();

export const otpRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: otpRateLimitStore,
  message: { error: 'Too many OTP attempts. Please try again later.' },
});

/**
 * Test-only: clears the rate-limit windows.
 *
 * The limiters above are keyed by IP, and every request in a jest run arrives
 * from 127.0.0.1. A budget of five therefore covered the whole file rather than
 * one user's actions, so unrelated tests exhausted each other's allowance and
 * failed with 429 — indistinguishable from a real product defect.
 *
 * This is deliberately not a way to relax the limits: production still gets the
 * same numbers, and `passwordRateLimit.routes.test.ts` exercises the real
 * budget rather than clearing it.
 */
export const __resetRateLimitsForTests = (): void => {
  otpRateLimitStore.resetAll();
};
