import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const issuer = 'esmail-elgazar-lms';
const audience = 'attendance-scanner';
const lifetimeSeconds = 30;

export interface AttendanceQrPayload {
  sub: string;
  jti: string;
  type: 'attendance';
  exp: number;
}

export const createAttendanceQrToken = (studentId: string, secret: string) => {
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { type: 'attendance' },
    secret,
    {
      algorithm: 'HS256',
      subject: studentId,
      jwtid: jti,
      issuer,
      audience,
      expiresIn: lifetimeSeconds,
    },
  );

  return {
    token,
    jti,
    expiresAt: new Date(Date.now() + lifetimeSeconds * 1000),
    expiresIn: lifetimeSeconds,
  };
};

export const verifyAttendanceQrToken = (
  token: string,
  secret: string,
): AttendanceQrPayload => {
  const payload = jwt.verify(token, secret, {
    algorithms: ['HS256'],
    issuer,
    audience,
  });

  if (typeof payload === 'string' ||
      typeof payload.sub !== 'string' ||
      typeof payload.jti !== 'string' ||
      payload.type !== 'attendance' ||
      typeof payload.exp !== 'number') {
    throw new jwt.JsonWebTokenError('Invalid attendance QR payload');
  }

  return payload as unknown as AttendanceQrPayload;
};
