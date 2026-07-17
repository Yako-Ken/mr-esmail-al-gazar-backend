import rateLimit from 'express-rate-limit';

// Login/register: enough headroom for real typos, tight enough to blunt brute force.
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

// OTP request/verify: OTPs are short and numeric, so this needs to be stricter than login.
export const otpRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OTP attempts. Please try again later.' },
});
