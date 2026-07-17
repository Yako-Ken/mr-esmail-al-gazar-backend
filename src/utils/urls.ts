// Consolidates the formatUrl/fmt helper that was duplicated (with slightly
// different edge-case handling) across course/lesson/store/enrollment/student
// controllers. Files stored under uploads/ are saved as a path relative to the
// uploads dir; this turns that into an absolute URL the client can load.
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
