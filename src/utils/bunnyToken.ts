import crypto from 'crypto';

const base64Url = (buffer: Buffer): string => buffer
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=/g, '');

export const signBunnyCdnUrl = (
  rawUrl: string,
  securityKey: string,
  lifetimeSeconds = 90,
  now = Date.now(),
): { url: string; expiresAt: Date } => {
  const source = new URL(rawUrl);
  if (source.protocol !== 'https:') throw new Error('Bunny playback URL must use HTTPS.');
  const expires = Math.floor(now / 1000) + lifetimeSeconds;
  const hashable = `${securityKey}${source.pathname}${expires}`;
  const token = base64Url(crypto.createHash('sha256').update(hashable).digest());
  source.searchParams.set('token', token);
  source.searchParams.set('expires', String(expires));
  return { url: source.toString(), expiresAt: new Date(expires * 1000) };
};

export const isAllowedBunnyUrl = (rawUrl: string, configuredCdnUrl: string): boolean => {
  try {
    const source = new URL(rawUrl);
    const configured = new URL(configuredCdnUrl);
    return source.protocol === 'https:' && source.host === configured.host;
  } catch {
    return false;
  }
};
