import { maskEmail, maskName, maskPhone, redactUser } from './redact';

/**
 * Rule L-4: no phone, email, personal name, JWT or password hash may appear in
 * any log at any level. These helpers are the control, so they are tested.
 */
describe('redact', () => {
  describe('maskPhone', () => {
    it('keeps only the last two digits of an Egyptian mobile number', () => {
      expect(maskPhone('01094270799')).toBe('***99');
      expect(maskPhone('01111111111')).toBe('***11');
    });

    it('never emits the full number', () => {
      const masked = maskPhone('01094270799');
      expect(masked).not.toContain('01094270799');
      // Exactly two digits survive; everything else is a mask character.
      expect(masked).toMatch(/^\*+\d{2}$/);
      expect(masked.replace(/\*/g, '')).toHaveLength(2);
    });

    it('handles absent values without throwing', () => {
      expect(maskPhone(null)).toBe('none');
      expect(maskPhone(undefined)).toBe('none');
      expect(maskPhone('')).toBe('none');
    });

    it('is stable, so two logs of the same number remain comparable', () => {
      expect(maskPhone('01094270799')).toBe(maskPhone('01094270799'));
    });

    it('does not over-mask a very short value', () => {
      expect(maskPhone('12')).toBe('***');
    });
  });

  describe('maskEmail', () => {
    it('keeps the first local character and the TLD only', () => {
      expect(maskEmail('teacher@example.com')).toBe('t***@***.com');
    });

    it('never emits the domain or the local part', () => {
      const masked = maskEmail('teacher@example.com');
      expect(masked).not.toContain('example');
      expect(masked).not.toContain('teacher@');
    });

    it('handles a malformed value', () => {
      expect(maskEmail('not-an-email')).toBe('***');
      expect(maskEmail(null)).toBe('none');
    });
  });

  describe('maskName', () => {
    it('keeps the first character only', () => {
      expect(maskName('Ahmed Hassan')).toBe('A***');
    });

    it('never emits the full name', () => {
      expect(maskName('Ahmed Hassan')).not.toContain('Hassan');
    });

    it('handles absent values', () => {
      expect(maskName(null)).toBe('none');
      expect(maskName(undefined)).toBe('none');
    });
  });

  describe('redactUser', () => {
    it('allows only the non-identifying fields through', () => {
      const out = redactUser({
        id: 'u-1',
        role: 'TEACHER',
        status: 'approved',
        isApproved: true,
        isVerified: true,
        phone: '01094270799',
        email: 'teacher@example.com',
        name: 'Ahmed Hassan',
        password: '$2b$12$SUPERSECRETHASH',
        sessionVersion: 3,
      });

      expect(out).toEqual({
        id: 'u-1',
        role: 'TEACHER',
        status: 'approved',
        isApproved: true,
        isVerified: true,
        phone: '***99',
        email: 't***@***.com',
        name: 'A***',
      });
    });

    it('drops any field it does not recognise, including a password hash', () => {
      const out = redactUser({ id: 'u-1', password: 'HASH', anythingNew: 'LEAK' });
      expect(out).not.toHaveProperty('password');
      expect(out).not.toHaveProperty('anythingNew');
      expect(Object.keys(out).sort()).toEqual(['email', 'id', 'isApproved', 'isVerified', 'name', 'phone', 'role', 'status']);
    });

    it('produces a value that is safe to pass to logger.info verbatim', () => {
      const serialised = JSON.stringify(
        redactUser({ id: 'u-1', phone: '01094270799', name: 'Ahmed', email: 'a@b.co', password: 'HASH' }),
      );
      expect(serialised).not.toContain('01094270799');
      expect(serialised).not.toContain('HASH');
      expect(serialised).not.toContain('Ahmed');
    });
  });
});
