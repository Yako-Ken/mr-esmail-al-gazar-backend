import { createAttendanceQrToken, verifyAttendanceQrToken } from './attendanceQr';

const secret = 'a-long-attendance-test-secret';

describe('signed attendance QR tokens', () => {
  it('contains a short-lived student-bound one-time id', () => {
    const created = createAttendanceQrToken('student-1', secret);
    const payload = verifyAttendanceQrToken(created.token, secret);
    expect(payload.sub).toBe('student-1');
    expect(payload.jti).toBe(created.jti);
    expect(payload.type).toBe('attendance');
    expect(payload.exp * 1000).toBeGreaterThan(Date.now());
    expect(created.expiresIn).toBe(30);
  });

  it('rejects a token signed with another secret', () => {
    const created = createAttendanceQrToken('student-1', secret);
    expect(() => verifyAttendanceQrToken(created.token, 'another-long-secret')).toThrow();
  });

  it('rejects tampering', () => {
    const created = createAttendanceQrToken('student-1', secret);
    const tampered = `${created.token.slice(0, -1)}x`;
    expect(() => verifyAttendanceQrToken(tampered, secret)).toThrow();
  });
});
