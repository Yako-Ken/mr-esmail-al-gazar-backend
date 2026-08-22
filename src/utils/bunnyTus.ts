import crypto from 'crypto';

export interface BunnyTusTicket {
  authorizationSignature: string;
  authorizationExpire: number;
}

/**
 * Creates Bunny Stream's short-lived TUS upload signature without exposing the
 * Stream API key to a client. Bunny expects SHA-256 of:
 * libraryId + apiKey + expirationUnixSeconds + videoId.
 */
export function createBunnyTusTicket(params: {
  libraryId: string;
  videoId: string;
  apiKey: string;
  expiresAt?: number;
}): BunnyTusTicket {
  const libraryId = params.libraryId.trim();
  const videoId = params.videoId.trim();
  const apiKey = params.apiKey.trim();
  if (!libraryId || !videoId || !apiKey) {
    throw new Error('Bunny TUS signing inputs are required');
  }

  const now = Math.floor(Date.now() / 1000);
  const authorizationExpire = params.expiresAt ?? now + 60 * 60;
  if (!Number.isInteger(authorizationExpire) || authorizationExpire <= now) {
    throw new Error('Bunny TUS expiration must be a future Unix timestamp');
  }

  const authorizationSignature = crypto
    .createHash('sha256')
    .update(`${libraryId}${apiKey}${authorizationExpire}${videoId}`)
    .digest('hex');

  return { authorizationSignature, authorizationExpire };
}
