import {
  loginSchema,
  registerSchema,
  verifyOtpSchema,
  changePasswordSchema,
  forgotPasswordRequestSchema,
} from './auth.schema';

describe('loginSchema', () => {
  it('accepts a login with identifier + password', () => {
    const result = loginSchema.safeParse({ identifier: '01000000000', password: 'secret' });
    expect(result.success).toBe(true);
  });

  it('accepts phone or email in place of identifier', () => {
    expect(loginSchema.safeParse({ phone: '01000000000', password: 'secret' }).success).toBe(true);
    expect(loginSchema.safeParse({ email: 'a@b.com', password: 'secret' }).success).toBe(true);
  });

  it('rejects when none of identifier/phone/email is present', () => {
    const result = loginSchema.safeParse({ password: 'secret' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing password', () => {
    const result = loginSchema.safeParse({ identifier: '01000000000' });
    expect(result.success).toBe(false);
  });
});

describe('registerSchema', () => {
  it('accepts a well-formed registration', () => {
    const result = registerSchema.safeParse({
      name: 'Ahmed',
      phone: '01012345678',
      email: 'ahmed@example.com',
      password: 'password123',
      role: 'STUDENT',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a name shorter than 2 characters', () => {
    expect(registerSchema.safeParse({ name: 'A', phone: '01012345678', email: 'a@example.com', password: 'password123' }).success).toBe(false);
  });

  it('rejects a password shorter than 6 characters', () => {
    expect(registerSchema.safeParse({ name: 'Ahmed', phone: '01012345678', email: 'ahmed@example.com', password: '123' }).success).toBe(false);
  });

  it.each(['TEACHER', 'ADMIN', 'ASSISTANT', 'SUPER_ADMIN', 'SUPERHERO'])(
    'rejects internal role %s on public registration',
    (role) => {
      const result = registerSchema.safeParse({
        name: 'Ahmed',
        phone: '01012345678',
        email: 'ahmed@example.com',
        password: 'password123',
        role,
      });
      expect(result.success).toBe(false);
    },
  );

  it('defaults a public registration to STUDENT', () => {
    const result = registerSchema.parse({
      name: 'Ahmed',
      phone: '01012345678',
      email: 'ahmed@example.com',
      password: 'password123',
    });
    expect(result.role).toBe('STUDENT');
  });
});

describe('forgotPasswordRequestSchema', () => {
  it('accepts one identifier and strips caller-supplied recovery contacts', () => {
    const result = forgotPasswordRequestSchema.parse({
      identifier: '01012345678',
      parentPhone: '01099999999',
      email: 'attacker@example.com',
    });
    expect(result).toEqual({ identifier: '01012345678' });
  });

  it('keeps studentPhone as a temporary compatibility alias', () => {
    expect(forgotPasswordRequestSchema.safeParse({ studentPhone: '01012345678' }).success).toBe(true);
  });
});

describe('verifyOtpSchema', () => {
  it('requires exactly 6 digits for the OTP', () => {
    expect(verifyOtpSchema.safeParse({ studentPhone: '01012345678', otp: '123456' }).success).toBe(true);
    expect(verifyOtpSchema.safeParse({ studentPhone: '01012345678', otp: '12345' }).success).toBe(false);
    expect(verifyOtpSchema.safeParse({ studentPhone: '01012345678', otp: '1234567' }).success).toBe(false);
  });
});

describe('changePasswordSchema', () => {
  it('rejects a new password shorter than 6 characters', () => {
    const result = changePasswordSchema.safeParse({ oldPassword: 'old', newPassword: '123' });
    expect(result.success).toBe(false);
  });

  it('accepts a valid change-password payload', () => {
    const result = changePasswordSchema.safeParse({ oldPassword: 'old-pass', newPassword: 'new-pass' });
    expect(result.success).toBe(true);
  });
});
