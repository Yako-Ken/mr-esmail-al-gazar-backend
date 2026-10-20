// Consolidates the formatUrl/fmt helper that was duplicated (with slightly
// different edge-case handling) across course/lesson/store/enrollment/student
// controllers. Files stored under uploads/ are saved as a path relative to the
// uploads dir; this turns that into an absolute URL the client can load.
import { env } from './env';
import { isAllowedBunnyUrl, signBunnyCdnUrl } from './bunnyToken';
export const toAbsoluteUploadUrl = (
  baseUrl: string,
  url: string | null | undefined
): string | null => {
  if (!url) return null;
  if (url.startsWith('http')) return url;

  const normalized = url.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (normalized.startsWith('/uploads/')) {
    return `${baseUrl}${normalized}`;
  }
  const trimmed = normalized.replace(/^\/+/, '');
  return `${baseUrl}/uploads/${trimmed}`;
};

export const getBaseUrl = (req: { protocol: string; get: (name: string) => string | undefined }): string =>
  `${req.protocol}://${req.get('host')}`;

/** Return a URL that requires the caller's Bearer token for local private media. */
export const toProtectedMediaUrl = (
  baseUrl: string,
  url: string | null | undefined,
): string | null => {
  if (!url) return null;
  if (url.startsWith('http')) {
    if (env.BUNNY_CDN_URL && env.BUNNY_CDN_TOKEN_KEY && isAllowedBunnyUrl(url, env.BUNNY_CDN_URL)) {
      return signBunnyCdnUrl(url, env.BUNNY_CDN_TOKEN_KEY, 7200).url;
    }
    // Never return an unprotected Bunny/private CDN URL from production.
    return env.NODE_ENV === 'production' ? null : url;
  }
  const normalized = url.replace(/\\/g, '/').replace(/^\/+/, '');
  return `${baseUrl}/api/media?path=${encodeURIComponent(normalized)}`;
};
