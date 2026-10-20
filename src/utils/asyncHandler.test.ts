import express from 'express';
import request from 'supertest';
import { asyncHandler } from './asyncHandler';

/**
 * The crash class these tests exist for: on Express 4 an `async` route handler
 * that rejects does NOT reach the error-handling middleware. It becomes an
 * unhandled rejection, which terminates the Node process. Before asyncHandler,
 * a transient SQLITE_BUSY on any unguarded route killed the whole server.
 */
describe('asyncHandler', () => {
  const buildApp = (handler: express.RequestHandler) => {
    const app = express();
    app.get('/boom-async', handler);
    app.get('/boom-sync', handler);
    app.get('/ok', handler);
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: 'Internal server error' });
    });
    return app;
  };

  it('forwards a rejected promise to the Express error handler instead of crashing', async () => {
    const app = buildApp(
      asyncHandler(async () => {
        throw new Error('simulated SQLITE_BUSY');
      }),
    );

    const res = await request(app).get('/boom-async');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
  });

  it('forwards a synchronously thrown error to the Express error handler', async () => {
    const app = buildApp(
      asyncHandler(() => {
        throw new Error('thrown before the first await');
      }),
    );

    const res = await request(app).get('/boom-sync');
    expect(res.status).toBe(500);
  });

  it('leaves a successful handler completely unchanged', async () => {
    const app = buildApp(
      asyncHandler(async (_req, res) => {
        res.json({ ok: true, value: 42 });
      }),
    );

    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, value: 42 });
  });

  it('preserves a handler that returns res.status(...).json(...)', async () => {
    const app = buildApp(
      asyncHandler(async (_req, res) => {
        res.status(404).json({ error: 'nope' });
      }),
    );

    const res = await request(app).get('/boom-async');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('nope');
  });

  it('returns a value compatible with Express RequestHandler typing', () => {
    // Compile-time guarantee: the wrapper must be assignable to RequestHandler.
    const handler: express.RequestHandler = asyncHandler(async (_req, res) => {
      res.end();
    });
    expect(typeof handler).toBe('function');
  });
});
