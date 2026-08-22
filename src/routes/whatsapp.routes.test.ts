import request from 'supertest';
import app from '../app';

/**
 * Security regression test for the WhatsApp OTP placeholder routes.
 *
 * These routes previously implemented a *mock* verification that accepted ANY
 * 4-digit code (`/^\d{4}$/`) and returned success — an auth bypass backdoor if
 * ever exposed in production. They are now hard-gated behind
 * `WHATSAPP_OTP_ENABLED=true` (which is NOT set in the test env).
 *
 * These tests assert the gate actually holds:
 *   - every WhatsApp OTP endpoint returns 501 Not Implemented
 *   - an auth bypass attempt (any-4-digits) is refused
 *   - the parent verification-status endpoint no longer returns a blanket `verified:true`
 *
 * If you intentionally implement a real WhatsApp/SMS OTP provider, flip the env
 * var AND update these tests to assert against the real verification logic.
 */
describe('WhatsApp OTP placeholder — security gate', () => {
  const endpoints: Array<[string, string, object]> = [
    ['post', '/api/auth/student/request-otp', { phone: '01000000000' }],
    ['post', '/api/auth/student/verify-otp', { phone: '01000000000', code: '1234' }],
    ['post', '/api/auth/parent/request-otp', { phone: '01000000000' }],
    ['post', '/api/auth/parent/verify-otp', { phone: '01000000000', code: '9999' }],
  ];

  it.each(endpoints)(
    '%s %s responds 501 (feature disabled), NOT 200',
    async (method, url, body) => {
      const res = await (request(app) as any)[method](url).send(body);
      expect(res.status).toBe(501);
      expect(res.body.success).toBe(false);
    }
  );

  it('any-4-digit OTP does NOT verify (backdoor closed)', async () => {
    const res = await request(app)
      .post('/api/auth/student/verify-otp')
      .send({ phone: '01000000000', code: '0000' });

    // Must never reach the "تم التأكد من الكود" success branch
    expect(res.status).toBe(501);
    expect(res.body.message).toBeUndefined();
    expect(res.body.success).toBe(false);
  });

  it('parent-verification-status never returns blanket verified:true', async () => {
    const res = await request(app).get(
      '/api/auth/student/parent-verification-status'
    );
    expect(res.body.verified).not.toBe(true);
  });
});
