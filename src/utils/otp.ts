import crypto from 'crypto';

const OTP_DIGITS = 6;

export const generateOtp = (): string => {
  const minimum = 10 ** (OTP_DIGITS - 1);
  const maximumExclusive = 10 ** OTP_DIGITS;
  return crypto.randomInt(minimum, maximumExclusive).toString();
};

export const hashOtp = (userId: string, otp: string, secret: string): string =>
  crypto.createHmac('sha256', secret).update(`${userId}:${otp}`).digest('hex');

export const hashResetToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

export const secureDigestEqual = (actual: string, expected: string): boolean => {
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
};
