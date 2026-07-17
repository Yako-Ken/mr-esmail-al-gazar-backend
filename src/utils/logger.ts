const isProd = process.env.NODE_ENV === 'production';

const ts = () => new Date().toISOString();

export const logger = {
  info: (...args: unknown[]) => console.log(`[INFO] ${ts()}`, ...args),
  warn: (...args: unknown[]) => console.warn(`[WARN] ${ts()}`, ...args),
  error: (...args: unknown[]) => console.error(`[ERROR] ${ts()}`, ...args),
  // debug is suppressed outside development so token/user debug traces never reach production logs
  debug: (...args: unknown[]) => {
    if (!isProd) console.log(`[DEBUG] ${ts()}`, ...args);
  },
};
