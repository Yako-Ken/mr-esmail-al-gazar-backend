import app from '../src/app';

export default async function handler(req: any, res: any) {
  try {
    return app(req, res);
  } catch (err: any) {
    console.error('SERVERLESS HANDLER ERROR:', err);
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'Serverless Handler Error',
        message: err?.message || String(err),
        stack: err?.stack,
      });
    }
  }
}
