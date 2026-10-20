let appInstance: any = null;
let initError: any = null;

async function getApp() {
  if (appInstance) return appInstance;
  if (initError) throw initError;
  try {
    const mod = await import('../src/app');
    appInstance = mod.default || mod;
    return appInstance;
  } catch (err: any) {
    initError = err;
    throw err;
  }
}

export default async function handler(req: any, res: any) {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (err: any) {
    console.error('SERVERLESS HANDLER BOOT ERROR:', err);
    if (!res.headersSent) {
      return res.status(500).json({
        status: 'error',
        error: 'Serverless Boot Error',
        message: err?.message || String(err),
        details: err?.details || undefined,
        stack: process.env.NODE_ENV === 'production' ? undefined : err?.stack,
      });
    }
  }
}
