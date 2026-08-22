import crypto from 'crypto';

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const generateParentLinkCode = (length = 8): string => {
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return code;
};

export const hashParentLinkCode = (
  studentId: string,
  code: string,
  secret: string,
): string => crypto
  .createHmac('sha256', secret)
  .update(`${studentId}:${code.trim().toUpperCase()}`)
  .digest('hex');
