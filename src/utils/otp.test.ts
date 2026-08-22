import { generateOtp, hashOtp, hashResetToken, secureDigestEqual } from './otp';

describe('OTP security helpers', () => {
  it('generates exactly six numeric digits', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(generateOtp()).toMatch(/^\d{6}$/);
    }
  });

  it('binds an OTP digest to the user and secret', () => {
    const digest = hashOtp('user-a', '123456', 'a-strong-test-secret');
    expect(digest).not.toContain('123456');
    expect(secureDigestEqual(digest, hashOtp('user-a', '123456', 'a-strong-test-secret'))).toBe(true);
    expect(secureDigestEqual(digest, hashOtp('user-b', '123456', 'a-strong-test-secret'))).toBe(false);
  });

  it('stores only a one-way reset-token digest', () => {
    const token = 'a'.repeat(64);
    const digest = hashResetToken(token);
    expect(digest).toHaveLength(64);
    expect(digest).not.toBe(token);
  });
});
